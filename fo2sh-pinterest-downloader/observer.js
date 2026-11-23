// Runs at document_start. Keeps our own list of video files the page loads,
// because the browser's built-in list stops recording after 250 entries.
(() => {
  const list = [];
  window.__pvdNet = list;
  try {
    new PerformanceObserver((obs) => {
      for (const e of obs.getEntries()) {
        if (/pinimg\.com\/videos\//.test(e.name)) {
          list.push({ url: e.name, t: e.responseEnd || performance.now() });
          if (list.length > 400) list.splice(0, list.length - 400);
        }
      }
    }).observe({ type: "resource", buffered: true });
  } catch (e) {}
})();
