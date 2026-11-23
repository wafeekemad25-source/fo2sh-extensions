// Requests made by the extension (no tab) look like they come from Pinterest's page,
// in case the video server refuses anything else.
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "referer", operation: "set", value: "https://www.pinterest.com/" },
        { header: "origin", operation: "set", value: "https://www.pinterest.com" }
      ]
    },
    condition: { requestDomains: ["pinimg.com"], tabIds: [-1] }
  }]
}).catch(() => {});

// Finds the first working URL and saves it. Audio: fetches the bytes here,
// the offscreen page decodes them to WAV.
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

// Checks all candidates at the same time, keeps the first one (in priority order) that works.
async function firstWorking(candidates) {
  const list = [...new Set(candidates || [])].slice(0, 40);
  if (!list.length) return null;
  lastStatus = "";
  let res = await Promise.all(list.map((u) => check(u, { method: "HEAD" })));
  let i = res.indexOf(true);
  if (i >= 0) return list[i];
  res = await Promise.all(list.map((u) => check(u, { headers: { Range: "bytes=0-1" } })));
  i = res.indexOf(true);
  if (i >= 0) return list[i];
  const codes = [...new Set(res)];
  lastStatus = codes.join("/");
  return null;
}

function safeName(n) {
  return (n || "pinterest").replace(/[^\w\-]+/g, "_").slice(0, 90);
}

function extOf(url) {
  const m = url.split("?")[0].match(/\.(mp4|jpe?g|png|gif|webp)$/i);
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

// ---------- Audio ----------
function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function getBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("http-" + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

let offscreenReady = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Decode audio, join video parts and grab frames" })
      .catch((e) => {
        if (!/single offscreen/i.test(String(e))) throw e;
      })
      .finally(() => (offscreenReady = null));
  }
  await offscreenReady;
}

async function decodeToWav(bytes, checkMp4) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "pvd-offscreen", type: "decode", b64: toB64(bytes), checkMp4 });
  return res || { ok: false, error: "offscreen-no-reply" };
}

function resolveUrl(u, base) {
  return new URL(u.trim(), base).href;
}

// Builds the audio stream from an HLS master playlist.
// Returns { bytes, ext } (ext = container of the raw audio for a no-decode fallback).
async function hlsAudio(master) {
  const text = await (await fetch(master)).text();
  let playlist = null;
  const media = text.split("\n").filter((l) => /^#EXT-X-MEDIA:.*TYPE=AUDIO/.test(l));
  for (const l of media) {
    const m = l.match(/URI="([^"]+)"/);
    if (m) { playlist = resolveUrl(m[1], master); break; }
  }
  if (!playlist) {
    // No separate audio: take the lowest-bandwidth variant (audio is muxed in)
    const lines = text.split("\n");
    let best = null, bw = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/);
      if (m && lines[i + 1] && +m[1] < bw) { bw = +m[1]; best = lines[i + 1]; }
    }
    playlist = best ? resolveUrl(best, master) : /#EXTINF/.test(text) ? master : null;
  }
  if (!playlist) throw new Error("hls-no-audio");
  const pl = playlist === master ? text : await (await fetch(playlist)).text();
  const parts = [];
  const map = pl.match(/#EXT-X-MAP:.*URI="([^"]+)"/);
  if (map) parts.push(resolveUrl(map[1], playlist));
  for (const l of pl.split("\n")) if (l.trim() && !l.startsWith("#")) parts.push(resolveUrl(l, playlist));
  if (!parts.length) throw new Error("hls-empty");
  const chunks = [];
  for (const p of parts) chunks.push(await getBytes(p));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.length; }
  const first = parts[parts.length - 1].split("?")[0];
  const ext = map || /\.(m4s|mp4|m4a|cmfa)$/i.test(first) ? "m4a" : /\.aac$/i.test(first) ? "aac" : "ts";
  return { bytes, ext };
}

async function extractAudio(msg) {
  let lastError = "no-mp4";
  // 1) The MP4 file
  const mp4 = await firstWorking((msg.candidates || []).filter((u) => /\.mp4(\?|$)/i.test(u)));
  if (mp4) {
    try {
      const res = await decodeToWav(await getBytes(mp4), true);
      if (res.ok) return { ...res, kind: "WAV" };
      lastError = res.error;
    } catch (e) {
      lastError = "mp4-" + (e.message || "fetch");
    }
  }
  // 2) The HLS stream
  for (const master of [...new Set(msg.hls || [])]) {
    try {
      const { bytes, ext } = await hlsAudio(master);
      const res = await decodeToWav(bytes, false);
      if (res.ok) return { ...res, kind: "WAV" };
      if (ext !== "ts") {
        // Could not decode: save the original audio stream as is
        return { ok: true, dataUrl: `data:audio/mp4;base64,${toB64(bytes)}`, ext, kind: ext.toUpperCase() };
      }
      lastError = "hls-" + res.error;
    } catch (e) {
      lastError = e.message || "hls-failed";
    }
  }
  return { ok: false, error: lastError };
}

// ---------- HLS (videos Pinterest only keeps in parts) ----------
function attrsOf(line) {
  const out = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("m3u8-" + r.status);
  return r.text();
}

// Reads a media playlist: optional init part + all segments (with byte ranges if any)
function parseMedia(text, base) {
  const parts = [];
  let range = null, lastEnd = 0, encrypted = false, init = null;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#EXT-X-KEY") && !/METHOD=NONE/.test(l)) encrypted = true;
    else if (l.startsWith("#EXT-X-MAP")) {
      const a = attrsOf(l.slice(11));
      let r = null;
      if (a.BYTERANGE) {
        const [len, off] = a.BYTERANGE.split("@").map(Number);
        r = [off || 0, (off || 0) + len - 1];
      }
      init = { url: new URL(a.URI, base).href, range: r };
    } else if (l.startsWith("#EXT-X-BYTERANGE")) {
      const [len, off] = l.split(":")[1].split("@").map(Number);
      const start = isNaN(off) ? lastEnd : off;
      range = [start, start + len - 1];
      lastEnd = start + len;
    } else if (!l.startsWith("#")) {
      parts.push({ url: new URL(l, base).href, range });
      range = null;
    }
  }
  return { init, parts, encrypted };
}

async function fetchPart(p) {
  const r = await fetch(p.url, p.range ? { headers: { Range: `bytes=${p.range[0]}-${p.range[1]}` } } : {});
  if (!r.ok) throw new Error("part-" + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

async function downloadParts(list, onProgress) {
  const out = new Array(list.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fetchPart(list[i]);
      done++;
      onProgress && onProgress(done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
  const total = out.reduce((a, c) => a + c.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of out) { bytes.set(c, o); o += c.length; }
  return bytes;
}

async function fetchStream(playlistUrl, text, onProgress) {
  const m = parseMedia(text || (await fetchText(playlistUrl)), playlistUrl);
  if (m.encrypted) throw new Error("hls-encrypted");
  if (!m.parts.length) throw new Error("hls-empty");
  const list = m.init ? [m.init, ...m.parts] : m.parts;
  const bytes = await downloadParts(list, onProgress);
  const kind = m.init || /\.(m4s|mp4|cmf[va])(\?|$)/i.test(m.parts[0].url) ? "mp4" : "ts";
  return { bytes, kind };
}

// Builds one MP4 (best quality + its sound) from an HLS master playlist.
// Returns a blob URL from the offscreen page; optionally keeps a copy in Cache Storage.
async function hlsToMp4File(masters, progress, storeKey) {
  let lastErr = "no-hls";
  for (const master of [...new Set(masters || [])]) {
    try {
      const text = await fetchText(master);
      let videoUrl = master, videoText = text, audioUrl = null;
      if (/#EXT-X-STREAM-INF/.test(text)) {
        const lines = text.split("\n").map((l) => l.trim());
        let best = null;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
          const a = attrsOf(lines[i].slice(18));
          let j = i + 1;
          while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
          if (!lines[j]) continue;
          const h = +((a.RESOLUTION || "").split("x")[1] || 0), bw = +(a.BANDWIDTH || 0);
          if (!best || h > best.h || (h === best.h && bw > best.bw)) best = { h, bw, uri: new URL(lines[j], master).href, audio: a.AUDIO };
        }
        if (!best) throw new Error("hls-no-variant");
        videoUrl = best.uri;
        videoText = null;
        const media = lines.filter((l) => l.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/.test(l)).map((l) => attrsOf(l.slice(13)));
        const group = media.filter((m) => m.URI && (!best.audio || m["GROUP-ID"] === best.audio));
        const pick = group.find((m) => m.DEFAULT === "YES") || group[0];
        if (pick) audioUrl = new URL(pick.URI, master).href;
      }
      const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      const cache = await caches.open("fo2sh-hls");
      const vKey = `https://fo2sh.local/hls/${stamp}/v`, aKey = `https://fo2sh.local/hls/${stamp}/a`;
      try {
        const v = await fetchStream(videoUrl, videoText, (d, t) => progress && progress(`جاري تحميل الفيديو ${Math.round((d / t) * 100)}%`));
        await cache.put(vKey, new Response(v.bytes));
        let aKind = null;
        if (audioUrl) {
          const a = await fetchStream(audioUrl, null, (d, t) => progress && progress(`جاري تحميل الصوت ${Math.round((d / t) * 100)}%`));
          await cache.put(aKey, new Response(a.bytes));
          aKind = a.kind;
        }
        progress && progress("جاري تجميع الفيديو...");
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({ target: "pvd-offscreen", type: "mux", vKey, vKind: v.kind, aKey: audioUrl ? aKey : null, aKind, storeKey });
        if (res && res.ok) return res;
        lastErr = res?.error || "mux-no-reply";
      } finally {
        await cache.delete(vKey);
        await cache.delete(aKey);
      }
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 60);
    }
  }
  throw new Error(lastErr);
}

function progressTo(tabId) {
  let last = 0;
  return (text) => {
    if (tabId == null || Date.now() - last < 250) return;
    last = Date.now();
    chrome.tabs.sendMessage(tabId, { type: "pvd-progress", text }).catch(() => {});
  };
}

// ---------- Frame grab ----------
async function grabFrame(msg, tabId) {
  const url = await firstWorking(msg.candidates);
  const cache = await caches.open("fo2sh-frames");
  if (!url) {
    if (!(msg.hls || []).length) return { ok: false, error: "no-mp4" };
    const key = "https://fo2sh.local/frame/hls/" + encodeURIComponent(msg.hls[0]);
    if (!(await cache.match(key))) {
      for (const k of await cache.keys()) await cache.delete(k);
      try {
        const built = await hlsToMp4File(msg.hls, progressTo(tabId), key);
        chrome.runtime.sendMessage({ target: "pvd-offscreen", type: "revoke", blobUrl: built.blobUrl }).catch(() => {});
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    return frameFromKey(key, msg);
  }
  const key = "https://fo2sh.local/frame/" + encodeURIComponent(url);
  if (!(await cache.match(key))) {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: "http-" + r.status };
    // Keep only the latest video, so repeated grabs are instant
    for (const k of await cache.keys()) await cache.delete(k);
    await cache.put(key, r);
  }
  return frameFromKey(key, msg);
}

async function frameFromKey(key, msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "pvd-offscreen", type: "frame", key, time: msg.time });
  if (!res || !res.ok) return { ok: false, error: res?.error || "offscreen-no-reply" };
  const out = await save(res.blobUrl, `Pinterest/${safeName(msg.name)}.png`);
  setTimeout(() => chrome.runtime.sendMessage({ target: "pvd-offscreen", type: "revoke", blobUrl: res.blobUrl }).catch(() => {}), 60000);
  return { ...out, w: res.w, h: res.h };
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
  const dataUrl = "data:image/png;base64," + toB64(new Uint8Array(await blob.arrayBuffer()));
  const out = await save(dataUrl, `Pinterest/${safeName(msg.name)}.png`);
  return { ...out, w, h };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "pvd-frame" || msg.type === "pvd-shot" || msg.type === "pvd-save-data") {
    const job =
      msg.type === "pvd-frame"
        ? grabFrame(msg, sender.tab && sender.tab.id)
        : msg.type === "pvd-shot"
        ? screenshotArea(msg, sender)
        : save(msg.dataUrl, `Pinterest/${safeName(msg.name)}.${msg.ext || "png"}`);
    job.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e).slice(0, 60) }));
    return true;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "pvd-offscreen") return false;
  if (msg.type === "pvd-download") {
    (async () => {
      const url = await firstWorking(msg.candidates);
      if (url) return sendResponse(await save(url, `Pinterest/${safeName(msg.name)}.${extOf(url)}`));
      const status = lastStatus || "none";
      if (!(msg.hls || []).length) return sendResponse({ ok: false, error: `http:${status}` });
      try {
        const built = await hlsToMp4File(msg.hls, progressTo(sender.tab && sender.tab.id));
        const out = await save(built.blobUrl, `Pinterest/${safeName(msg.name)}.mp4`);
        setTimeout(() => chrome.runtime.sendMessage({ target: "pvd-offscreen", type: "revoke", blobUrl: built.blobUrl }).catch(() => {}), 120000);
        sendResponse({ ...out, viaHls: true });
      } catch (e) {
        sendResponse({ ok: false, error: `http:${status} ${String(e.message || e)}` });
      }
    })();
    return true;
  }
  if (msg.type === "pvd-audio") {
    (async () => {
      try {
        const res = await extractAudio(msg);
        if (!res.ok) return sendResponse(res);
        const name = `Pinterest/${safeName(msg.name)}-audio.${res.dataUrl ? res.ext : "wav"}`;
        const out = await save(res.dataUrl || res.blobUrl, name);
        if (res.blobUrl) setTimeout(() => chrome.runtime.sendMessage({ target: "pvd-offscreen", type: "revoke", blobUrl: res.blobUrl }).catch(() => {}), 60000);
        sendResponse({ ...out, kind: res.kind });
      } catch (e) {
        sendResponse({ ok: false, error: "bg-" + (e.message || "error").slice(0, 40) });
      }
    })();
    return true;
  }
});
