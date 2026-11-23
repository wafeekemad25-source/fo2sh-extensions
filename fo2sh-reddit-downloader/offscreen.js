// Joins Reddit's separate video and audio files into one MP4 with ffmpeg (no re-encoding).
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
  await f.load({
    coreURL: chrome.runtime.getURL("lib/core/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("lib/core/ffmpeg-core.wasm")
  });
  ffmpeg = f;
  return f;
}

async function fromCache(key) {
  const c = await caches.open("fo2sh");
  const r = await c.match(key);
  if (!r) throw new Error("missing " + key);
  return new Uint8Array(await r.arrayBuffer());
}

async function mux(vKey, aKey) {
  const f = await getFFmpeg();
  await f.writeFile("v.mp4", await fromCache(vKey));
  await f.writeFile("a.mp4", await fromCache(aKey));
  const code = await f.exec(["-y", "-i", "v.mp4", "-i", "a.mp4", "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", "out.mp4"]);
  if (code !== 0) {
    console.error("[fo2sh] ffmpeg failed:\n" + logs.join("\n"));
    throw new Error("ffmpeg " + code + ": " + (logs.filter((l) => /error|invalid|could not|failed|matches no/i.test(l)).pop() || ""));
  }
  const data = await f.readFile("out.mp4");
  for (const n of ["v.mp4", "a.mp4", "out.mp4"]) await f.deleteFile(n).catch(() => {});
  return URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "fo2sh-offscreen") return false;
  if (msg.type === "revoke") {
    URL.revokeObjectURL(msg.blobUrl);
    return false;
  }
  if (msg.type === "mux") {
    mux(msg.vKey, msg.aKey)
      .then((blobUrl) => sendResponse({ ok: true, blobUrl }))
      .catch((e) => sendResponse({ ok: false, error: "mux-" + String(e.message || e).slice(0, 160) }));
    return true;
  }
  return false;
});
