(() => {
  const VERSION = "1.1.1";
  let target = null; // { el, url }
  let bar = null, menu = null, menuOpen = false;
  let lastX = 0, lastY = 0, raf = 0;

  // ======================= Video URL =======================
  function videoUrl(href) {
    try {
      const u = new URL(href, location.origin);
      if (/youtu\.be$/.test(u.hostname)) return `https://www.youtube.com/watch?v=${u.pathname.slice(1)}`;
      const v = u.searchParams.get("v");
      if (u.pathname === "/watch" && v) return `https://www.youtube.com/watch?v=${v}`;
      const s = u.pathname.match(/^\/shorts\/([\w-]{6,})/);
      if (s) return `https://www.youtube.com/shorts/${s[1]}`;
    } catch (e) {}
    return null;
  }

  const LINK_SEL = 'a[href*="/watch?v="], a[href*="/shorts/"]';

  function targetAt(x, y) {
    const els = document.elementsFromPoint(x, y);
    if (bar && (bar.contains(els[0]) || (menu && menu.contains(els[0])))) return target;
    for (const el of els) {
      // Inline preview player on the home page / search
      const preview = el.closest("ytd-video-preview, #video-preview");
      if (preview) {
        const a = preview.querySelector(LINK_SEL);
        const url = a && videoUrl(a.getAttribute("href"));
        if (url) return { el: preview, url };
      }
      const player = el.closest("#movie_player, .html5-video-player, #shorts-player");
      if (player && !el.closest("ytd-video-preview, #video-preview")) {
        const url = videoUrl(location.href);
        if (url) return { el: player, url };
      }
      const a = el.closest(LINK_SEL);
      if (a) {
        const r = a.getBoundingClientRect();
        const url = videoUrl(a.getAttribute("href"));
        if (url && r.width >= 120 && r.height >= 66) return { el: a, url };
      }
    }
    return null;
  }

  // ======================= UI =======================
  const ICON_DL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>';

  function makeUi() {
    bar = document.createElement("div");
    bar.className = "fyt-bar";
    bar.innerHTML = `<button type="button" class="fyt-b" title="D">${ICON_DL}<span>تنزيل</span></button>`;
    menu = document.createElement("div");
    menu.className = "fyt-menu";
    bar.querySelector("button").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      menuOpen ? closeMenu() : openMenu();
    }, true);
    menu.addEventListener("click", (e) => {
      const it = e.target.closest("[data-kind]");
      e.preventDefault();
      e.stopPropagation();
      if (!it || it.classList.contains("fyt-off")) return;
      startDownload(it.dataset);
      closeMenu();
    }, true);
    for (const el of [bar, menu]) {
      ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"].forEach((t) => el.addEventListener(t, (e) => e.stopPropagation(), true));
      document.documentElement.appendChild(el);
    }
    document.addEventListener("mousedown", (e) => {
      if (menuOpen && !bar.contains(e.target) && !menu.contains(e.target)) closeMenu();
    }, true);
  }

  function place() {
    if (!bar) makeUi();
    if (!target || !target.el.isConnected) {
      bar.classList.remove("fyt-show");
      return closeMenu();
    }
    const r = target.el.getBoundingClientRect();
    if (r.width < 100 || r.height < 60 || r.bottom < 0 || r.top > innerHeight) {
      bar.classList.remove("fyt-show");
      return closeMenu();
    }
    bar.style.top = Math.max(8, r.top + 8) + "px";
    bar.style.left = "0px";
    bar.classList.add("fyt-show");
    const w = bar.offsetWidth;
    const left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w - 8));
    bar.style.left = left + "px";
    if (menuOpen) placeMenu();
  }

  function placeMenu() {
    const br = bar.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(innerWidth - mw - 8, br.right - mw)) + "px";
    menu.style.top = Math.max(8, Math.min(innerHeight - mh - 8, br.bottom + 6)) + "px";
  }

  // ======================= Menu =======================
  const fmtSize = (b) => (!b ? "" : b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.max(1, Math.round(b / 1e6)) + " MB");
  const fmtDur = (s) => {
    s = Math.round(s || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
  };
  const LABEL = { 4320: "8K", 2160: "4K", 1440: "2K" };

  function renderMenu(info, loading, error) {
    const rows = [];
    if (info && info.title) rows.push(`<div class="fyt-title">${escapeHtml(info.title)}${info.duration ? ` · ${fmtDur(info.duration)}` : ""}</div>`);
    rows.push('<div class="fyt-sec">فيديو</div>');
    if (error) {
      rows.push(`<div class="fyt-err">${escapeHtml(error)}</div>`);
    } else if (loading) {
      rows.push('<div class="fyt-load">جاري قراءة الجودات المتاحة...</div>');
      for (const h of [1080, 720, 480, 360]) rows.push(item("video", h, `${h}p`, ""));
    } else {
      const hs = (info.heights || []).filter((x) => x.h >= 144);
      for (const x of hs) {
        const note = x.h > 1080 && x.codec !== "H.264" ? `<i>${x.codec}</i>` : "";
        rows.push(item("video", x.h, `${x.h}p${LABEL[x.h] ? " · " + LABEL[x.h] : ""}`, fmtSize(x.size), note));
      }
      if (!hs.length) rows.push(item("video", 0, "أعلى جودة", ""));
    }
    rows.push('<div class="fyt-sec">صوت بس</div>');
    const as = info && info.audio ? fmtSize(info.audio) : "";
    rows.push(item("audio", "mp3", "MP3", ""), item("audio", "wav", "WAV", ""), item("audio", "m4a", "M4A (الأصلي)", as));
    menu.innerHTML = rows.join("");
    if (menuOpen) placeMenu();
  }

  function item(kind, val, label, size, note = "") {
    const data = kind === "video" ? `data-kind="video" data-height="${val}"` : `data-kind="audio" data-format="${val}"`;
    return `<div class="fyt-item" ${data} data-label="${label.split(" ")[0]}"><span>${label} ${note}</span><b>${size}</b></div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  const ERR = {
    "not-installed": "لازم تشغّل install.command مرة واحدة الأول (التعليمات في ملف اقرأني)",
    "host-crashed": "البرنامج المساعد وقف. شغّل install.command تاني"
  };

  let menuUrl = null;
  async function openMenu() {
    if (!target) return;
    menuOpen = true;
    menuUrl = target.url;
    menu.classList.add("fyt-show");
    renderMenu(null, true);
    placeMenu();
    const url = target.url;
    const res = await chrome.runtime.sendMessage({ type: "yt-formats", url });
    if (!menuOpen || menuUrl !== url) return;
    if (res && res.ok) {
      menu._info = res;
      renderMenu(res, false);
    } else {
      menu._info = null;
      renderMenu(null, false, ERR[res && res.error] || `مش قادر أقرا الفيديو (${(res && res.error) || "no-reply"}). جرب تحدّث yt-dlp من أيقونة الإضافة`);
    }
  }

  function closeMenu() {
    menuOpen = false;
    menuUrl = null;
    if (menu) menu.classList.remove("fyt-show");
  }

  // ======================= Downloads =======================
  async function startDownload(d) {
    const info = menu._info;
    const label = d.kind === "video" ? (d.height === "0" ? "أعلى جودة" : `${d.height}p`) : d.format.toUpperCase();
    toast(`${label}: بدأ التحميل...`, "busy");
    await chrome.runtime.sendMessage({
      type: "yt-download",
      url: menuUrl || (target && target.url),
      kind: d.kind,
      height: d.kind === "video" ? +d.height : undefined,
      format: d.format,
      title: info && info.title,
      label
    });
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m.type !== "yt-job") return;
    const L = m.label || "";
    if (m.state === "progress") toast(`${L}: ${Math.round(m.percent)}%${m.eta && m.eta !== "NA" ? ` · باقي ${m.eta.trim()}` : ""}`, "busy");
    else if (m.state === "stage") toast(m.stage === "merge" ? `${L}: بيدمج الصورة والصوت...` : m.stage === "save" ? `${L}: بيحفظ الملف...` : `${L}: بيحوّل الصوت...`, "busy");
    else if (m.state === "done") {
      if (m.ok && m.inChrome) toast(`${L}: اتحمل، تلاقيه في تنزيلات Chrome`, "ok");
      else if (m.ok) toast(`${L}: اتحمل في Downloads/YouTube`, "ok");
      else toast(`${L}: ${ERR[m.error] || "التحميل فشل (" + (m.error || "error") + ")"}`, "err");
    }
  });

  function toast(text, kind) {
    let t = document.querySelector(".fyt-toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "fyt-toast";
      document.documentElement.appendChild(t);
    }
    t.textContent = text;
    t.dataset.kind = kind || "";
    t.classList.add("fyt-show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("fyt-show"), kind === "busy" ? 600000 : kind === "err" ? 8000 : 4000);
  }

  // ======================= Events =======================
  function update() {
    raf = 0;
    if (!menuOpen) {
      const t = targetAt(lastX, lastY);
      if (!t || !target || t.el !== target.el || t.url !== target.url) target = t;
    }
    place();
  }

  document.addEventListener("mousemove", (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (!raf) raf = requestAnimationFrame(update);
  }, { passive: true });
  window.addEventListener("scroll", () => {
    if (!raf) raf = requestAnimationFrame(update);
  }, { passive: true, capture: true });
  window.addEventListener("yt-navigate-finish", () => {
    closeMenu();
    target = null;
    if (!raf) raf = requestAnimationFrame(update);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuOpen) return closeMenu();
    if (e.code !== "KeyD" || e.metaKey || e.ctrlKey || e.altKey || !target) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    e.preventDefault();
    e.stopPropagation();
    menuOpen ? closeMenu() : openMenu();
  }, true);

  console.debug("[Fo2sh YouTube Downloader]", VERSION);
})();
