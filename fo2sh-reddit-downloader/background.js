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

// Checks all candidates at once, keeps the first one (in priority order) that works.
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

const safeName = (n) => (n || "reddit").replace(/[^\w\-]+/g, "_").slice(0, 90);

function extOf(url) {
  const m = url.split("?")[0].match(/\.(mp4|jpe?g|png|gif|webp|m4a)$/i);
  return m ? m[1].toLowerCase() : "mp4";
}

function save(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, conflictAction: "uniquify" }, (id) => {
      if (chrome.runtime.lastError || id === undefined) resolve({ ok: false, error: "save-failed" });
      else resolve({ ok: true });
    });
  });
}

// ---------- Reddit DASH ----------
function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

// Returns { video: [{url, height, bw}], audio: [{url, bw}] } from a DASHPlaylist.mpd
async function parseMpd(mpdUrl) {
  const r = await fetch(mpdUrl);
  if (!r.ok) throw new Error("mpd-" + r.status);
  const xml = await r.text();
  const out = { video: [], audio: [] };
  const sets = [...xml.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)];
  for (const [, setAttrs, body] of sets) {
    for (const [, repAttrs, repBody] of body.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi)) {
      const base = (repBody.match(/<BaseURL>([^<]+)<\/BaseURL>/i) || [])[1];
      if (!base) continue;
      const url = new URL(base.trim(), mpdUrl).href;
      const kind = [attr(setAttrs, "contentType"), attr(setAttrs, "mimeType"), attr(repAttrs, "mimeType"), attr(repAttrs, "codecs"), base].join(" ").toLowerCase();
      const bw = +attr(repAttrs, "bandwidth") || 0;
      const isVideo = /\bvideo\b|avc|hvc|hev|vp0?9|av01/.test(kind) || +attr(repAttrs, "height") > 0;
      if (!isVideo && /audio|mp4a\./.test(kind)) out.audio.push({ url, bw });
      else out.video.push({ url, height: +attr(repAttrs, "height") || 0, bw });
    }
  }
  out.video.sort((a, b) => b.height - a.height || b.bw - a.bw);
  out.audio.sort((a, b) => b.bw - a.bw);
  return out;
}

function baseOf(url) {
  const m = url && url.match(/^(https:\/\/v\.redd\.it\/[^/]+\/)/);
  return m ? m[1] : null;
}

// Finds the best video file and the best audio file for a Reddit video.
async function resolveStreams(msg) {
  let videos = [], audios = [];
  if (msg.mpd) {
    try {
      const p = await parseMpd(msg.mpd);
      videos = p.video.map((v) => v.url);
      audios = p.audio.map((a) => a.url);
    } catch (e) {}
  }
  const base = baseOf(msg.fallback) || baseOf(msg.mpd);
  if (msg.fallback) videos.push(msg.fallback.split("?")[0]);
  if (base) {
    videos.push(...["1080", "720", "480", "360", "240"].map((q) => `${base}DASH_${q}.mp4`));
    audios.push(...["DASH_AUDIO_128.mp4", "DASH_AUDIO_64.mp4", "DASH_audio.mp4", "audio"].map((a) => base + a));
  }
  const video = await firstWorking(videos);
  const audio = msg.hasAudio === false ? null : await firstWorking(audios);
  return { video, audio };
}

// ---------- Offscreen (ffmpeg) ----------
let offscreenReady = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Join Reddit video and audio into one MP4" })
      .catch((e) => {
        if (!/single offscreen/i.test(String(e))) throw e;
      })
      .finally(() => (offscreenReady = null));
  }
  await offscreenReady;
}

async function toCache(key, url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("http-" + r.status);
  const c = await caches.open("fo2sh");
  await c.put(key, r);
}

async function downloadVideo(msg) {
  const { video, audio } = await resolveStreams(msg);
  if (!video) return { ok: false, error: `video-http:${lastStatus || "none"}` };
  const file = `Reddit/${safeName(msg.name)}.mp4`;
  if (!audio) return { ...(await save(video, file)), noAudio: true };

  const id = Date.now() + "-" + Math.random().toString(36).slice(2);
  const vKey = `https://fo2sh.local/${id}/v`, aKey = `https://fo2sh.local/${id}/a`;
  try {
    await Promise.all([toCache(vKey, video), toCache(aKey, audio)]);
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: "fo2sh-offscreen", type: "mux", vKey, aKey });
    if (!res || !res.ok) {
      // Joining failed: still give the video (silent) rather than nothing
      const out = await save(video, file);
      return { ...out, muxFailed: res?.error || "no-reply" };
    }
    const out = await save(res.blobUrl, file);
    setTimeout(() => chrome.runtime.sendMessage({ target: "fo2sh-offscreen", type: "revoke", blobUrl: res.blobUrl }).catch(() => {}), 120000);
    return out;
  } finally {
    const c = await caches.open("fo2sh");
    await c.delete(vKey);
    await c.delete(aKey);
  }
}

async function downloadAudio(msg) {
  const { audio } = await resolveStreams({ ...msg, hasAudio: true });
  if (!audio) return { ok: false, error: "no-audio" };
  return save(audio, `Reddit/${safeName(msg.name)}-audio.m4a`);
}

// ---------- Messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "fo2sh-offscreen") return false;
  const job =
    msg.type === "pvd-download"
      ? (async () => {
          const url = await firstWorking(msg.candidates);
          if (!url) return { ok: false, error: `http:${lastStatus || "none"}` };
          return save(url, `Reddit/${safeName(msg.name)}.${extOf(url)}`);
        })()
      : msg.type === "rd-video"
      ? downloadVideo(msg)
      : msg.type === "rd-audio"
      ? downloadAudio(msg)
      : null;
  if (!job) return false;
  job.then(sendResponse, (e) => sendResponse({ ok: false, error: "bg-" + String(e.message || e).slice(0, 40) }));
  return true;
});
