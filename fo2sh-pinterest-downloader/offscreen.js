import { FFmpeg } from "./lib/ffmpeg/index.js";

// ---------- Joining HLS parts into one MP4 (ffmpeg.wasm, no re-encoding) ----------
let ffmpeg = null;
const ffLogs = [];
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  const f = new FFmpeg();
  f.on("log", ({ message }) => {
    ffLogs.push(message);
    if (ffLogs.length > 40) ffLogs.shift();
  });
  await f.load({ coreURL: chrome.runtime.getURL("lib/core/ffmpeg-core.js"), wasmURL: chrome.runtime.getURL("lib/core/ffmpeg-core.wasm") });
  ffmpeg = f;
  return f;
}

async function muxParts(msg) {
  const cache = await caches.open("fo2sh-hls");
  const read = async (k) => {
    const r = await cache.match(k);
    if (!r) throw new Error("missing-part");
    return new Uint8Array(await r.arrayBuffer());
  };
  const f = await getFFmpeg();
  const vName = "v." + (msg.vKind || "mp4");
  await f.writeFile(vName, await read(msg.vKey));
  const args = ["-y", "-i", vName];
  let aName = null;
  if (msg.aKey) {
    aName = "a." + (msg.aKind || "mp4");
    await f.writeFile(aName, await read(msg.aKey));
    args.push("-i", aName, "-map", "0:v:0", "-map", "1:a:0");
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0?");
  }
  args.push("-c", "copy", "-movflags", "+faststart", "out.mp4");
  const code = await f.exec(args);
  if (code !== 0) throw new Error("ffmpeg " + code + ": " + (ffLogs.filter((l) => /error|invalid|could not|failed|matches no/i.test(l)).pop() || ""));
  const data = await f.readFile("out.mp4");
  for (const n of [vName, aName, "out.mp4"]) if (n) await f.deleteFile(n).catch(() => {});
  const blob = new Blob([data.buffer], { type: "video/mp4" });
  if (msg.storeKey) await (await caches.open("fo2sh-frames")).put(msg.storeKey, new Response(blob));
  return URL.createObjectURL(blob);
}

// Decodes the audio of an MP4 and turns it into a 16-bit WAV at the source sample rate.

// Reads the sample rate from the first 'mp4a' box, if there is one.
function mp4SampleRate(buf) {
  const b = new Uint8Array(buf);
  for (let i = 4; i < b.length - 40; i++) {
    if (b[i] === 0x6d && b[i + 1] === 0x70 && b[i + 2] === 0x34 && b[i + 3] === 0x61) {
      const start = i - 4;
      const rate = (b[start + 32] << 8) | b[start + 33];
      if (rate >= 8000 && rate <= 192000) return rate;
    }
  }
  return 0;
}

function hasAudioTrack(buf) {
  const b = new Uint8Array(buf);
  // 'soun' handler type inside an 'hdlr' box
  for (let i = 0; i < b.length - 4; i++) {
    if (b[i] === 0x73 && b[i + 1] === 0x6f && b[i + 2] === 0x75 && b[i + 3] === 0x6e) return true;
  }
  return false;
}

function toWav(audio) {
  const ch = audio.numberOfChannels, sr = audio.sampleRate, len = audio.length;
  const data = len * ch * 2;
  const out = new DataView(new ArrayBuffer(44 + data));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + data, true); w(8, "WAVE");
  w(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, "data"); out.setUint32(40, data, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(audio.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([out.buffer], { type: "audio/wav" });
}

// ---------- Frame grab: seek the original MP4 and draw that exact frame at full size ----------
function once(el, ev, ms = 30000) {
  return new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error(ev + "-timeout")), ms);
    el.addEventListener(ev, () => { clearTimeout(t); ok(); }, { once: true });
    el.addEventListener("error", () => { clearTimeout(t); bad(new Error("video-error")); }, { once: true });
  });
}

let frameSrc = { key: null, url: null };
async function grabFrame(key, time) {
  if (frameSrc.key !== key) {
    const r = await (await caches.open("fo2sh-frames")).match(key);
    if (!r) throw new Error("no-cache");
    if (frameSrc.url) URL.revokeObjectURL(frameSrc.url);
    frameSrc = { key, url: URL.createObjectURL(await r.blob()) };
  }
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01";
  document.body.appendChild(v);
  v.src = frameSrc.url;
  await once(v, "loadedmetadata");
  const t = Math.max(0, Math.min(time || 0, (v.duration || 0) - 0.04));
  const shown = new Promise((ok) => {
    // Resolve once the frame at the new position has actually been decoded
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => ok());
    setTimeout(ok, 1500);
  });
  v.currentTime = t > 0 ? t : 0.001;
  await once(v, "seeked");
  await shown;
  if (v.readyState < 2) await once(v, "canplay", 5000).catch(() => {});
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  const blob = await new Promise((ok) => c.toBlob(ok, "image/png"));
  v.removeAttribute("src");
  v.load();
  v.remove();
  return { blobUrl: URL.createObjectURL(blob), w: c.width, h: c.height };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "pvd-offscreen") return false;
  if (msg.type === "mux") {
    muxParts(msg)
      .then((blobUrl) => sendResponse({ ok: true, blobUrl }))
      .catch((e) => sendResponse({ ok: false, error: "mux-" + String(e.message || e).slice(0, 80) }));
    return true;
  }
  if (msg.type === "frame") {
    grabFrame(msg.key, msg.time)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: "frame-" + String(e.message || e).slice(0, 40) }));
    return true;
  }
  if (msg.type === "revoke") {
    URL.revokeObjectURL(msg.blobUrl);
    return false;
  }
  if (msg.type === "decode") {
    (async () => {
      let buf;
      try {
        buf = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0)).buffer;
      } catch (e) {
        return sendResponse({ ok: false, error: "bad-bytes" });
      }
      if (msg.checkMp4 && !hasAudioTrack(buf)) return sendResponse({ ok: false, error: "no-audio" });
      try {
        const sr = mp4SampleRate(buf) || 48000;
        const audio = await new OfflineAudioContext(2, 1, sr).decodeAudioData(buf);
        sendResponse({ ok: true, blobUrl: URL.createObjectURL(toWav(audio)) });
      } catch (e) {
        sendResponse({ ok: false, error: "decode-failed" });
      }
    })();
    return true;
  }
  return false;
});
