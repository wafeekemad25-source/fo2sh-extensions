// Requests made by the extension itself look like they come from Instagram's page.
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "referer", operation: "set", value: "https://www.instagram.com/" },
        { header: "origin", operation: "set", value: "https://www.instagram.com" }
      ]
    },
    condition: { requestDomains: ["cdninstagram.com", "fbcdn.net"], tabIds: [-1] }
  }]
}).catch(() => {});

// ---------- Helpers ----------
let lastStatus = "";

async function check(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    return r.ok || r.status === 206 ? true : String(r.status);
  } catch (e) {
    return "net";
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function firstWorking(candidates) {
  const list = [...new Set((candidates || []).filter(Boolean))].slice(0, 30);
  if (!list.length) return null;
  lastStatus = "";
  let res = await Promise.all(list.map((u) => check(u, { method: "HEAD" })));
  let i = res.indexOf(true);
  if (i >= 0) return list[i];
  res = await Promise.all(list.map((u) => check(u, { headers: { Range: "bytes=0-1" } })));
  i = res.indexOf(true);
  if (i >= 0) return list[i];
  lastStatus = [...new Set(res)].join("/");
  return null;
}

// Keeps Arabic and spaces; drops only what Chrome / macOS refuse in a file name
function safeName(n) {
  const c = (n || "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>:"/\\|?*~\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return c || "instagram";
}

function extOf(url) {
  const m = url.split("?")[0].match(/\.(mp4|jpe?g|png|gif|webp|heic|m4a)$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

function saveOnce(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, conflictAction: "uniquify" }, (id) => resolve(chrome.runtime.lastError || id === undefined ? null : id));
  });
}

// If Chrome refuses the readable name, save under a plain one instead of failing
async function save(url, filename) {
  if ((await saveOnce(url, filename)) != null) return { ok: true };
  const ext = (filename.match(/\.\w+$/) || [".mp4"])[0];
  if ((await saveOnce(url, `Instagram/instagram-${Date.now()}${ext}`)) != null) return { ok: true, renamed: true };
  return { ok: false, error: "save-failed" };
}

function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- Offscreen ----------
let offscreenReady = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Join video and audio, extract audio, grab frames" })
      .catch((e) => {
        if (!/single offscreen/i.test(String(e))) throw e;
      })
      .finally(() => (offscreenReady = null));
  }
  await offscreenReady;
}

async function offscreen(msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "fo2sh-ig-offscreen", ...msg });
  return res || { ok: false, error: "offscreen-no-reply" };
}

const revokeLater = (blobUrl) =>
  setTimeout(() => chrome.runtime.sendMessage({ target: "fo2sh-ig-offscreen", type: "revoke", blobUrl }).catch(() => {}), 120000);

async function toCache(key, url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("http-" + r.status);
  await (await caches.open("fo2sh-ig")).put(key, r);
}

async function dropCache(...keys) {
  const c = await caches.open("fo2sh-ig");
  for (const k of keys) await c.delete(k);
}

const newKey = (tag) => `https://fo2sh.local/${tag}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ---------- Instagram DASH manifest ----------
const unesc = (s) => (s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

// { video: [{url, height, bw}], audio: [{url, bw}] }
function parseDash(xml) {
  const out = { video: [], audio: [] };
  if (!xml) return out;
  for (const [, setAttrs, body] of xml.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
    for (const [, rep, repBody] of body.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi)) {
      const base = (repBody.match(/<BaseURL>([^<]+)<\/BaseURL>/i) || [])[1];
      if (!base) continue;
      const url = unesc(base.trim());
      const kind = [attr(setAttrs, "contentType"), attr(setAttrs, "mimeType"), attr(rep, "mimeType"), attr(rep, "codecs")].join(" ").toLowerCase();
      const height = +attr(rep, "height") || +attr(rep, "FBQualityLabel").replace(/\D/g, "") || 0;
      const width = +attr(rep, "width") || 0;
      const isVideo = /\bvideo\b|avc|hvc|hev|vp0?9|av01/.test(kind) || height > 0;
      if (!isVideo && /audio|mp4a\./.test(kind)) out.audio.push({ url, bw: +attr(rep, "bandwidth") || 0 });
      else if (isVideo) {
        // H.264 / HEVC play in QuickTime and Premiere; VP9 / AV1 often do not
        const ok = /avc1|avc3|hvc1|hev1/.test(kind) || !/vp0?9|av01/.test(kind);
        out.video.push({ url, height, width, bw: +attr(rep, "bandwidth") || 0, ok, codec: /vp0?9/.test(kind) ? "VP9" : /av01/.test(kind) ? "AV1" : /hvc1|hev1/.test(kind) ? "HEVC" : "H.264" });
      }
    }
  }
  out.video.sort((a, b) => size(b.width, b.height) - size(a.width, a.height) || b.bw - a.bw);
  out.audio.sort((a, b) => b.bw - a.bw);
  return out;
}

// Picture size for comparing, and the usual "1080p" label (the short side, so portrait reels read right)
const size = (w, h) => (w && h ? w * h : (h || 0) * (h || 0));
const label = (w, h) => (w && h ? Math.min(w, h) : h || 0);

// Chooses where the best picture is: a ready MP4 (versions) or the DASH streams.
// All link checks run at the same time, and the answer is remembered per video.
const picks = new Map();
function pickSources(msg) {
  const key = JSON.stringify([(msg.versions || []).map((v) => v.url).sort(), (msg.dash || "").length, (msg.dash || "").slice(0, 400)]);
  if (!picks.has(key)) {
    picks.set(key, findSources(msg).catch((e) => { picks.delete(key); throw e; }));
    if (picks.size > 12) picks.delete(picks.keys().next().value);
  }
  return picks.get(key);
}

async function findSources(msg) {
  const versions = (msg.versions || []).slice().sort((a, b) => size(b.w, b.h) - size(a.w, a.h));
  const dash = parseDash(msg.dash);
  // Only streams that open on a Mac; VP9/AV1 are used only when nothing else exists
  const playable = dash.video.filter((v) => v.ok);
  const dashList = playable.length || versions.length ? playable : dash.video;
  const [mp4, dashVideo, dashAudio] = await Promise.all([
    firstWorking(versions.map((v) => v.url)),
    dashList.length ? firstWorking(dashList.map((v) => v.url)) : null,
    dash.audio.length ? firstWorking(dash.audio.map((a) => a.url)) : null
  ]);
  const mv = (mp4 && versions.find((v) => v.url === mp4)) || {};
  const dv = (dashVideo && dash.video.find((v) => v.url === dashVideo)) || {};
  // mp4H / dashH: comparable picture sizes; *Q: labels shown to the user
  const mp4H = size(mv.w, mv.h), dashH = size(dv.width, dv.height);
  const mp4Q = label(mv.w, mv.h), dashQ = label(dv.width, dv.height);
  return { mp4, mp4H, mp4Q, dashVideo, dashH, dashQ, dashAudio, codec: dv.codec, useDash: !!dashVideo && (dashH > mp4H || !mp4) };
}

// Downloaded files kept for a while (last few videos), so the next click on the same video is instant
const stored = new Map(); // url -> Promise<cacheKey>
function cached(url) {
  if (stored.has(url)) {
    const p = stored.get(url);
    stored.delete(url);
    stored.set(url, p); // most recent last
    return p;
  }
  const key = "https://fo2sh.local/u/" + encodeURIComponent(url);
  const p = toCache(key, url).then(() => key);
  p.catch(() => stored.delete(url));
  stored.set(url, p);
  while (stored.size > 6) {
    const [oldUrl, oldP] = stored.entries().next().value;
    stored.delete(oldUrl);
    oldP.then((k) => dropCache(k)).catch(() => {});
  }
  return p;
}

// Called when the mouse is on a video or on the buttons: do the slow parts before the click
async function warm(msg) {
  ensureOffscreen().then(() => chrome.runtime.sendMessage({ target: "fo2sh-ig-offscreen", type: "warm" })).catch(() => {});
  if (!msg.versions && !msg.dash) return { ok: true };
  const s = await pickSources(msg);
  if (s.useDash && s.dashAudio) await Promise.all([cached(s.dashVideo), cached(s.dashAudio)]);
  return { ok: true };
}

// ---------- Actions ----------
async function downloadVideo(msg) {
  const s = await pickSources(msg);
  const file = `Instagram/${safeName(msg.name)}.mp4`;
  if (!s.useDash) {
    if (s.mp4) return { ...(await save(s.mp4, file)), h: s.mp4Q };
    if (!s.dashVideo) return { ok: false, error: `http:${lastStatus || "none"}` };
  }
  if (!s.dashAudio) return { ...(await save(s.dashVideo, file)), h: s.dashQ, silent: !!msg.hasAudio, note: "no-audio-stream" };
  const [vKey, aKey] = await Promise.all([cached(s.dashVideo), cached(s.dashAudio)]);
  const res = await offscreen({ type: "mux", vKey, aKey });
  if (!res.ok) {
    // Joining failed: give the ready MP4 if there is one, else the silent best picture
    if (s.mp4) return { ...(await save(s.mp4, file)), h: s.mp4Q, note: res.error };
    return { ...(await save(s.dashVideo, file)), h: s.dashQ, silent: true, note: res.error };
  }
  revokeLater(res.blobUrl);
  return { ...(await save(res.blobUrl, file)), h: s.dashQ, codec: s.codec };
}

async function downloadAudio(msg) {
  const s = await pickSources(msg);
  const file = `Instagram/${safeName(msg.name)} - audio.m4a`;
  if (s.dashAudio) return save(s.dashAudio, file);
  if (!s.mp4) return { ok: false, error: `http:${lastStatus || "none"}` };
  const res = await offscreen({ type: "audio", key: await cached(s.mp4) });
  if (!res.ok) return { ok: false, error: /matches no/.test(res.error) ? "no-audio" : res.error };
  revokeLater(res.blobUrl);
  return save(res.blobUrl, file);
}

async function grabFrame(msg) {
  const s = await pickSources(msg);
  const src = s.useDash ? s.dashVideo : s.mp4 || s.dashVideo;
  if (!src) return { ok: false, error: "no-video" };
  const res = await offscreen({ type: "frame", key: await cached(src), time: msg.time });
  if (!res.ok) return res;
  revokeLater(res.blobUrl);
  return { ...(await save(res.blobUrl, `Instagram/${safeName(msg.name)}.png`)), w: res.w, h: res.h };
}

async function screenshotArea(msg, sender) {
  const shot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const d = msg.dpr || 1;
  const sx = Math.max(0, Math.round(msg.rect.x * d)), sy = Math.max(0, Math.round(msg.rect.y * d));
  const w = Math.min(bmp.width - sx, Math.round(msg.rect.w * d)), h = Math.min(bmp.height - sy, Math.round(msg.rect.h * d));
  if (w <= 0 || h <= 0) return { ok: false, error: "off-screen" };
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").drawImage(bmp, sx, sy, w, h, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: "image/png" });
  const out = await save("data:image/png;base64," + toB64(new Uint8Array(await blob.arrayBuffer())), `Instagram/${safeName(msg.name)}.png`);
  return { ...out, w, h };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "fo2sh-ig-offscreen") return false;
  const jobs = {
    "ig-image": async () => {
      const url = await firstWorking(msg.candidates);
      if (!url) return { ok: false, error: `http:${lastStatus || "none"}` };
      return save(url, `Instagram/${safeName(msg.name)}.${extOf(url)}`);
    },
    "ig-video": () => downloadVideo(msg),
    "ig-audio": () => downloadAudio(msg),
    "ig-frame": () => grabFrame(msg),
    "ig-shot": () => screenshotArea(msg, sender),
    "ig-save-data": () => save(msg.dataUrl, `Instagram/${safeName(msg.name)}.png`),
    "ig-warm": () => warm(msg)
  };
  const job = jobs[msg.type];
  if (!job) return false;
  job().then(sendResponse, (e) => sendResponse({ ok: false, error: "bg-" + String(e.message || e).slice(0, 60) }));
  return true;
});
