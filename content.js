// content.js — DOM 层素材提取：图片（含深挖原图）、视频、文字
(function () {
  if (window.__snifferInjected) return;
  window.__snifferInjected = true;

  const abs = (u) => {
    if (!u) return '';
    try { return new URL(u, location.href).href; } catch (e) { return ''; }
  };
  const skip = (u) => !u || /^(data|blob|about|chrome-extension):/i.test(u);

  // ---------- 深挖原图：生成候选大图地址 ----------
  const AMZ_HOST = /(media-amazon|images-amazon|ssl-images-amazon|media\.amazon)/i;

  function candidatesFor(url) {
    const out = [];
    const push = (u) => { if (u && u !== url && !out.includes(u)) out.push(u); };

    if (AMZ_HOST.test(url)) {
      push(url.replace(/\._[A-Z0-9_,]+_\./, '.'));
      [1500, 2000, 2500].forEach((s) => {
        push(url.replace(/_S[XYL]\d+_/g, `_SL${s}_`).replace(/_SS\d+_/g, `_SL${s}_`).replace(/_QL\d+_/g, `_SL${s}_`));
      });
      push(url.replace(/_S[XYL]\d+_/g, '').replace(/_SS\d+_/g, '').replace(/_QL\d+_/g, ''));
    }

    // Shopify / WordPress / 通用后缀缩放
    push(url.replace(/_\d+x\d*(?=\.(jpe?g|png|webp))/i, ''));
    push(url.replace(/-\d{2,4}x\d{2,4}(?=\.(jpe?g|png|webp))/i, ''));
    push(url.replace(/\/\d+x\d+(?=\/)/i, '/'));
    push(url.replace(/\/thumb(s)?\//i, '/'));

    // Cloudinary：/upload/w_400,h_400,c_fill/xxx.jpg -> /upload/xxx.jpg
    push(url.replace(/\/upload\/[^/]*(?=\/[^/]+\.(jpe?g|png|webp|avif))/i, '/upload/'));

    try {
      const u = new URL(url);
      // 尺寸 / 质量参数：删掉或调大
      const sizeKeys = ['w', 'width', 'imwidth', 'imheight', 'h', 'height', 'size', 'q', 'quality', 'wid', 'hei', 'fit', 'dpr'];
      sizeKeys.forEach((k) => {
        if (u.searchParams.has(k)) {
          const c = new URL(url);
          c.searchParams.delete(k);
          push(c.href);
          if (['w', 'width', 'imwidth'].includes(k)) {
            const big = new URL(url);
            big.searchParams.set(k, '2000');
            push(big.href);
          }
        }
      });
      // Unsplash / imgix：去掉全部查询参数通常就是原图
      if (/(unsplash|imgix|pexels|cloudfront|akamaized)/i.test(u.hostname) && u.search) {
        const c = new URL(url); c.search = ''; push(c.href);
      }
    } catch (e) { }

    return out.slice(0, 10);
  }

  function probe(src, timeout = 3500) {
    return new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout);
      img.onload = () => {
        if (done) return;
        done = true; clearTimeout(t);
        resolve({ w: img.naturalWidth, h: img.naturalHeight, url: src });
      };
      img.onerror = () => { if (!done) { done = true; clearTimeout(t); resolve(null); } };
      try { img.referrerPolicy = 'no-referrer'; img.src = src; } catch (e) { }
    });
  }

  // ---------- 图片采集 ----------
  function collectImages() {
    const map = new Map();
    const add = (url, extra) => {
      const u = abs(url);
      if (skip(u)) return;
      const key = u;
      if (map.has(key)) {
        const it = map.get(key);
        it.w = Math.max(it.w, extra.w || 0);
        it.h = Math.max(it.h, extra.h || 0);
        if (extra.srcset) it.srcset = extra.srcset;
        if (extra.posterUrl) it.posterUrl = extra.posterUrl;
        return;
      }
      map.set(key, { kind: 'image', url: u, from: 'dom', w: 0, h: 0, ...extra });
    };

    document.querySelectorAll('img').forEach((img) => {
      const src = img.currentSrc || img.src || img.getAttribute('data-old-hires') || '';
      if (!skip(src)) {
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        const srcset = img.getAttribute('srcset') || '';
        add(src, { w, h, srcset, alt: (img.alt || '').slice(0, 80) });
        // Amazon 动态图集
        const dyn = img.getAttribute('data-a-dynamic-image');
        if (dyn) {
          try {
            const obj = JSON.parse(dyn);
            Object.entries(obj).forEach(([u, wh]) => {
              if (u) add(u, { w: (wh && wh[0]) || 0, h: (wh && wh[1]) || 0, from: 'amz-dyn' });
            });
          } catch (e) { }
        }
        if (srcset) {
          srcset.split(',').forEach((part) => {
            const u = part.trim().split(/\s+/)[0];
            if (u) add(u, { w, h, from: 'srcset' });
          });
        }
        ['data-src', 'data-original', 'data-lazy-src', 'data-old-hires', 'data-a-hires', 'data-high-res-src'].forEach((a) => {
          const v = img.getAttribute(a);
          if (v) add(v, { w, h });
        });
      }
    });

    document.querySelectorAll('source[srcset]').forEach((s) => {
      const ss = s.getAttribute('srcset') || '';
      ss.split(',').forEach((part) => {
        const u = part.trim().split(/\s+/)[0];
        if (u) add(u, { from: 'srcset' });
      });
    });

    // 背景图
    const all = document.querySelectorAll('div,section,a,span,li');
    let bgCount = 0;
    for (const el of all) {
      if (bgCount > 80) break;
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none' && bg.includes('url(')) {
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1]) {
          const r = el.getBoundingClientRect();
          add(m[1], { w: Math.round(r.width), h: Math.round(r.height), from: 'bg' });
          bgCount++;
        }
      }
      const dataBg = el.getAttribute('data-bg') || el.getAttribute('data-background-image');
      if (dataBg) add(dataBg, { from: 'data-bg' });
    }

    ['meta[property="og:image"]', 'meta[property="og:image:secure_url"]', 'meta[name="twitter:image"]'].forEach((sel) => {
      document.querySelectorAll(sel).forEach((m) => { if (m.content) add(m.content, { from: 'meta' }); });
    });

    return [...map.values()];
  }

  // ---------- 视频采集 ----------
  function collectVideos() {
    const map = new Map();
    const add = (url, extra) => {
      const u = abs(url);
      if (skip(u)) return;
      if (!map.has(u)) map.set(u, { kind: /\.m3u8(\?|#|$)/i.test(u) ? 'hls' : 'video', url: u, from: 'dom', w: 0, h: 0, ...extra });
    };
    document.querySelectorAll('video').forEach((v) => {
      const w = v.videoWidth || v.clientWidth || 0;
      const h = v.videoHeight || v.clientHeight || 0;
      const d = Number.isFinite(v.duration) ? Math.round(v.duration) : 0;
      const poster = v.poster ? abs(v.poster) : '';
      if (v.src) add(v.src, { w, h, duration: d, posterUrl: poster });
      v.querySelectorAll('source').forEach((s) => { if (s.src) add(s.src, { w, h, duration: d, posterUrl: poster }); });
    });
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (/\.(mp4|m3u8|webm)(\?|#|$)/i.test(href)) add(href, { from: 'link' });
    });
    document.querySelectorAll('meta[property="og:video"],meta[property="og:video:secure_url"]').forEach((m) => {
      if (m.content) add(m.content, { from: 'meta' });
    });
    return [...map.values()];
  }

  // ---------- 文字采集 ----------
  const TEXT_SELECTORS = [
    ['#productTitle', '商品标题'],
    ['#title', '商品标题'],
    ['h1', '标题'],
    ['#feature-bullets li', '五点描述'],
    ['#productDescription', '商品描述'],
    ['#aplus', 'A+ 图文描述'],
    ['[data-hook="review-body"]', '买家评论'],
    ['.a-size-base.review-text', '买家评论'],
    ['[data-hook="cr-insights-widget"]', '评论摘要'],
    ['meta[name="description"]', '页面描述']
  ];

  function cleanText(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

  function collectTexts() {
    const out = [];
    const seen = new Set();
    const push = (text, label) => {
      const t = cleanText(text);
      if (!t || t.length < 8) return;
      const key = t.slice(0, 60);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind: 'text', label, text: t.slice(0, 6000), lines: (t.match(/。|\.|!|！|\n/g) || []).length || 1, from: 'dom', ts: Date.now() });
    };

    const sel = window.getSelection && String(window.getSelection()).trim();
    if (sel && sel.length > 4) push(sel, '选中文字');

    TEXT_SELECTORS.forEach(([sel2, label]) => {
      document.querySelectorAll(sel2).forEach((el) => {
        if (el.tagName === 'META') { push(el.content, label); return; }
        push(el.innerText || el.textContent || '', label);
      });
    });

    document.querySelectorAll('p').forEach((p) => {
      if (out.length > 40) return;
      const t = p.innerText || '';
      if (t.length > 40 && t.length < 1200) push(t, '段落');
    });
    return out.slice(0, 40);
  }

  // ---------- 消息 ----------
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    try {
      if (msg.type === 'pageInfo') {
        reply({ ok: true, title: document.title, url: location.href });
        return true;
      }
      if (msg.type === 'scan') {
        reply({
          ok: true,
          title: document.title,
          url: location.href,
          images: collectImages(),
          videos: collectVideos(),
          texts: collectTexts()
        });
        return true;
      }
      if (msg.type === 'digImages') {
        (async () => {
          const results = {};
          const urls = (msg.urls || []).slice(0, 40);
          const timeout = msg.timeout || 3000;
          const queue = urls.slice();
          async function worker() {
            while (queue.length) {
              const u = queue.shift();
              const cands = candidatesFor(u).slice(0, 6);
              if (!cands.length) { results[u] = null; continue; }
              let best = null;
              const probes = await Promise.all(cands.map((c) => probe(c, timeout)));
              probes.forEach((r) => { if (r && r.w && (!best || r.w > best.w)) best = r; });
              results[u] = best;
            }
          }
          await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
          reply({ ok: true, results });
        })();
        return true;
      }
      reply({ ok: false, error: 'unknown' });
    } catch (e) {
      try { reply({ ok: false, error: String(e && e.message || e) }); } catch (e2) { }
    }
    return true;
  });
})();
