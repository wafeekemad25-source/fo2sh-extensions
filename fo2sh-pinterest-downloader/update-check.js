// Shows in the popup whether a newer version is on GitHub.
(() => {
  const REPO = "wafeekemad25-source/fo2sh-extensions";
  const PATH = "fo2sh-pinterest-downloader/manifest.json";
  const el = document.getElementById("fo2sh-update");
  if (!el) return;
  const parts = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
  const newer = (a, b) => {
    const x = parts(a), y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  const cur = chrome.runtime.getManifest().version;
  fetch(`https://raw.githubusercontent.com/${REPO}/main/${PATH}?t=${Date.now()}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (!m) return;
      if (newer(m.version, cur)) {
        el.className = "fo2sh-new";
        el.textContent = `فيه نسخة جديدة ${m.version} (إنت على ${cur}). شغّل update.command وبعدين Reload للإضافة.`;
      } else {
        el.textContent = `إنت على آخر نسخة (${cur})`;
      }
    })
    .catch(() => {});
})();
