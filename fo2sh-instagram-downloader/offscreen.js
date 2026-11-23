// Heavy work the service worker cannot do: join video + audio, pull the audio out, grab a frame.
// Input bytes arrive through Cache Storage ("fo2sh-ig"), never through messages.
import { FFmpeg } from "./lib/ffmpeg/index.js";

let ffmpeg = null;
const logs = [];
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  const f = new FFmpeg();
  f.on("log", ({ message }) => {
    logs.push(message);
    if (logs.length > 40) logs.shift();
  });
  await f.load({ coreURL: chrome.runtime.getURL("lib/core/ffmpeg-core.js"), wasmURL: chrome.runtime.getURL("lib/core/ffmpeg-core.wasm") });
  ffmpeg = f;
  return f;
}

async function fromCache(key) {
  const r = await (await caches.open("fo2sh-ig")).match(key);
  if (!r) throw new Error("missing");
  return new Uint8Array(await r.arrayBuffer());
}

async function runFF(inputs, args, out, type) {
  const f = await getFFmpeg();
  for (const [name, key] of inputs) await f.writeFile(name, await fromCache(key));
  const code = await f.exec(["-y", ...args, out]);
  if (code !== 0) throw new Error("ffmpeg " + code + ": " + (logs.filter((l) => /error|invalid|could not|failed|matches no/i.test(l)).pop() || ""));
  const data = await f.readFile(out);
  for (const [name] of inputs) await f.deleteFile(name).catch(() => {});
  await f.deleteFile(out).catch(() => {});
  return URL.createObjectURL(new Blob([data.buffer], { type }));
}

const mux = (vKey, aKey) =>
  runFF([["v.mp4", vKey], ["a.mp4", aKey]], ["-i", "v.mp4", "-i", "a.mp4", "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart"], "out.mp4", "video/mp4");

const extractAudio = (key) => runFF([["in.mp4", key]], ["-i", "in.mp4", "-vn", "-map", "0:a:0", "-c:a", "copy"], "out.m4a", "audio/mp4");

// ---------- Frame grab ----------
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
    if (frameSrc.url) URL.revokeObjectURL(frameSrc.url);
    frameSrc = { key, url: URL.createObjectURL(new Blob([await fromCache(key)], { type: "video/mp4" })) };
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
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => ok());
    setTimeout(ok, 1500);
  });
  v.currentTime = t > 0 ? t : 0.001;
  await once(v, "seeked");
  await shown;
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

// Load ffmpeg as soon as this page opens, so joining is ready by the time it is needed
getFFmpeg().catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "fo2sh-ig-offscreen") return false;
  const reply = (p) => {
    p.then((r) => sendResponse({ ok: true, ...(typeof r === "string" ? { blobUrl: r } : r) }))
      .catch((e) => sendResponse({ ok: false, error: msg.type + "-" + String(e.message || e).slice(0, 80) }));
    return true;
  };
  if (msg.type === "revoke") return URL.revokeObjectURL(msg.blobUrl), false;
  if (msg.type === "warm") return getFFmpeg().catch(() => {}), false;
  if (msg.type === "mux") return reply(mux(msg.vKey, msg.aKey));
  if (msg.type === "audio") return reply(extractAudio(msg.key));
  if (msg.type === "frame") return reply(grabFrame(msg.key, msg.time));
  return false;
});
