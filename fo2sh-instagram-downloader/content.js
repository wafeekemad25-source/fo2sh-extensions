(() => {
  const VERSION = "1.0.3";
  const APP_ID = "936619743392459"; // Instagram web app id, sent by instagram.com itself

  let target = null; // { el, type: "video" | "image" }
  let bar = null;
  let busy = false;
  let lastX = 0, lastY = 0, raf = 0;
  const cache = new Map(); // shortcode or media id -> { settled, items, err, promise }

  // ======================= UI =======================
  const ICON = {
    dl: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
    audio: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    frame: '<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
    all: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'
  };
  const svg = (p) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

  function makeBar() {
    bar = document.createElement("div");
    bar.className = "pvd-bar";
    bar.innerHTML = `
      <button type="button" class="pvd-b" data-act="main" title="D">${svg(ICON.dl)}<span>MP4</span></button>
      <button type="button" class="pvd-b" data-act="audio" title="A">${svg(ICON.audio)}<span>صوت</span></button>
      <button type="button" class="pvd-b" data-act="frame" title="F">${svg(ICON.frame)}<span>فريم</span></button>
      <button type="button" class="pvd-b" data-act="all" title="S">${svg(ICON.all)}<span>الكل</span></button>`;
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      e.preventDefault();
      e.stopPropagation();
      if (b && target) run(b.dataset.act, target);
    }, true);
    ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"].forEach((t) => bar.addEventListener(t, (e) => e.stopPropagation(), true));
    bar.addEventListener("mouseenter", () => scheduleWarm(true));
    document.documentElement.appendChild(bar);
  }

  function toast(text, kind) {
    let t = document.querySelector(".pvd-toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "pvd-toast";
      document.documentElement.appendChild(t);
    }
    t.textContent = text;
    t.dataset.kind = kind || "";
    t.classList.add("pvd-show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("pvd-show"), kind === "busy" ? 120000 : kind === "err" ? 7000 : 3500);
  }

  function placeBar() {
    if (!bar) makeBar();
    if (!target || !target.el.isConnected) return bar.classList.remove("pvd-show");
    const r = target.el.getBoundingClientRect();
    if (r.width < 120 || r.height < 120) return bar.classList.remove("pvd-show");
    const ref = refFor(target.el);
    const entry = ref && cache.get(ref.key);
    if (ref && !entry) prefetch(ref);
    const items = entry && entry.settled ? entry.items : [];
    const isVideo = target.type === "video";
    bar.querySelector('[data-act="main"] span').textContent = isVideo ? "MP4" : "صورة";
    bar.querySelector('[data-act="audio"]').style.display = isVideo ? "" : "none";
    bar.querySelector('[data-act="frame"]').style.display = isVideo ? "" : "none";
    const allBtn = bar.querySelector('[data-act="all"]');
    allBtn.style.display = items.length > 1 ? "" : "none";
    allBtn.querySelector("span").textContent = `الكل (${items.length})`;
    bar.style.top = Math.max(8, r.top + 10) + "px";
    bar.style.left = "0px";
    bar.classList.add("pvd-show");
    const w = bar.offsetWidth;
    bar.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w - 10)) + "px";
  }

  // ======================= Hover =======================
  const IG_CDN = /(cdninstagram\.com|fbcdn\.net)\//;

  function isPostImage(el) {
    if (el.tagName !== "IMG") return false;
    const src = el.currentSrc || el.src || "";
    if (!IG_CDN.test(src)) return false;
    if (/profile picture|صورة الملف/i.test(el.alt || "")) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 150 && r.height >= 150;
  }

  function targetAt(x, y) {
    const els = document.elementsFromPoint(x, y);
    if (bar && bar.contains(els[0])) return target;
    for (const el of els) if (el.tagName === "VIDEO") {
      const r = el.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 120) return { el, type: "video" };
    }
    for (const el of els) if (isPostImage(el)) return { el, type: "image" };
    return null;
  }

  function update() {
    raf = 0;
    const t = targetAt(lastX, lastY);
    if (!t || !target || t.el !== target.el) {
      target = t;
      scheduleWarm();
    }
    placeBar();
  }

  // ======================= Warm-up =======================
  // While the mouse rests on a video (or on the buttons), check the links and fetch the files,
  // so the click only has to join and save.
  let warmTimer = 0, ffWarm = false;
  const warmed = new Set();
  function scheduleWarm(now) {
    clearTimeout(warmTimer);
    if (!target || target.type !== "video") return;
    if (!ffWarm) {
      ffWarm = true;
      send({ type: "ig-warm" }).catch(() => {});
    }
    const t = target;
    warmTimer = setTimeout(async () => {
      if (target !== t) return;
      const ref = refFor(t.el);
      const items = await getItems(ref);
      if (target !== t) return;
      const { item } = matchItem(items, t);
      if (!item || item.type !== "video") return;
      const k = (item.versions[0] || {}).url || item.dash.slice(0, 200);
      if (warmed.has(k)) return;
      warmed.add(k);
      send({ type: "ig-warm", ...videoMsg(item) }).catch(() => warmed.delete(k));
    }, now ? 0 : 700);
  }

  document.addEventListener("mousemove", (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (!raf) raf = requestAnimationFrame(update);
  }, { passive: true });
  window.addEventListener("scroll", () => {
    if (!raf) raf = requestAnimationFrame(update);
  }, { passive: true, capture: true });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const act = { KeyD: "main", KeyA: "audio", KeyS: "all", KeyF: "frame" }[e.code];
    if (!act || !target) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if ((act === "audio" || act === "frame") && target.type !== "video") return;
    e.preventDefault();
    e.stopPropagation();
    run(act, target);
  }, true);

  // ======================= Which post =======================
  const CODE_RE = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/;
  const STORY_RE = /\/stories\/[^/]+\/(\d{5,})/;

  function codeToId(code) {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = 0n;
    for (const c of code.slice(0, 11)) id = id * 64n + BigInt(abc.indexOf(c));
    return id.toString();
  }

  function refFromHref(href) {
    if (!href) return null;
    const s = href.match(STORY_RE);
    if (s) return { key: "id:" + s[1], id: s[1], code: null };
    const m = href.match(CODE_RE);
    return m ? { key: m[1], id: codeToId(m[1]), code: m[1] } : null;
  }

  // Grid tile link → the post's own links (feed) → the page address (post, reel, story)
  function refFor(el) {
    const a = el.closest('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
    if (a) {
      const r = refFromHref(a.getAttribute("href"));
      if (r) return r;
    }
    const scope = el.closest("article") || null;
    if (scope) {
      const refs = new Map();
      for (const l of scope.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]')) {
        const r = refFromHref(l.getAttribute("href"));
        if (r) refs.set(r.key, r);
      }
      if (refs.size === 1) return [...refs.values()][0];
    }
    return refFromHref(location.pathname);
  }

  // ======================= Post data =======================
  // Items: { type:"video", versions:[{url,w,h}], dash, duration, hasAudio, ids:[] } | { type:"image", urls:[...], ids:[] }
  const fileOf = (u) => (u || "").split("?")[0].split("/").pop();

  function fromApiItem(m) {
    const imgs = (m.image_versions2?.candidates || []).slice().sort((a, b) => b.width * b.height - a.width * a.height);
    const ids = [m.pk && String(m.pk), m.id && String(m.id).split("_")[0], ...imgs.map((c) => fileOf(c.url))].filter(Boolean);
    if (m.video_versions && m.video_versions.length) {
      return {
        type: "video",
        versions: m.video_versions.map((v) => ({ url: v.url, w: v.width, h: v.height })),
        dash: m.video_dash_manifest || "",
        duration: m.video_duration || 0,
        hasAudio: m.has_audio !== false,
        ids
      };
    }
    return imgs.length ? { type: "image", urls: imgs.map((c) => c.url), ids } : null;
  }

  // Older public JSON shape (graphql.shortcode_media)
  function fromGraphql(n) {
    const kids = n.edge_sidecar_to_children?.edges?.map((e) => e.node);
    if (kids && kids.length) return kids.map(fromGraphql).flat();
    const res = (n.display_resources || []).slice().sort((a, b) => b.config_width - a.config_width).map((r) => r.src);
    const ids = [n.id, ...res.map(fileOf), fileOf(n.display_url)].filter(Boolean);
    if (n.is_video && n.video_url) return [{ type: "video", versions: [{ url: n.video_url, w: n.dimensions?.width, h: n.dimensions?.height }], dash: n.dash_info?.video_dash_manifest || "", duration: n.video_duration || 0, hasAudio: n.has_audio !== false, ids }];
    return [{ type: "image", urls: [...res, n.display_url].filter(Boolean), ids }];
  }

  function itemsFromJson(json) {
    const item = json?.items?.[0];
    if (item) {
      const list = item.carousel_media ? item.carousel_media.map(fromApiItem) : [fromApiItem(item)];
      return list.filter(Boolean);
    }
    const g = json?.graphql?.shortcode_media || json?.data?.xdt_shortcode_media;
    return g ? fromGraphql(g) : [];
  }

  // Account name + start of the caption, for readable file names
  function metaFromJson(json) {
    const item = json?.items?.[0];
    if (item) return { user: item.user?.username || item.owner?.username || "", caption: item.caption?.text || "" };
    const g = json?.graphql?.shortcode_media || json?.data?.xdt_shortcode_media;
    if (g) return { user: g.owner?.username || "", caption: g.edge_media_to_caption?.edges?.[0]?.node?.text || "" };
    return { user: "", caption: "" };
  }

  function cleanCaption(t) {
    let c = (t || "")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[#@][\p{L}\p{N}_.]+/gu, " ")
      .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, " ")
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/[<>:"/\\|?*~\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (c.length > 60) c = c.slice(0, 60).replace(/\s+\S*$/, "");
    return c.replace(/[\s.\-–,،:;!؟?]+$/u, "").trim();
  }

  function baseName(ref, meta) {
    const user = (meta && meta.user) || "";
    const cap = cleanCaption(meta && meta.caption);
    const code = ref ? ref.code || ref.id : String(Date.now());
    if (user && cap) return `${user} - ${cap}`;
    if (user) return `${user} - ${code}`;
    return `instagram-${code}`;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { credentials: "include", headers: { "X-IG-App-ID": APP_ID, "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } });
    if (!r.ok) throw new Error("http" + r.status);
    return r.json();
  }

  async function fetchItems(ref) {
    let err = "";
    try {
      const json = await fetchJson(`${location.origin}/api/v1/media/${ref.id}/info/`);
      const items = itemsFromJson(json);
      if (items.length) return { items, meta: metaFromJson(json) };
    } catch (e) { err = "api:" + e.message; }
    if (ref.code) {
      try {
        const json = await fetchJson(`${location.origin}/p/${ref.code}/?__a=1&__d=dis`);
        const items = itemsFromJson(json);
        if (items.length) return { items, meta: metaFromJson(json) };
      } catch (e) { err += " a1:" + e.message; }
    }
    return { items: [], err: err.trim() || "no-media" };
  }

  function getItems(ref) {
    if (!ref) return Promise.resolve([]);
    if (!cache.has(ref.key)) {
      const entry = { settled: false, items: [], err: "" };
      entry.promise = fetchItems(ref).then(({ items, err, meta }) => {
        entry.items = items;
        entry.meta = meta || null;
        entry.err = err || "";
        entry.settled = true;
        if (target) placeBar();
        return items;
      });
      cache.set(ref.key, entry);
    }
    return cache.get(ref.key).promise;
  }

  let prefetchTimer = 0;
  function prefetch(ref) {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => getItems(ref), 250);
  }

  // ======================= Which slide =======================
  function largestSrc(el) {
    let best = el.currentSrc || el.src, bw = 0;
    for (const part of (el.srcset || "").split(",")) {
      const [u, d] = part.trim().split(/\s+/);
      const w = parseFloat(d) || 0;
      if (u && w >= bw) { bw = w; best = u; }
    }
    return best;
  }

  function matchItem(items, t) {
    const same = items.filter((i) => i.type === t.type);
    if (!same.length) return { item: null, sure: false };
    if (same.length === 1) return { item: same[0], sure: true };
    if (t.type === "image") {
      const files = [t.el.currentSrc, t.el.src, ...(t.el.srcset || "").split(",").map((p) => p.trim().split(/\s+/)[0])].map(fileOf).filter(Boolean);
      const hit = same.find((i) => i.ids.some((id) => files.includes(id)));
      if (hit) return { item: hit, sure: true };
    } else {
      const d = t.el.duration;
      if (isFinite(d) && d > 0) {
        const s = same.filter((i) => i.duration).map((i) => ({ i, diff: Math.abs(i.duration - d) })).sort((a, b) => a.diff - b.diff);
        if (s.length && s[0].diff < 0.35 && (!s[1] || s[1].diff - s[0].diff > 0.15)) return { item: s[0].i, sure: true };
      }
      const poster = fileOf(t.el.poster);
      const hit = poster && same.find((i) => i.ids.includes(poster));
      if (hit) return { item: hit, sure: true };
    }
    // Carousel: position of this slide among the slides of the same type
    const list = t.el.closest("ul");
    if (list) {
      const slides = [...list.querySelectorAll(t.type === "video" ? "video" : "img")].filter((e) => t.type === "video" || isPostImage(e));
      const idx = slides.indexOf(t.el);
      if (idx >= 0 && idx < same.length && slides.length === same.length) return { item: same[idx], sure: false };
    }
    return { item: same[0], sure: false };
  }

  // ======================= Actions =======================
  const pad = (n) => String(n).padStart(2, "0");
  const two = (n) => String(Math.floor(n)).padStart(2, "0");
  const stamp = (t) => `${two(t / 60)}-${two(t % 60)}-${two((t % 1) * 100)}`;
  const send = (msg) => chrome.runtime.sendMessage(msg);
  const videoMsg = (it) => ({ versions: it.versions, dash: it.dash, hasAudio: it.hasAudio });

  function downloadItem(it, name) {
    if (it.type === "image") return send({ type: "ig-image", candidates: it.urls, name });
    return send({ type: "ig-video", ...videoMsg(it), name });
  }

  async function run(act, t) {
    if (busy) return;
    busy = true;
    bar && bar.classList.add("pvd-busy");
    try {
      const ref = refFor(t.el);
      toast("جاري التجهيز...", "busy");
      const items = await getItems(ref);
      const err = ref ? cache.get(ref.key)?.err : "no-post";
      const base = baseName(ref, ref ? cache.get(ref.key)?.meta : null);

      if (act === "all" && items.length > 1) {
        let ok = 0;
        for (let i = 0; i < items.length; i++) {
          toast(`جاري تحميل ${i + 1} من ${items.length}...`, "busy");
          const res = await downloadItem(items[i], `${base} - ${pad(i + 1)}`);
          if (res && res.ok) ok++;
        }
        return toast(ok === items.length ? `تم تحميل ${ok} ملف في Downloads/Instagram` : `اتحمل ${ok} من ${items.length}`, ok ? "ok" : "err");
      }

      const { item, sure } = matchItem(items, t);
      const idx = item && items.length > 1 ? items.indexOf(item) : -1;
      const name = idx >= 0 ? `${base} - ${pad(idx + 1)}` : base;

      if (!item) {
        // No post data: images still work from the page itself
        if (t.type === "image") {
          const res = await send({ type: "ig-image", candidates: [largestSrc(t.el)], name });
          return toast(res && res.ok ? "اتحملت الصورة بالمقاس اللي ظاهر في الصفحة" : `التحميل فشل (${res?.error || err})`, res && res.ok ? "ok" : "err");
        }
        if (act === "frame") return grabFromPage(t.el, name);
        return toast(`مش قادر أجيب بيانات البوست. اتأكد إنك عامل تسجيل دخول (${err || "no-data"})`, "err");
      }

      if (act === "audio") {
        toast("جاري تحميل الصوت...", "busy");
        const res = await send({ type: "ig-audio", ...videoMsg(item), name });
        if (res && res.ok) return toast("الصوت اتحمل M4A في Downloads/Instagram", "ok");
        return toast(res && res.error === "no-audio" ? "الفيديو ده مفيهوش صوت" : `تحميل الصوت فشل (${res?.error || "no-reply"})`, "err");
      }

      if (act === "frame") {
        const time = t.el.currentTime || 0;
        const fname = `${name} - frame ${stamp(time)}`;
        toast("جاري أخذ الفريم...", "busy");
        const res = await send({ type: "ig-frame", ...videoMsg(item), time, name: fname });
        if (res && res.ok) return toast(`الفريم اتحفظ PNG ${res.w}×${res.h} في Downloads/Instagram`, "ok");
        return grabFromPage(t.el, fname);
      }

      toast(item.type === "video" ? "جاري التحميل بأعلى جودة..." : "جاري التحميل...", "busy");
      const res = await downloadItem(item, name);
      if (!res || !res.ok) return toast(`التحميل فشل (${res?.error || "no-reply"})`, "err");
      if (res.silent) return toast(`اتحمل ${res.h}p بس من غير صوت (${res.note || "no-audio-stream"})`, "err");
      const q = res.h ? ` ${res.h}p` : "";
      if (res.codec && /VP9|AV1/.test(res.codec)) return toast(`اتحمل${q} بس بكوديك ${res.codec}، ممكن QuickTime و Premiere ما يشغلوهوش`, "err");
      toast(sure ? `تم التحميل${q} في Downloads/Instagram` : `اتحمل${q}، بس مش متأكد 100% إنه نفس الشريحة`, "ok");
    } catch (e) {
      toast("حصل خطأ، اعمل Refresh للصفحة وجرب تاني", "err");
    } finally {
      busy = false;
      bar && bar.classList.remove("pvd-busy");
    }
  }

  // Frame without post data: from the player, else a screenshot of the video area
  async function grabFromPage(video, name) {
    try {
      if (!video.videoWidth) throw new Error("no-frame");
      const c = document.createElement("canvas");
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext("2d").drawImage(video, 0, 0);
      const res = await send({ type: "ig-save-data", dataUrl: c.toDataURL("image/png"), name });
      if (res && res.ok) return toast(`الفريم اتحفظ PNG ${c.width}×${c.height} (بجودة اللي شغال دلوقتي)`, "ok");
    } catch (e) {}
    const r = video.getBoundingClientRect();
    bar && bar.classList.remove("pvd-show");
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    const res = await send({ type: "ig-shot", rect: { x: r.left, y: r.top, w: r.width, h: r.height }, dpr: devicePixelRatio, name });
    toast(res && res.ok ? `الفريم اتحفظ PNG ${res.w}×${res.h} (سكرين شوت للشاشة)` : `أخذ الفريم فشل (${res?.error || "no-reply"})`, res && res.ok ? "ok" : "err");
  }

  console.debug("[Fo2sh Instagram Downloader]", VERSION);
})();
