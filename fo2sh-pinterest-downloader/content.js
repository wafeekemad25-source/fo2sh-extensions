(() => {
  const VERSION = "1.4.1";
  const CARD_SEL = '[data-grid-item="true"], [data-test-id="pin"], [role="listitem"]';

  let target = null; // { el, type: "video" | "image" }
  let bar = null;
  let busy = false;
  let lastX = 0, lastY = 0, raf = 0;
  const cache = new Map(); // pinId -> Promise<items[]>

  // ======================= UI =======================
  const ICON_DL =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>';
  const ICON_AUDIO =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>';
  const ICON_ALL =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';

  const ICON_FRAME =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg>';

  function makeBar() {
    bar = document.createElement("div");
    bar.className = "pvd-bar";
    bar.innerHTML = `
      <button type="button" class="pvd-b" data-act="main" title="D">${ICON_DL}<span>MP4</span></button>
      <button type="button" class="pvd-b" data-act="audio" title="A">${ICON_AUDIO}<span>صوت</span></button>
      <button type="button" class="pvd-b" data-act="frame" title="F">${ICON_FRAME}<span>فريم</span></button>
      <button type="button" class="pvd-b" data-act="all" title="S">${ICON_ALL}<span>الكل</span></button>`;
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      e.preventDefault();
      e.stopPropagation();
      if (b && target) run(b.dataset.act, target);
    }, true);
    ["mousedown", "mouseup", "pointerdown", "pointerup"].forEach((t) =>
      bar.addEventListener(t, (e) => e.stopPropagation(), true)
    );
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
    t._h = setTimeout(() => t.classList.remove("pvd-show"), kind === "busy" ? 60000 : 3200);
  }

  function placeBar() {
    if (!bar) makeBar();
    if (!target || !target.el.isConnected) {
      bar.classList.remove("pvd-show");
      return;
    }
    const r = target.el.getBoundingClientRect();
    if (r.width < 100 || r.height < 100) {
      bar.classList.remove("pvd-show");
      return;
    }
    const isVideo = target.type === "video";
    bar.querySelector('[data-act="main"] span').textContent = isVideo ? "MP4" : "صورة";
    bar.querySelector('[data-act="audio"]').style.display = isVideo ? "" : "none";
    bar.querySelector('[data-act="frame"]').style.display = isVideo ? "" : "none";
    const allBtn = bar.querySelector('[data-act="all"]');
    const id = pinIdFor(target.el);
    const known = id && cache.get(id);
    const count = known && known.settled ? known.items.length : 0;
    allBtn.style.display = count > 1 ? "" : "none";
    allBtn.querySelector("span").textContent = `الكل (${count})`;
    if (id && !known) prefetch(id);

    bar.style.top = Math.max(8, r.top + 10) + "px";
    bar.style.left = "0px";
    bar.classList.add("pvd-show");
    const w = bar.offsetWidth;
    bar.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w - 10)) + "px";
  }

  // ======================= Hover =======================
  function isPinImage(el) {
    if (el.tagName !== "IMG") return false;
    const src = el.currentSrc || el.src || "";
    if (!/i\.pinimg\.com\//.test(src) || /\/(75x75|30x30|60x60|140x140)(_RS)?\//.test(src)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 120 && r.height >= 120;
  }

  function targetAtPoint(x, y) {
    const els = document.elementsFromPoint(x, y);
    if (bar && bar.contains(els[0])) return target;
    for (const el of els) if (el.tagName === "VIDEO") return { el, type: "video" };
    for (const el of els) {
      const card = el.closest && el.closest(CARD_SEL);
      if (card) {
        const v = card.querySelector("video");
        if (v) return { el: v, type: "video" };
        break;
      }
    }
    for (const el of els) if (isPinImage(el)) return { el, type: "image" };
    return null;
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
    const act = { KeyD: "main", KeyA: "audio", KeyS: "all", KeyF: "frame" }[e.code];
    if (!act || !target) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if ((act === "audio" || act === "frame") && target.type !== "video") return;
    e.preventDefault();
    e.stopPropagation();
    run(act, target);
  }, true);

  // ======================= Pin ID =======================
  function idFromHref(href) {
    const m = href && href.match(/\/pin\/([\w-]+)/);
    return m ? m[1] : null;
  }

  function pinIdFor(el) {
    const card = el.closest(CARD_SEL);
    if (card) {
      const a = card.querySelector('a[href*="/pin/"]');
      const id = a && idFromHref(a.getAttribute("href"));
      if (id) return id;
    }
    const pageId = idFromHref(location.pathname);
    if (pageId) return pageId;
    let p = el.parentElement;
    for (let i = 0; p && i < 14; i++, p = p.parentElement) {
      const ids = new Set(
        [...p.querySelectorAll('a[href*="/pin/"]')].map((a) => idFromHref(a.getAttribute("href"))).filter(Boolean)
      );
      if (ids.size === 1) return [...ids][0];
      if (ids.size > 1) break;
    }
    return null;
  }

  // ======================= Pin data =======================
  // An item is one slide of the pin:
  //   { type: "video", mp4: [{url, px}], hls: [url], hashes: Set, duration (s) }
  //   { type: "image", url, hashes: Set }
  const HASH_RE = /\/([0-9a-f]{32})(?=[._\/?]|$)/gi;

  function hashesOf(str) {
    const out = [];
    if (typeof str !== "string") return out;
    for (const m of str.matchAll(HASH_RE)) out.push(m[1].toLowerCase());
    return out;
  }

  function findVideoList(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 8) return null;
    if (node.video_list && typeof node.video_list === "object") return node.video_list;
    for (const k in node) {
      const r = findVideoList(node[k], depth + 1);
      if (r) return r;
    }
    return null;
  }

  function videoItem(list) {
    const it = { type: "video", mp4: [], hls: [], hashes: new Set(), duration: 0 };
    for (const k in list) {
      const v = list[k];
      if (!v || typeof v.url !== "string") continue;
      if (/\.mp4(\?|$)/i.test(v.url)) it.mp4.push({ url: v.url, px: (v.width || 0) * (v.height || 0) });
      else if (/\.m3u8(\?|$)/i.test(v.url)) it.hls.push(v.url);
      hashesOf(v.url).forEach((x) => it.hashes.add(x));
      hashesOf(v.thumbnail).forEach((x) => it.hashes.add(x));
      if (v.duration && !it.duration) it.duration = v.duration / 1000;
    }
    return it.mp4.length || it.hls.length ? it : null;
  }

  function imageItem(images) {
    if (!images || typeof images !== "object") return null;
    let best = images.orig || images.originals;
    if (!best || !best.url) {
      best = null;
      for (const k in images) {
        const v = images[k];
        if (v && v.url && (!best || (v.width || 0) > (best.width || 0))) best = v;
      }
    }
    if (!best || !best.url) return null;
    return { type: "image", url: best.url, hashes: new Set(hashesOf(best.url)) };
  }

  function slideItem(node) {
    const vl = findVideoList(node);
    if (vl) return videoItem(vl);
    const imgs = node.images || (node.image && node.image.images);
    return imageItem(imgs);
  }

  function parseItems(data) {
    let items = [];
    const slots = data?.carousel_data?.carousel_slots;
    const pages = data?.story_pin_data?.pages;
    if (Array.isArray(slots) && slots.length) {
      items = slots.map(slideItem);
    } else if (Array.isArray(pages) && pages.length) {
      for (const p of pages) for (const b of p.blocks || []) items.push(slideItem(b));
    }
    items = items.filter(Boolean);
    if (!items.length && data) {
      const vl = data.videos?.video_list || findVideoList(data.videos);
      const it = vl ? videoItem(vl) : imageItem(data.images);
      if (it) items.push(it);
    }
    // Dedupe
    const out = [];
    for (const it of items) {
      if (!out.some((o) => [...it.hashes].some((x) => o.hashes.has(x)))) out.push(it);
    }
    return out;
  }

  const diag = new Map(); // pinId -> { api, html }

  const VIDEO_URL_RE = /https?:(?:\\?\/){2}v\d*\.pinimg\.com(?:\\?\/)videos(?:\\?\/)[^"'\s<>]+?\.(?:mp4|m3u8)/g;

  // Reads every video link written inside the pin's own HTML page.
  async function fetchHtmlVideos(id) {
    const r = await fetch(`${location.origin}/pin/${id}/`, { credentials: "include" });
    if (!r.ok) throw new Error("http" + r.status);
    const text = (await r.text()).replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
    const urls = [...new Set(text.match(VIDEO_URL_RE) || [])].map((u) => u.replace(/\\/g, ""));
    const byHash = new Map();
    for (const u of urls) {
      const h = hashesOf(u)[0] || u;
      if (!byHash.has(h)) byHash.set(h, { type: "video", mp4: [], hls: [], hashes: new Set(hashesOf(u)), duration: 0 });
      const it = byHash.get(h);
      if (/\.mp4$/i.test(u)) it.mp4.push({ url: u, px: /1080p/.test(u) ? 2e6 : /720p/.test(u) ? 1e6 : 1 });
      else it.hls.push(u);
    }
    return [...byHash.values()];
  }

  async function fetchApiKey(id, key, d) {
    const data = JSON.stringify({ options: { id, field_set_key: key }, context: {} });
    const url = `${location.origin}/resource/PinResource/get/?source_url=${encodeURIComponent(`/pin/${id}/`)}&data=${encodeURIComponent(data)}`;
    try {
      const r = await fetch(url, {
        credentials: "include",
        headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "X-Pinterest-PWS-Handler": "www/pin/[id].js" }
      });
      if (!r.ok) { d.api = "http" + r.status; return []; }
      return parseItems((await r.json())?.resource_response?.data);
    } catch (e) {
      d.api = "err";
      return [];
    }
  }

  async function fetchApi(id, d) {
    const all = await Promise.all(["detailed", "auth_web_main_pin", "unauth_react_main_pin"].map((k) => fetchApiKey(id, k, d)));
    const best = all.find((items) => items.some((i) => i.type === "video")) || all.find((items) => items.length) || [];
    if (best.length) d.api = best.length;
    else if (d.api === "-") d.api = 0;
    return best;
  }

  async function fetchPin(id) {
    const d = { api: "-", html: "-" };
    diag.set(id, d);
    const htmlP = fetchHtmlVideos(id).catch((e) => e);
    const items = await fetchApi(id, d);
    try {
      const htmlVids = await htmlP;
      if (htmlVids instanceof Error) throw htmlVids;
      d.html = htmlVids.length;
      for (const hv of htmlVids) {
        const same = items.find((i) => i.type === "video" && [...hv.hashes].some((x) => i.hashes.has(x)));
        if (same) {
          same.mp4.push(...hv.mp4);
          same.hls.push(...hv.hls);
        } else if (!items.some((i) => i.type === "video")) {
          items.push(hv);
        }
      }
      // Only HTML videos found: keep them, drop the cover image of a video pin
      if (!items.some((i) => i.type === "video") && htmlVids.length) items.push(...htmlVids);
    } catch (e) {
      d.html = e.message || "err";
    }
    return items;
  }

  function getItems(id) {
    if (!id) return Promise.resolve([]);
    if (!cache.has(id)) {
      const entry = { settled: false, items: [] };
      entry.promise = fetchPin(id).then((items) => {
        entry.items = items;
        entry.settled = true;
        if (target) placeBar();
        return items;
      });
      cache.set(id, entry);
    }
    return cache.get(id).promise;
  }

  let prefetchTimer = 0;
  function prefetch(id) {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => getItems(id), 250);
  }

  // ======================= Matching the slide on screen =======================
  function elementHashes(el) {
    const strs = [el.poster, el.currentSrc, el.src, el.srcset, ...[...el.querySelectorAll("source")].map((s) => s.src)];
    return [...new Set(strs.flatMap(hashesOf))];
  }

  function recentNetworkHashes() {
    const list = (window.__pvdNet || []).slice().sort((a, b) => b.t - a.t);
    const segs = list.filter((e) => !/\.m3u8(\?|$)/.test(e.url));
    const out = [];
    for (const e of segs.concat(list)) for (const x of hashesOf(e.url)) if (!out.includes(x)) out.push(x);
    return out;
  }

  function byDuration(items, video) {
    const d = video.duration;
    if (!isFinite(d) || d <= 0) return null;
    const scored = items.filter((i) => i.type === "video" && i.duration).map((i) => ({ i, diff: Math.abs(i.duration - d) }));
    scored.sort((a, b) => a.diff - b.diff);
    if (!scored.length || scored[0].diff > 0.35) return null;
    if (scored[1] && scored[1].diff - scored[0].diff < 0.15) return null;
    return scored[0].i;
  }

  function domIndex(el, type) {
    let p = el.parentElement;
    const tag = type === "video" ? "video" : "img";
    for (let i = 0; p && i < 12; i++, p = p.parentElement) {
      const all = [...p.querySelectorAll(tag)].filter((x) => type === "video" || isPinImage(x));
      if (all.length > 1) {
        if (p.querySelectorAll('a[href*="/pin/"]').length > 1 && !idFromHref(location.pathname)) return -1;
        return all.indexOf(el);
      }
    }
    return -1;
  }

  // Returns { item, sure }
  function matchItem(items, t) {
    const same = items.filter((i) => i.type === t.type);
    if (!same.length) return { item: null, sure: false };
    const own = elementHashes(t.el);
    let it = same.find((i) => own.some((x) => i.hashes.has(x)));
    if (it) return { item: it, sure: true };
    if (same.length === 1) return { item: same[0], sure: true };
    if (t.type === "video") {
      it = byDuration(same, t.el);
      if (it) return { item: it, sure: true };
      if (!t.el.paused) {
        for (const x of recentNetworkHashes()) {
          it = same.find((i) => i.hashes.has(x));
          if (it) return { item: it, sure: true };
        }
      }
    }
    const idx = domIndex(t.el, t.type);
    if (idx > 0 && idx < same.length) return { item: same[idx], sure: false };
    return { item: same[0], sure: false };
  }

  // ======================= URL candidates =======================
  function hlsToMp4(u) {
    if (!u || !/\.m3u8(\?|$)/i.test(u)) return [];
    const base = u.split("?")[0];
    const out = [];
    if (/\/hls\//.test(base)) {
      for (const [dir, suf] of [["1080p", ""], ["720p", ""], ["expMp4", "_t5"], ["expMp4", "_t4"], ["expMp4", "_t3"], ["expMp4", "_t2"], ["expMp4", "_t1"]]) {
        out.push(base.replace("/hls/", `/${dir}/`).replace(/(_\d+w|_t\d)?\.m3u8$/i, `${suf}.mp4`));
      }
    }
    const m = base.match(/\/videos\/(?:[^/]+\/)*?((?:[0-9a-f]{2}\/){3})?([0-9a-f]{32})[^/]*\.m3u8$/i);
    if (m) {
      const dirs = m[1] || "", h = m[2], host = "https://v1.pinimg.com/videos";
      if (dirs) out.push(`${host}/mc/1080p/${dirs}${h}.mp4`, `${host}/mc/720p/${dirs}${h}.mp4`);
      out.push(`${host}/iht/expMp4/${h}_t5.mp4`, `${host}/iht/expMp4/${h}_t4.mp4`, `${host}/iht/expMp4/${h}_t3.mp4`);
    }
    return [...new Set(out)];
  }

  // HLS playlists for this video: from the pin data, the player, and what the page loaded.
  function hlsFor(item, el) {
    const list = [];
    if (item) list.push(...item.hls);
    if (el) for (const u of [el.currentSrc, el.src]) if (u && /\.m3u8(\?|$)/i.test(u)) list.push(u);
    const net = (window.__pvdNet || []).slice().sort((a, b) => b.t - a.t).map((e) => e.url).filter((u) => /\.m3u8(\?|$)/i.test(u));
    const mine = item ? net.filter((u) => hashesOf(u).some((x) => item.hashes.has(x))) : [];
    list.push(...mine);
    if (!item && el && !el.paused) list.push(...net.slice(0, 3));
    // Master playlists first: they list every quality
    const uniq = [...new Set(list)];
    return uniq.sort((a, b) => (/_\d+w\.m3u8|_t\d\.m3u8/.test(a) ? 1 : 0) - (/_\d+w\.m3u8|_t\d\.m3u8/.test(b) ? 1 : 0));
  }

  // Video files the page itself played, newest first.
  function networkVideoUrls() {
    const list = (window.__pvdNet || []).slice().sort((a, b) => b.t - a.t);
    const out = [];
    for (const e of list) {
      if (/\.mp4(\?|$)/i.test(e.url) && !/\.m4s/.test(e.url)) out.push(e.url.split("?")[0]);
      else if (/\.m3u8(\?|$)/i.test(e.url)) out.push(...hlsToMp4(e.url));
      if (out.length > 30) break;
    }
    return out;
  }

  function posterToMp4(poster) {
    const m = poster && poster.match(/\/videos\/thumbnails\/originals\/((?:[0-9a-f]{2}\/){3}[0-9a-f]+)/i);
    return m ? [`https://v1.pinimg.com/videos/mc/1080p/${m[1]}.mp4`, `https://v1.pinimg.com/videos/mc/720p/${m[1]}.mp4`] : [];
  }

  function videoCandidates(item, el) {
    const list = [];
    if (item) {
      const mp4 = item.mp4.slice().sort((a, b) => b.px - a.px);
      for (const m of mp4) {
        if (/\/720p\//.test(m.url)) list.push(m.url.replace("/720p/", "/1080p/"));
        list.push(m.url);
      }
      item.hls.forEach((h) => list.push(...hlsToMp4(h)));
    }
    if (el) {
      const srcs = [el.currentSrc, el.src, ...[...el.querySelectorAll("source")].map((s) => s.src)].filter(
        (s) => s && !s.startsWith("blob:")
      );
      srcs.forEach((s) => (/\.mp4(\?|$)/i.test(s) ? list.push(s) : list.push(...hlsToMp4(s))));
      list.push(...posterToMp4(el.poster));
      if (!el.paused) {
        const net = networkVideoUrls();
        const mine = item ? net.filter((u) => hashesOf(u).some((x) => item.hashes.has(x))) : [];
        list.push(...(mine.length ? mine : net.slice(0, 10)));
      }
    }
    return [...new Set(list)];
  }

  function largestSrc(el) {
    let best = el.currentSrc || el.src;
    if (el.srcset) {
      let bw = 0;
      for (const part of el.srcset.split(",")) {
        const [u, d] = part.trim().split(/\s+/);
        const w = parseFloat(d) || 0;
        if (u && w >= bw) { bw = w; best = u; }
      }
    }
    return best;
  }

  function imageCandidates(item, el) {
    const list = [];
    if (item) list.push(item.url);
    if (el) {
      const src = largestSrc(el);
      const m = src && src.match(/^(https:\/\/i\.pinimg\.com\/)[^/]+\/(.+?)\.(\w+)(\?.*)?$/);
      if (m) {
        for (const ext of [m[3], "jpg", "png", "webp", "gif"]) list.push(`${m[1]}originals/${m[2]}.${ext}`);
        list.push(`${m[1]}736x/${m[2]}.${m[3]}`);
        list.push(src);
      }
    }
    return [...new Set(list)];
  }

  function itemCandidates(item) {
    return item.type === "video" ? videoCandidates(item, null) : imageCandidates(item, null);
  }

  // ======================= Actions =======================
  const pad = (n) => String(n).padStart(2, "0");
  const send = (msg) => chrome.runtime.sendMessage(msg);

  async function run(act, t) {
    if (busy) return;
    busy = true;
    bar && bar.classList.add("pvd-busy");
    try {
      const id = pinIdFor(t.el);
      const items = await getItems(id);
      const base = id ? `pin-${id}` : `pinterest-${Date.now()}`;

      if (act === "all") {
        if (items.length < 2) {
          busy = false;
          return run("main", t);
        }
        let ok = 0;
        for (let i = 0; i < items.length; i++) {
          toast(`جاري تحميل ${i + 1} من ${items.length}...`, "busy");
          const it = items[i];
          const res = await send({ type: "pvd-download", candidates: itemCandidates(it), hls: it.type === "video" ? it.hls : [], name: `${base}-${pad(i + 1)}` });
          if (res && res.ok) ok++;
        }
        toast(ok === items.length ? `تم تحميل ${ok} ملف في Downloads/Pinterest` : `اتحمل ${ok} من ${items.length}`, ok ? "ok" : "err");
        return;
      }

      const { item, sure } = matchItem(items, t);
      const idx = item && items.length > 1 ? items.indexOf(item) : -1;
      const name = idx >= 0 ? `${base}-${pad(idx + 1)}` : base;
      const candidates = t.type === "video" ? videoCandidates(item, t.el) : imageCandidates(item, t.el);
      const hls = t.type === "video" ? hlsFor(item, t.el) : [];
      if (act === "frame") return await grabFrame(t.el, candidates, name, hls);
      if (!candidates.length && !hls.length) {
        const d = diag.get(id) || {};
        toast(`مش لاقي رابط للملف ده (api:${d.api ?? "-"} html:${d.html ?? "-"} links:0)`, "err");
        return;
      }

      if (act === "audio") {
        toast("جاري استخراج الصوت...", "busy");
        const res = await send({ type: "pvd-audio", candidates, hls, name });
        if (res && res.ok) toast(`الصوت اتحمل ${res.kind || "WAV"} في Downloads/Pinterest`, "ok");
        else if (res && res.error === "no-audio") toast("الفيديو ده مفيهوش صوت", "err");
        else toast(`استخراج الصوت فشل (${(res && res.error) || "no-response"})`, "err");
        return;
      }

      toast("جاري التحميل...", "busy");
      const res = await send({ type: "pvd-download", candidates, hls, name });
      if (res && res.ok && sure) toast(res.viaHls ? "تم التحميل في Downloads/Pinterest (اتجمع من أجزاء الفيديو بأعلى جودة)" : "تم التحميل في Downloads/Pinterest", "ok");
      else if (res && res.ok) toast("اتحمل، بس مش متأكد 100% إنه نفس الفيديو. شغّله ثانية وحمّل تاني لو طلع غلط", "ok");
      else {
        const d = diag.get(id) || {};
        toast(`التحميل فشل (api:${d.api ?? "-"} html:${d.html ?? "-"} links:${candidates.length} ${res?.error || "no-reply"})`, "err");
      }
    } catch (e) {
      toast("حصل خطأ، اعمل Refresh للصفحة وجرب تاني", "err");
    } finally {
      busy = false;
      bar && bar.classList.remove("pvd-busy");
    }
  }

  // ======================= Frame grab =======================
  const two = (n) => String(Math.floor(n)).padStart(2, "0");
  const stamp = (t) => `${two(t / 60)}-${two(t % 60)}-${two((t % 1) * 100)}`;

  // Takes the frame on screen at full quality: from the original MP4 when possible,
  // otherwise from the player in the page, otherwise a cropped screenshot.
  async function grabFrame(video, candidates, baseName, hls) {
    const time = video.currentTime || 0;
    const name = `${baseName}-frame-${stamp(time)}`;
    toast("جاري أخذ الفريم...", "busy");
    const mp4 = candidates.filter((u) => /\.mp4(\?|$)/i.test(u));
    if (mp4.length || hls.length) {
      const res = await send({ type: "pvd-frame", candidates: mp4, hls, time, name });
      if (res && res.ok) return toast(`الفريم اتحفظ PNG ${res.w}×${res.h} في Downloads/Pinterest`, "ok");
    }
    // Fallback 1: the player itself (quality of what is playing now)
    try {
      if (!video.videoWidth) throw new Error("no-frame");
      const c = document.createElement("canvas");
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext("2d").drawImage(video, 0, 0);
      const dataUrl = c.toDataURL("image/png");
      const res = await send({ type: "pvd-save-data", dataUrl, name, ext: "png" });
      if (res && res.ok) return toast(`الفريم اتحفظ PNG ${c.width}×${c.height} (بجودة اللي شغال دلوقتي)`, "ok");
    } catch (e) {}
    // Fallback 2: screenshot of the video area
    const r = video.getBoundingClientRect();
    bar && bar.classList.remove("pvd-show");
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    const res = await send({ type: "pvd-shot", rect: { x: r.left, y: r.top, w: r.width, h: r.height }, dpr: devicePixelRatio, name });
    if (res && res.ok) return toast(`الفريم اتحفظ PNG ${res.w}×${res.h} (سكرين شوت للشاشة)`, "ok");
    toast(`أخذ الفريم فشل (${(res && res.error) || "no-reply"})`, "err");
  }

  // Progress from the background while it builds a video from HLS parts
  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === "pvd-progress" && busy) toast(m.text, "busy");
  });

  console.debug("[Fo2sh Pinterest Downloader]", VERSION);
})();
