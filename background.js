// background.js — 网络层嗅探 + HLS 解析 + 后台任务调度
// v2.0：长任务交给 offscreen worker，弹窗关闭后仍继续执行
const netByTab = new Map(); // tabId -> Map<url, asset>
const MAX_PER_TAB = 600;

const IMG_RE = /\.(jpe?g|png|webp|gif|avif|bmp)(\?|#|$)/i;
const VID_RE = /\.(mp4|webm|mov|m4v|m4s|ts)(\?|#|$)/i;

function looksLikeM3u8(url) {
  return /\.m3u8(\?|#|$)/i.test(url) || /\/hls\//i.test(url) || /manifest.*m3u8/i.test(url);
}

function classify(url, type, ct = '') {
  if (!url || /^(data|blob|chrome-extension|about):/i.test(url)) return null;
  if (looksLikeM3u8(url) || /mpegurl/i.test(ct)) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
  if (type === 'media' || VID_RE.test(url) || /^video\//i.test(ct)) return 'video';
  if (type === 'image' || IMG_RE.test(url) || /^image\//i.test(ct)) return 'image';
  return null;
}

function tabMap(tabId) {
  let m = netByTab.get(tabId);
  if (!m) { m = new Map(); netByTab.set(tabId, m); }
  return m;
}

function record(tabId, url, kind, extra = {}) {
  if (tabId < 0) return;
  const m = tabMap(tabId);
  if (m.has(url)) {
    const old = m.get(url);
    Object.assign(old, extra, { hits: old.hits + 1 });
    return;
  }
  if (m.size >= MAX_PER_TAB) m.delete(m.keys().next().value);
  m.set(url, { url, kind, hits: 1, from: 'net', ts: Date.now(), ...extra });
}

function contentTypeOf(details) {
  const hs = details.responseHeaders || [];
  for (const h of hs) {
    if (h.name && h.name.toLowerCase() === 'content-type') return h.value || '';
  }
  return '';
}

// 响应完成时记录，避免 404 / 预检
chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.tabId < 0 || (d.statusCode && d.statusCode >= 400)) return;
    const kind = classify(d.url, d.type, '');
    if (kind) record(d.tabId, d.url, kind);
  },
  { urls: ['<all_urls>'], types: ['image', 'media', 'xmlhttprequest', 'other'] }
);

// 补充：无扩展名 CDN（如 /image?id=123）按 content-type 识别
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || (d.statusCode && d.statusCode >= 400)) return;
    const ct = contentTypeOf(d);
    const kind = classify(d.url, d.type, ct);
    if (kind) record(d.tabId, d.url, kind, { ct });
  },
  { urls: ['<all_urls>'], types: ['image', 'media', 'xmlhttprequest', 'other'] },
  ['responseHeaders', 'extraHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) netByTab.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => netByTab.delete(tabId));

// ---------- HLS 解析 ----------
function absUrl(u, base) {
  try { return new URL(u, base).href; } catch (e) { return ''; }
}

async function fetchText(url, credentials = 'omit') {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { credentials, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(timer); }
}

function parseVariants(text, url) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
    const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/) || [];
    const codecs = (lines[i].match(/CODECS="([^"]+)"/) || [])[1] || '';
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith('#')) j++;
    if (j >= lines.length) continue;
    const sub = absUrl(lines[j], url);
    if (sub) variants.push({ url: sub, w: parseInt(res[1] || 0, 10), h: parseInt(res[2] || 0, 10), bw, codecs });
  }
  return variants.sort((a, b) => b.bw - a.bw || b.w - a.w);
}

async function resolveHls(url, credentials = 'omit', depth = 0) {
  if (depth > 3) throw new Error('播放列表嵌套过深');
  const text = await fetchText(url, credentials);
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variants = parseVariants(text, url);
    if (!variants.length) throw new Error('主干列表里没有可用清晰度');
    // 直接选最高码率子列表，便于一次解析出时长 / 加密信息
    return resolveHls(variants[0].url, credentials, depth + 1).then((info) => ({
      ...info, type: 'master', variants, source: url
    }));
  }
  const keyMatch = text.match(/#EXT-X-KEY:([^\r\n]+)/i);
  let key = null;
  if (keyMatch) {
    const attrs = keyMatch[1];
    const method = (attrs.match(/METHOD=([^,]+)/i) || [])[1] || '';
    if (/AES-128/i.test(method)) {
      const uri = (attrs.match(/URI="([^"]+)"/i) || [])[1] || '';
      const iv = (attrs.match(/IV=(0x[0-9a-f]+)/i) || [])[1] || '';
      key = { method: 'AES-128', uri: uri ? absUrl(uri, url) : '', iv };
    }
  }
  const segs = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => absUrl(l, url)).filter(Boolean);
  const dur = text.split(/\r?\n/).filter((l) => l.startsWith('#EXTINF:'))
    .reduce((s, l) => s + (parseFloat(l.split(':')[1]) || 0), 0);
  return {
    type: 'media',
    variants: [{ url, w: 0, h: 0, bw: 0 }],
    encrypted: /#EXT-X-KEY:METHOD=(?!NONE)/i.test(text),
    decryptable: !!key && !!key.uri,
    key,
    segments: segs.length,
    duration: Math.round(dur),
    source: url
  };
}

// ---------- offscreen worker：承载合并 / 下载 / 上传 ----------
let creatingWorker = null;
async function ensureWorker() {
  if (!chrome.offscreen || !chrome.offscreen.hasDocument) return false;
  if (await chrome.offscreen.hasDocument()) return true;
  if (!creatingWorker) {
    creatingWorker = chrome.offscreen.createDocument({
      url: 'worker.html',
      reasons: ['BLOBS', 'MEDIA_PARSER', 'DOM_SCRAPING'],
      justification: '合并 HLS 分片并完成素材下载与上传，避免关闭弹窗中断任务'
    }).catch((e) => { console.warn('创建 offscreen 失败', e); return null; })
      .finally(() => { creatingWorker = null; });
  }
  return !!(await creatingWorker);
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'ping':
      reply({ ok: true, version: chrome.runtime.getManifest().version });
      return;
    case 'getNetAssets': {
      const m = netByTab.get(msg.tabId) || new Map();
      reply({ ok: true, assets: [...m.values()] });
      return;
    }
    case 'clearNetAssets':
      netByTab.delete(msg.tabId);
      reply({ ok: true });
      return;
    case 'resolveHls':
      (async () => {
        const info = await resolveHls(msg.url, msg.credentials || 'omit');
        if (info.type === 'master') reply({ ok: true, master: true, variants: info.variants, ...info });
        else reply({ ok: true, master: false, ...info });
      })().catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
      return true;
    case 'hlsPoster':
      (async () => {
        const ok = await ensureWorker();
        if (!ok) { reply({ ok: false, error: '后台任务环境初始化失败' }); return; }
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'hlsPosterRun', url: msg.url, credentials: msg.credentials || 'omit'
          });
          reply(res || { ok: false, error: '后台无响应' });
        } catch (e) {
          reply({ ok: false, error: String(e && e.message || e) });
        }
      })().catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
      return true;
    case 'startTask':
      (async () => {
        const taskId = msg.taskId || ('t' + Date.now() + Math.random().toString(36).slice(2, 6));
        const ok = await ensureWorker();
        if (!ok) { reply({ ok: false, error: '后台任务环境初始化失败' }); return; }
        try {
          await chrome.runtime.sendMessage({ ...msg, type: 'runTask', taskId });
          reply({ ok: true, taskId });
        } catch (e) {
          reply({ ok: false, error: String(e && e.message || e) });
        }
      })().catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
      return true;
    case 'cancelTask':
      chrome.runtime.sendMessage({ type: 'cancelTask', taskId: msg.taskId }).catch(() => {});
      reply({ ok: true });
      return;
    default:
      return;
  }
});
