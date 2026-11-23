const HOST = "com.fo2sh.ytdl";
const formatsCache = new Map();

function errCode(e) {
  const m = String((e && e.message) || e || "");
  if (/not found|not registered|forbidden/i.test(m)) return "not-installed";
  if (/exited|disconnected/i.test(m)) return "host-crashed";
  return m.slice(0, 80) || "error";
}

function native(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: errCode(chrome.runtime.lastError) });
      else resolve(res || { ok: false, error: "no-reply" });
    });
  });
}

function startDownload(msg, tabId) {
  const jobId = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  const tell = (data) => tabId != null && chrome.tabs.sendMessage(tabId, { type: "yt-job", jobId, label: msg.label, ...data }).catch(() => {});
  let finished = false;
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    tell({ state: "done", ok: false, error: errCode(e) });
    return jobId;
  }
  port.onMessage.addListener((m) => {
    if (m.type === "progress") tell({ state: "progress", percent: m.percent, eta: m.eta, speed: m.speed });
    else if (m.type === "stage") tell({ state: "stage", stage: m.stage });
    else if (m.type === "done" && m.ok && m.serve) {
      // Pull the finished file through Chrome so it appears in Chrome's downloads
      tell({ state: "stage", stage: "save" });
      saveViaChrome(m.serve, m.name).then((r) => {
        tell({ state: "done", ok: r.ok, error: r.error, inChrome: r.ok });
        if (!r.ok) {
          finished = true;
          port.disconnect();
        }
      });
    } else if (m.type === "done") {
      finished = true;
      tell({ state: "done", ok: m.ok, error: m.error, saved: m.saved });
      port.disconnect();
    } else if (m.type === "served") {
      finished = true;
      port.disconnect();
    }
  });
  port.onDisconnect.addListener(() => {
    if (!finished) {
      const e = chrome.runtime.lastError;
      tell({ state: "done", ok: false, error: e ? errCode(e) : "disconnected" });
    }
  });
  port.postMessage({ action: "download", url: msg.url, kind: msg.kind, height: msg.height, format: msg.format, title: msg.title });
  tell({ state: "started" });
  return jobId;
}

function cleanName(n) {
  const c = (n || "video.mp4").replace(/[<>:"|?*~\\/\u0000-\u001f]+/g, "_").replace(/^[.\s]+/, "").trim();
  return c || "video.mp4";
}

function download(opts) {
  return new Promise((resolve) => {
    chrome.downloads.download(opts, (id) => resolve(chrome.runtime.lastError || id === undefined ? null : id));
  });
}

async function saveViaChrome(url, name) {
  let id = await download({ url, filename: `YouTube/${cleanName(name)}`, conflictAction: "uniquify", saveAs: false });
  if (id == null) {
    // Name Chrome refused: keep only the extension
    const ext = ((name || "").match(/\.\w+$/) || [".mp4"])[0];
    id = await download({ url, filename: `YouTube/youtube-${Date.now()}${ext}`, conflictAction: "uniquify", saveAs: false });
  }
  return id == null ? { ok: false, error: "chrome-save-failed" } : { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "yt-formats") {
    const key = msg.url;
    const cached = formatsCache.get(key);
    if (cached && Date.now() - cached.t < 30 * 60 * 1000) {
      sendResponse(cached.res);
      return false;
    }
    native({ action: "formats", url: msg.url }).then((res) => {
      if (res.ok) formatsCache.set(key, { t: Date.now(), res });
      sendResponse(res);
    });
    return true;
  }
  if (msg.type === "yt-download") {
    sendResponse({ ok: true, jobId: startDownload(msg, sender.tab && sender.tab.id) });
    return false;
  }
  if (msg.type === "yt-ping" || msg.type === "yt-update") {
    native({ action: msg.type === "yt-ping" ? "ping" : "update" }).then(sendResponse);
    return true;
  }
  return false;
});
