(() => {
  const VERSION = "1.0.2";
  const POST_SEL = 'shreddit-post, [data-permalink], .thing[data-fullname^="t3_"]';

  let target = null; // { el, type: "video" | "image" }
  let bar = null;
  let busy = false;
  let lastX = 0, lastY = 0, raf = 0;
  const cache = new Map(); // permalink -> { settled, items, promise, err }

  // ======================= UI =======================
  const ICON_DL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>';
  const ICON_AUDIO = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>';
  const ICON_ALL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';

  function makeBar() {
    bar = document.createElement("div");
    bar.className = "pvd-bar";
    bar.innerHTML = `
      <button type="button" class="pvd-b" data-act="main" title="D">${ICON_DL}<span>MP4</span></button>
      <button type="button" class="pvd-b" data-act="audio" title="A">${ICON_AUDIO}<span>صوت</span></button>
      <button type="button" class="pvd-b" data-act="all" title="S">${ICON_ALL}<span>الكل</span></button>`;
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      e.preventDefault();
      e.stopPropagation();
      if (b && target) run(b.dataset.act, target);
    }, true);
    ["mousedown", "mouseup", "pointerdown", "pointerup"].forEach((t) => bar.addEventListener(t, (e) => e.stopPropagation(), true));
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
    t._h = setTimeout(() => t.classList.remove("pvd-show"), kind === "busy" ? 120000 : 3500);
  }

  function placeBar() {
    if (!bar) makeBar();
    if (!target || !target.el.isConnected) return bar.classList.remove("pvd-show");
    const r = target.el.getBoundingClientRect();
    if (r.width < 100 || r.height < 80) return bar.classList.remove("pvd-show");
    const link = permalinkFor(target.el);
    const entry = link && cache.get(link);
    if (link && !entry) prefetch(link);
    const items = entry && entry.settled ? entry.items : [];
    const isVideo = target.type === "video";
    const gif = isVideo && items.length && items.every((i) => i.type === "video" && i.direct);
    bar.querySelector('[data-act="main"] span').textContent = isVideo ? (gif ? "GIF/MP4" : "MP4") : "صورة";
    bar.querySelector('[data-act="audio"]').style.display = isVideo && !gif ? "" : "none";
    const allBtn = bar.querySelector('[data-act="all"]');
    allBtn.style.display = items.length > 1 ? "" : "none";
    allBtn.querySelector("span").textContent = `الكل (${items.length})`;

    bar.style.top = Math.max(8, r.top + 10) + "px";
    bar.style.left = "0px";
    bar.classList.add("pvd-show");
    const w = bar.offsetWidth;
    bar.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w - 10)) + "px";
  }

  // ======================= Hover =======================
  const isPlayerTag = (el) => /^SHREDDIT-PLAYER/.test(el.tagName) || el.tagName === "VIDEO";

  function isPostImage(el) {
    if (el.tagName !== "IMG") return false;
    const src = el.currentSrc || el.src || "";
    if (!/(i\.redd\.it|preview\.redd\.it|external-preview\.redd\.it|i\.imgur\.com)/.test(src)) return false;
    if (/\/(avatar|icon|award|emoji|snoovatar)/i.test(src)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 120 && r.height >= 100;
  }

  // Like elementsFromPoint, but also looks inside Reddit's web components (open shadow roots).
  function deepElementsFromPoint(x, y) {
    const out = [];
    const seen = new Set();
    const walk = (root, depth) => {
      if (depth > 6) return;
      for (const el of root.elementsFromPoint(x, y)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.shadowRoot && el.shadowRoot.elementsFromPoint) walk(el.shadowRoot, depth + 1);
        out.push(el);
      }
    };
    walk(document, 0);
    return out;
  }

  // closest() that also climbs out of shadow roots
  function closestDeep(el, sel) {
    let n = el;
    while (n) {
      if (n.nodeType === 1 && n.matches(sel)) return n;
      n = n.parentNode || (n instanceof ShadowRoot ? n.host : null);
      if (n instanceof ShadowRoot) n = n.host;
    }
    return null;
  }

  function targetAtPoint(x, y) {
    const top = document.elementFromPoint(x, y);
    if (bar && top && bar.contains(top)) return target;
    const els = deepElementsFromPoint(x, y);
    for (const el of els) if (isPlayerTag(el)) return { el: playerBox(el), type: "video" };
    for (const el of els) if (isPostImage(el)) return { el, type: "image" };
    return null;
  }

  // Use the outer player element so the button sits on the visible frame
  function playerBox(el) {
    return closestDeep(el, "shreddit-player, shreddit-player-2, shreddit-player-3") || el;
  }

  function update() {
    raf = 0;
    const t = targetAtPoint(lastX, lastY);
    if (!t || !target || t.el !== target.el) target = t;
    placeBar();
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
    const act = { KeyD: "main", KeyA: "audio", KeyS: "all" }[e.code];
    if (!act || !target) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.tagName.includes("COMPOSER"))) return;
    e.preventDefault();
    e.stopPropagation();
    run(act, target);
  }, true);

  // ======================= Post link =======================
  function cleanLink(href) {
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/^(.*?\/comments\/[a-z0-9]+)/i);
      return m ? m[1] + "/" : null;
    } catch (e) {
      return null;
    }
  }

  function permalinkFor(el) {
    const post = closestDeep(el, POST_SEL);
    if (post) {
      const l = post.getAttribute("permalink") || post.getAttribute("data-permalink") || post.getAttribute("content-href");
      const c = l && cleanLink(l);
      if (c) return c;
    }
    let p = el.parentElement;
    for (let i = 0; p && i < 12; i++, p = p.parentElement) {
      const links = new Set([...p.querySelectorAll('a[href*="/comments/"]')].map((a) => cleanLink(a.getAttribute("href"))).filter(Boolean));
      if (links.size === 1) return [...links][0];
      if (links.size > 1) break;
    }
    return cleanLink(location.href);
  }

  const postId = (link) => ((link || "").match(/\/comments\/([a-z0-9]+)/i) || [])[1];

  // ======================= Post data =======================
  // Items: { type: "video", mpd, fallback, hasAudio } | { type: "video", direct, ids } | { type: "image", url, ids }
  const unesc = (u) => (u || "").replace(/&amp;/g, "&");

  function parseItems(post) {
    if (!post) return [];
    const src = (post.crosspost_parent_list && post.crosspost_parent_list[0]) || post;
    const items = [];
    const rv = src.secure_media?.reddit_video || src.media?.reddit_video;
    if (rv) {
      items.push({ type: "video", mpd: unesc(rv.dash_url), fallback: unesc(rv.fallback_url), hasAudio: rv.has_audio !== false, ids: [] });
      return items;
    }
    if (src.gallery_data && src.media_metadata) {
      for (const g of src.gallery_data.items || []) {
        const m = src.media_metadata[g.media_id];
        if (!m || m.status === "failed") continue;
        if (m.e === "AnimatedImage") {
          items.push({ type: "video", direct: unesc(m.s?.mp4 || m.s?.gif), ids: [g.media_id] });
        } else {
          const ext = ((m.m || "image/jpg").split("/")[1] || "jpg").replace("jpeg", "jpg");
          items.push({ type: "image", url: `https://i.redd.it/${g.media_id}.${ext}`, alt: unesc(m.s?.u), ids: [g.media_id] });
        }
      }
      return items;
    }
    const url = unesc(src.url_overridden_by_dest || src.url);
    const prev = src.preview?.images?.[0];
    if (/\.gifv?(\?|$)/i.test(url) || src.preview?.reddit_video_preview) {
      const mp4 = unesc(prev?.variants?.mp4?.source?.url);
      const rvp = src.preview?.reddit_video_preview;
      if (rvp && !mp4) items.push({ type: "video", mpd: unesc(rvp.dash_url), fallback: unesc(rvp.fallback_url), hasAudio: false, ids: [] });
      else items.push({ type: "video", direct: mp4 || url, ids: [] });
      return items;
    }
    if (/i\.redd\.it|i\.imgur\.com/.test(url) && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) {
      items.push({ type: "image", url, alt: unesc(prev?.source?.url), ids: [url.split("/").pop().split(".")[0]] });
      return items;
    }
    if (prev?.source?.url) items.push({ type: "image", url: unesc(prev.source.url), ids: [] });
    return items;
  }

  async function fetchPost(link) {
    const r = await fetch(`${location.origin}${link}.json?raw_json=1`, { credentials: "include", headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("json-" + r.status);
    const json = await r.json();
    return parseItems(json?.[0]?.data?.children?.[0]?.data);
  }

  function getItems(link) {
    if (!link) return Promise.resolve([]);
    if (!cache.has(link)) {
      const entry = { settled: false, items: [], err: "" };
      entry.promise = fetchPost(link)
        .catch((e) => {
          entry.err = e.message || "err";
          return [];
        })
        .then((items) => {
          entry.items = items;
          entry.settled = true;
          if (target) placeBar();
          return items;
        });
      cache.set(link, entry);
    }
    return cache.get(link).promise;
  }

  let prefetchTimer = 0;
  function prefetch(link) {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => getItems(link), 200);
  }

  // ======================= Matching =======================
  function srcOf(el) {
    if (el.tagName === "IMG") return el.currentSrc || el.src || "";
    return "";
  }

  function matchItem(items, t) {
    const same = items.filter((i) => i.type === t.type || (t.type === "video" && i.direct));
    const pool = same.length ? same : items;
    const src = srcOf(t.el);
    if (src) {
      const hit = pool.find((i) => i.ids.some((id) => id && src.includes(id)));
      if (hit) return hit;
    }
    // Gallery: the slide's position among the post's images
    const post = closestDeep(t.el, POST_SEL) || closestDeep(t.el, "gallery-carousel");
    if (post && pool.length > 1) {
      const imgs = [...post.querySelectorAll("img")].filter(isPostImage);
      const idx = imgs.indexOf(t.el);
      if (idx >= 0 && idx < pool.length) return pool[idx];
    }
    return pool[0] || null;
  }

  // Full-size link from a preview image, used when the post data is not available
  function imageFromSrc(src) {
    const m = src && src.match(/^https:\/\/preview\.redd\.it\/(?:[^/?]*-)?([a-z0-9]+)\.(\w+)/i);
    return m ? [`https://i.redd.it/${m[1]}.${m[2]}`, src] : src ? [src] : [];
  }

  // The v.redd.it id written on the player (src, poster or packaged media attributes)
  function playerVideoId(el) {
    const nodes = [el, ...(el.shadowRoot ? el.shadowRoot.querySelectorAll("video, source") : []), ...el.querySelectorAll("video, source")];
    for (const n of nodes) {
      for (const a of n.attributes || []) {
        const m = a.value && a.value.match(/v\.redd\.it\\?\/([a-z0-9]{8,})/i);
        if (m) return m[1];
      }
    }
    return null;
  }

  // ======================= Actions =======================
  const pad = (n) => String(n).padStart(2, "0");
  const send = (msg) => chrome.runtime.sendMessage(msg);

  async function downloadItem(item, name) {
    if (item.type === "image") return send({ type: "pvd-download", candidates: [item.url, item.alt].filter(Boolean), name });
    if (item.direct) return send({ type: "pvd-download", candidates: [item.direct], name });
    return send({ type: "rd-video", mpd: item.mpd, fallback: item.fallback, hasAudio: item.hasAudio, name });
  }

  async function run(act, t) {
    if (busy) return;
    busy = true;
    bar && bar.classList.add("pvd-busy");
    try {
      const link = permalinkFor(t.el);
      toast("جاري التجهيز...", "busy");
      const items = await getItems(link);
      const err = cache.get(link)?.err;
      const base = `reddit-${postId(link) || Date.now()}`;

      if (act === "all" && items.length > 1) {
        let ok = 0;
        for (let i = 0; i < items.length; i++) {
          toast(`جاري تحميل ${i + 1} من ${items.length}...`, "busy");
          const res = await downloadItem(items[i], `${base}-${pad(i + 1)}`);
          if (res && res.ok) ok++;
        }
        toast(ok === items.length ? `تم تحميل ${ok} ملف في Downloads/Reddit` : `اتحمل ${ok} من ${items.length}`, ok ? "ok" : "err");
        return;
      }

      const item = matchItem(items, t);
      const idx = item && items.length > 1 ? items.indexOf(item) : -1;
      const name = idx >= 0 ? `${base}-${pad(idx + 1)}` : base;

      if (act === "audio") {
        if (!item || item.type !== "video" || item.direct) return toast("مفيش صوت هنا", "err");
        toast("جاري تحميل الصوت...", "busy");
        const res = await send({ type: "rd-audio", mpd: item.mpd, fallback: item.fallback, name });
        if (res && res.ok) toast("الصوت اتحمل M4A في Downloads/Reddit", "ok");
        else if (res && res.error === "no-audio") toast("الفيديو ده مفيهوش صوت", "err");
        else toast(`تحميل الصوت فشل (${res?.error || "no-reply"})`, "err");
        return;
      }

      let res;
      if (item) {
        toast(item.type === "video" && !item.direct && item.hasAudio ? "جاري التحميل ودمج الصوت..." : "جاري التحميل...", "busy");
        res = await downloadItem(item, name);
      } else if (t.type === "image") {
        toast("جاري التحميل...", "busy");
        res = await send({ type: "pvd-download", candidates: imageFromSrc(srcOf(t.el)), name });
      } else if (playerVideoId(t.el)) {
        const vid = playerVideoId(t.el);
        toast("جاري التحميل ودمج الصوت...", "busy");
        res = await send({ type: "rd-video", mpd: `https://v.redd.it/${vid}/DASHPlaylist.mpd`, fallback: `https://v.redd.it/${vid}/DASH_720.mp4`, hasAudio: true, name });
      } else {
        return toast(`الفيديو ده مش مرفوع على Reddit نفسه، أو مش لاقي بياناته (${err || "no-data"})`, "err");
      }

      if (res && res.ok && res.muxFailed) toast(`الفيديو اتحمل بس من غير صوت، الدمج فشل (${res.muxFailed})`, "err");
      else if (res && res.ok && res.noAudio) toast("تم التحميل (الفيديو أصلاً من غير صوت)", "ok");
      else if (res && res.ok) toast("تم التحميل في Downloads/Reddit", "ok");
      else toast(`التحميل فشل (${res?.error || "no-reply"}${err ? " " + err : ""})`, "err");
    } catch (e) {
      toast("حصل خطأ، اعمل Refresh للصفحة وجرب تاني", "err");
    } finally {
      busy = false;
      bar && bar.classList.remove("pvd-busy");
    }
  }

  console.debug("[Fo2sh Reddit Downloader]", VERSION);
})();
