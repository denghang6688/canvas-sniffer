// popup.js — 预览优先界面：卡片网格 / 大预览 / 单文件导入下载
const DEFAULT_SETTINGS = {
  canvasBase: 'http://127.0.0.1:2000',
  minPx: 200,
  filterLow: true,
  digOriginal: true,
  autoClassify: true,
  folderMode: 'title',
  folderFixed: '素材嗅探',
  downloadDir: '素材嗅探',
  provider: 'comfly',
  model: '',
  classifyPrompt: '',
  hlsConcurrency: 5,
  hlsCredentials: true
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  assets: [],
  byUrl: new Map(),
  filter: 'all',
  search: '',
  sort: 'size',
  tab: null,
  busy: false,
  domErr: '',
  canvasOnline: false,
  previewList: [],
  previewIdx: 0,
  activeTask: null
};

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const emptyEl = $('empty');

listEl.addEventListener('error', (e) => {
  if (e.target && e.target.tagName === 'IMG') e.target.style.visibility = 'hidden';
}, true);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function maxDim(a) { return Math.max(a.origW || a.w || 0, a.origH || a.h || 0); }
function effUrl(a) { return a.origUrl || a.url || ''; }
function fmtDur(s) {
  if (!s) return '';
  const m = Math.floor(s / 60), ss = s % 60;
  return m + ':' + String(ss).padStart(2, '0');
}
function safeName(a) {
  if (a.kind === 'text') {
    return (a.label || '文字') + '-' + (a.text || '').slice(0, 12).replace(/[\\/:*?"<>|\s]+/g, '') + '.txt';
  }
  let n = a.name || '';
  if (!n) {
    try { n = decodeURIComponent(new URL(effUrl(a)).pathname.split('/').filter(Boolean).pop() || ''); }
    catch (e) { n = ''; }
  }
  n = (n || ('asset-' + Date.now())).split('?')[0].replace(/[\\/:*?"<>|]+/g, '_');
  if (a.kind === 'hls' && !/\.(ts|mp4)$/i.test(n)) n = n.replace(/\.m3u8$/i, '') + '.ts';
  return n.slice(0, 90);
}
function kindLabel(a) {
  if (a.kind === 'image') return '图片';
  if (a.kind === 'video') return '视频';
  if (a.kind === 'hls') return 'M3U8';
  return '文字';
}

function setStatus(text, busy) {
  $('statusText').textContent = text;
  $('liveDot').classList.toggle('busy', !!busy);
}
function showProgress(text, pct) {
  $('progressWrap').hidden = false;
  $('progressText').textContent = text;
  $('progressFill').style.width = (pct == null ? 8 : pct) + '%';
}
function hideProgress(delay = 1200) {
  setTimeout(() => { $('progressWrap').hidden = true; $('progressFill').style.width = '0'; }, delay);
}

/* ---------------- 设置 ---------------- */
async function loadSettings() {
  const got = await chrome.storage.local.get(DEFAULT_SETTINGS);
  state.settings = { ...DEFAULT_SETTINGS, ...got };
  $('tgLow').classList.toggle('on', !!state.settings.filterLow);
  $('tgDig').classList.toggle('on', !!state.settings.digOriginal);
  $('tgAI').classList.toggle('on', !!state.settings.autoClassify);
  $('canvasUrl').textContent = state.settings.canvasBase.replace(/^https?:\/\//, '');
}
function saveSettings() { chrome.storage.local.set(state.settings); }

async function checkCanvas() {
  const base = state.settings.canvasBase.replace(/\/+$/, '');
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch(base + '/api/health', { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    state.canvasOnline = r.ok;
    $('canvasBar').classList.toggle('off', !r.ok);
    $('canvasText').textContent = r.ok ? '画布已连接 · 在线' : '画布未连接，请检查服务';
    if (r.ok && j && j.version) $('canvasText').textContent += ' v' + j.version;
  } catch (e) {
    state.canvasOnline = false;
    $('canvasBar').classList.add('off');
    $('canvasText').textContent = '画布未连接（' + base.replace(/^https?:\/\//, '') + '）';
  }
}

/* ---------------- 扫描 ---------------- */
async function ensureContent(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'pageInfo' });
    if (r && r.ok) return true;
  } catch (e) { }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 200));
    return true;
  } catch (e) { return false; }
}

function probeInPopup(urls, timeout = 3000) {
  return Promise.all(urls.map((u) => new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout);
    img.onload = () => { if (!done) { done = true; clearTimeout(t); resolve({ url: u, w: img.naturalWidth, h: img.naturalHeight }); } };
    img.onerror = () => { if (!done) { done = true; clearTimeout(t); resolve(null); } };
    try { img.referrerPolicy = 'no-referrer'; } catch (e) { }
    img.src = u;
  })));
}

async function scan() {
  if (state.busy) return;
  state.busy = true;
  setStatus('正在嗅探页面素材…', true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab;
    if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) {
      emptyEl.textContent = '当前页面不支持嗅探（仅支持 http/https）';
      emptyEl.style.display = 'block';
      setStatus('该页面不可嗅探');
      return;
    }

    const ok = await ensureContent(tab.id);
    let dom = null;
    let domErr = '';
    if (ok) {
      try {
        dom = await chrome.tabs.sendMessage(tab.id, { type: 'scan' });
        if (dom && dom.ok === false) domErr = '页面提取失败：' + (dom.error || '未知错误');
      } catch (e) { domErr = '页面提取失败：' + (e && e.message || e); }
    } else {
      domErr = '无法注入页面脚本，请刷新后重试';
    }
    state.domErr = domErr;

    let net = { assets: [] };
    try { net = await chrome.runtime.sendMessage({ type: 'getNetAssets', tabId: tab.id }); } catch (e) { }

    const images = new Map();
    const videos = new Map();
    const texts = [];
    if (dom && dom.ok) {
      (dom.images || []).forEach((im) => {
        const key = im.url;
        const prev = images.get(key);
        if (!prev || maxDim(im) > maxDim(prev)) images.set(key, { ...im, name: safeName(im) });
      });
      (dom.videos || []).forEach((v) => {
        const key = v.url;
        const prev = videos.get(key);
        if (!prev) videos.set(key, { ...v, name: safeName(v), ts: Date.now() });
        else if ((v.w || 0) > (prev.w || 0)) videos.set(key, { ...prev, w: v.w, h: v.h, duration: v.duration || prev.duration });
      });
      texts.push(...(dom.texts || []));
    }
    (net.assets || []).forEach((a) => {
      if (a.kind === 'image' && !images.has(a.url)) {
        images.set(a.url, { kind: 'image', url: a.url, from: 'net', w: 0, h: 0, name: safeName({ url: a.url }), ts: a.ts || Date.now() });
      } else if (a.kind === 'video' && !videos.has(a.url)) {
        videos.set(a.url, { kind: 'video', url: a.url, from: 'net', w: 0, h: 0, name: safeName({ url: a.url }), ts: a.ts || Date.now() });
      } else if (a.kind === 'hls' && !videos.has(a.url)) {
        videos.set(a.url, { kind: 'hls', url: a.url, from: 'net', w: 0, h: 0, name: safeName({ url: a.url }), ts: a.ts || Date.now() });
      }
    });

    const unknown = [...images.values()].filter((a) => !a.w).slice(0, 60);
    if (unknown.length) {
      setStatus(`探测 ${unknown.length} 张图片尺寸…`, true);
      const probed = await probeInPopup(unknown.map((a) => a.url));
      probed.forEach((p) => { if (p) { const a = images.get(p.url); if (a) { a.w = p.w; a.h = p.h; } } });
      [...images.entries()].forEach(([k, a]) => { if (!a.w) images.delete(k); });
    }

    const hlsList = [...videos.values()].filter((v) => v.kind === 'hls').slice(0, 4);
    for (const v of hlsList) {
      try {
        const info = await chrome.runtime.sendMessage({
          type: 'resolveHls', url: v.url,
          credentials: state.settings.hlsCredentials ? 'include' : 'omit'
        });
        if (info && info.ok) {
          if (info.master && info.variants && info.variants.length) {
            v.bestVariant = info.variants[0].url;
            v.w = info.variants[0].w || v.w;
            v.h = info.variants[0].h || v.h;
            v.variants = info.variants.length;
          } else {
            v.encrypted = info.encrypted;
            v.decryptable = info.decryptable;
            v.duration = info.duration || v.duration;
            v.segments = info.segments;
          }
        }
      } catch (e) { }
    }

    const all = [...videos.values(), ...images.values(), ...texts];
    all.forEach((a) => { if (!a.key) a.key = a.kind === 'text' ? 'txt:' + (a.text || '').slice(0, 60) : a.kind + ':' + a.url; });
    state.assets = all;
    state.byUrl = new Map();
    all.forEach((a) => { if (a.url) state.byUrl.set(a.url, a); });

    render();
    setStatus(`已捕获 ${all.length} 条素材 · ${new URL(tab.url).hostname.replace(/^www\./, '')}`, false);
    if (state.settings.digOriginal) runDeepDig(tab.id);
    loadHlsPosters();
  } catch (e) {
    setStatus('扫描失败：' + (e && e.message || e), false);
  } finally { state.busy = false; }
}

/* ---------------- HLS 首帧封面 ---------------- */
async function loadHlsPosters() {
  const list = state.assets.filter((a) => a.kind === 'hls' && !a.posterUrl).slice(0, 4);
  for (const v of list) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'hlsPoster',
        url: v.bestVariant || v.url,
        credentials: state.settings.hlsCredentials ? 'include' : 'omit'
      });
      if (res && res.ok && res.poster) {
        v.posterUrl = res.poster;
        if (res.w && !v.w) { v.w = res.w; v.h = res.h; }
        render();
        setStatus('视频封面已生成', false);
      }
    } catch (e) { }
  }
}

/* ---------------- 深挖原图 ---------------- */
let digRunning = false;
async function runDeepDig(tabId) {
  if (digRunning || !state.byUrl.size) return;
  const targets = state.assets.filter((a) =>
    a.kind === 'image' && a.w && maxDim(a) < 1600 &&
    !/\.svg(\?|#|$)/i.test(a.url) && /^https?:/.test(a.url)
  ).slice(0, 16);
  if (!targets.length) return;
  digRunning = true;
  setStatus(`深挖原图 ${targets.length} 张…`, true);
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'digImages', urls: targets.map((a) => a.url), timeout: 3000 });
    if (res && res.ok) {
      let upgraded = 0;
      Object.entries(res.results || {}).forEach(([u, r]) => {
        if (!r || !r.w) return;
        const a = state.byUrl.get(u);
        if (a && r.w > maxDim(a) * 1.15) {
          a.origUrl = r.url; a.origW = r.w; a.origH = r.h; upgraded++;
        }
      });
      render();
      setStatus(upgraded ? `深挖完成，${upgraded} 张升级为原图` : '深挖完成，未找到更大原图', false);
    }
  } catch (e) {
    setStatus('深挖失败：' + (e && e.message || e), false);
  } finally { digRunning = false; }
}

/* ---------------- 过滤 / 卡片 ---------------- */
function passFilter(a) {
  if (state.filter !== 'all') {
    if (state.filter === 'image' && a.kind !== 'image') return false;
    if (state.filter === 'video' && !(a.kind === 'video' || a.kind === 'hls')) return false;
    if (state.filter === 'text' && a.kind !== 'text') return false;
  }
  if (state.search) {
    const q = state.search.toLowerCase();
    const hay = [safeName(a), a.url, a.origUrl, a.label, a.text, a.alt].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (state.settings.filterLow && a.kind !== 'text') {
    const d = maxDim(a);
    if (d && d < state.settings.minPx) return false;
  }
  return true;
}
function visibleAssets() {
  const arr = state.assets.filter(passFilter);
  const order = { hls: 0, video: 1, image: 2, text: 3 };
  arr.sort((x, y) => {
    if (state.sort === 'name') return safeName(x).localeCompare(safeName(y));
    if (state.sort === 'time') return (y.ts || 0) - (x.ts || 0);
    const o = (order[x.kind] ?? 9) - (order[y.kind] ?? 9);
    if (o) return o;
    return maxDim(y) - maxDim(x);
  });
  return arr.slice(0, 200);
}

function mediaHtml(a) {
  const u = effUrl(a);
  if (a.kind === 'image') {
    return `<img src="${esc(u)}" loading="lazy" referrerpolicy="no-referrer" alt="">`;
  }
  if (a.kind === 'video') {
    const thumb = a.posterUrl
      ? `<img src="${esc(a.posterUrl)}" referrerpolicy="no-referrer" alt="">`
      : `<video src="${esc(u + (u.includes('#') ? '&' : '#') + 't=0.1')}" preload="metadata" muted playsinline></video>`;
    return thumb + '<span class="play">▶</span>';
  }
  if (a.kind === 'hls') {
    const thumb = a.posterUrl
      ? `<img src="${esc(a.posterUrl)}" referrerpolicy="no-referrer" alt="">`
      : '<span class="ph">HLS</span>';
    return thumb + '<span class="play">▶</span>';
  }
  return '<span class="ph">TXT</span>';
}

function cardHtml(a) {
  const low = a.kind !== 'text' && maxDim(a) && maxDim(a) < state.settings.minPx;
  const dims = maxDim(a) ? `${a.origW || a.w} × ${a.origH || a.h}` : '尺寸未知';
  const sub = a.kind === 'text'
    ? `${(a.text || '').length} 字 · ${a.label || '文字'}`
    : dims + (a.duration ? ' · ' + fmtDur(a.duration) : '');
  const snippet = a.kind === 'text'
    ? `<div class="snippet">${esc((a.text || '').slice(0, 90))}</div>`
    : '';
  return `<div class="card" data-key="${esc(a.key)}">
    <div class="media" data-preview="1">${mediaHtml(a)}
      ${a.origUrl ? '<span class="badge orig">原图</span>' : ''}
      ${low ? '<span class="badge low">低分</span>' : ''}
      <span class="badge">${kindLabel(a)}</span>
      ${a.duration ? `<span class="dur">${fmtDur(a.duration)}</span>` : ''}
    </div>
    <div class="info">
      <div class="name" title="${esc(safeName(a))}">${esc(safeName(a))}</div>
      <div class="dim">${esc(sub)}</div>
      ${snippet}
      <div class="acts">
        <button class="act pri" data-act="save">导入画布</button>
        <button class="act" data-act="download">下载</button>
      </div>
    </div>
  </div>`;
}

function render() {
  const items = visibleAssets();
  $('nAll').textContent = state.assets.length;
  $('nImg').textContent = state.assets.filter((a) => a.kind === 'image').length;
  $('nVid').textContent = state.assets.filter((a) => a.kind === 'video' || a.kind === 'hls').length;
  $('nTxt').textContent = state.assets.filter((a) => a.kind === 'text').length;
  $('footInfo').textContent = `共 ${state.assets.length} 项 · 显示 ${items.length} 项${state.activeTask ? ' · 后台任务进行中' : ''}`;
  if (!items.length) {
    listEl.innerHTML = `<div class="empty">${state.assets.length
      ? '当前筛选下没有素材<br>试试关闭「低分过滤」或清空搜索'
      : (state.domErr ? '❌ ' + esc(state.domErr) + '<br><span style="font-size:11px">点 ⟳ 重试</span>'
        : '还没有捕获到素材<br>滚动页面 / 播放视频后再点 ⟳ 重扫')}</div>`;
  } else {
    listEl.innerHTML = items.map(cardHtml).join('');
  }
  updatePreviewButtons();
}

/* ---------------- 预览层 ---------------- */
function openPreview(key) {
  state.previewList = visibleAssets();
  state.previewIdx = Math.max(0, state.previewList.findIndex((a) => a.key === key));
  renderPreview();
  $('lightbox').hidden = false;
}
function closePreview() { $('lightbox').hidden = true; }
function previewAsset() { return state.previewList[state.previewIdx] || null; }

function renderPreview() {
  const a = previewAsset();
  if (!a) { closePreview(); return; }
  const u = effUrl(a);
  $('lbTitle').textContent = safeName(a);
  let stage = '';
  if (a.kind === 'image') {
    stage = `<img src="${esc(u)}" referrerpolicy="no-referrer" alt="">`;
  } else if (a.kind === 'video') {
    stage = `<video src="${esc(u)}" controls autoplay playsinline></video>`;
  } else if (a.kind === 'hls') {
    stage = (a.posterUrl ? `<img src="${esc(a.posterUrl)}" referrerpolicy="no-referrer" alt="">` : '')
      + `<div class="lb-note">${a.posterUrl ? '' : 'M3U8 流 · '}清晰度 ${a.variants || 1} 档${a.duration ? ' · ' + fmtDur(a.duration) : ''}${a.encrypted ? (a.decryptable ? ' · AES 加密（可解密）' : ' · 加密流（不可解密）') : ''}<br>导入或下载时由后台合并分片</div>`;
  } else {
    stage = `<pre>${esc(a.text || '')}</pre>`;
  }
  $('lbStage').innerHTML = stage;
  const dims = maxDim(a) ? `${a.origW || a.w} × ${a.origH || a.h}` : '尺寸未知';
  $('lbMeta').textContent = `${kindLabel(a)} · ${a.kind === 'text' ? (a.label || '文字') + ' · ' + (a.text || '').length + ' 字' : dims} · 来源 ${a.from || 'dom'}${a.origUrl ? ' · 已升级原图' : ''}`;
  $('lbUrl').textContent = u;
  $('lbPrev').disabled = state.previewIdx <= 0;
  $('lbNext').disabled = state.previewIdx >= state.previewList.length - 1;
  updatePreviewButtons();
}
function updatePreviewButtons() {
  const busy = !!state.activeTask;
  ['lbSave', 'lbDownload'].forEach((id) => { $(id).disabled = busy; });
}
function navPreview(delta) {
  const next = state.previewIdx + delta;
  if (next < 0 || next >= state.previewList.length) return;
  state.previewIdx = next;
  renderPreview();
}

/* ---------------- 后台任务 ---------------- */
function startTask(action, assets) {
  if (!assets.length || state.activeTask) return;
  const taskId = 't' + Date.now() + Math.random().toString(36).slice(2, 6);
  state.activeTask = { id: taskId };
  setStatus('任务已提交到后台', true);
  showProgress(action === 'save' ? '准备导入画布…' : '准备下载…', 2);
  render();
  chrome.runtime.sendMessage({
    type: 'startTask', taskId, action, assets,
    settings: state.settings, tab: state.tab
  }, (res) => {
    if (!res || !res.ok) {
      state.activeTask = null;
      showProgress('任务启动失败：' + (res && res.error || '未知错误'), 100);
      hideProgress(4000);
      render();
    }
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !state.activeTask || msg.taskId !== state.activeTask.id) return;
  if (msg.type === 'taskProgress') {
    showProgress(msg.text, msg.pct);
    setStatus('后台任务进行中', true);
  } else if (msg.type === 'taskDone') {
    const r = msg.result || {};
    state.activeTask = null;
    showProgress(r.message || r.error || '任务完成', 100);
    setStatus(r.ok ? '任务完成' : '任务失败', false);
    hideProgress(5000);
    render();
  }
});

/* ---------------- 交互 ---------------- */
document.querySelectorAll('#chips .chip').forEach((c) => {
  c.addEventListener('click', () => {
    document.querySelectorAll('#chips .chip').forEach((x) => x.classList.remove('on'));
    c.classList.add('on');
    state.filter = c.dataset.f;
    render();
  });
});
$('search').addEventListener('input', (e) => { state.search = e.target.value.trim(); render(); });
$('sortBy').addEventListener('change', (e) => { state.sort = e.target.value; render(); });

function bindToggle(id, key) {
  $(id).addEventListener('click', () => {
    const on = !$(id).classList.contains('on');
    $(id).classList.toggle('on', on);
    state.settings[key] = on;
    saveSettings();
    render();
    if (key === 'digOriginal' && on && state.tab) runDeepDig(state.tab.id);
  });
}
bindToggle('tgLow', 'filterLow');
bindToggle('tgDig', 'digOriginal');
bindToggle('tgAI', 'autoClassify');

listEl.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const key = card.dataset.key;
  const a = state.assets.find((x) => x.key === key);
  if (!a) return;
  const btn = e.target.closest('[data-act]');
  if (btn) { startTask(btn.dataset.act === 'save' ? 'save' : 'download', [a]); return; }
  if (e.target.closest('[data-preview]')) openPreview(key);
});

$('lbClose').addEventListener('click', closePreview);
$('lbPrev').addEventListener('click', () => navPreview(-1));
$('lbNext').addEventListener('click', () => navPreview(1));
$('lbSave').addEventListener('click', () => { const a = previewAsset(); if (a) startTask('save', [a]); });
$('lbDownload').addEventListener('click', () => { const a = previewAsset(); if (a) startTask('download', [a]); });
$('lbCopy').addEventListener('click', async () => {
  const a = previewAsset();
  if (!a) return;
  try { await navigator.clipboard.writeText(effUrl(a)); $('lbCopy').textContent = '已复制'; }
  catch (e) { $('lbCopy').textContent = '复制失败'; }
  setTimeout(() => { $('lbCopy').textContent = '复制链接'; }, 1600);
});
document.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  if (e.key === 'Escape') closePreview();
  if (e.key === 'ArrowLeft') navPreview(-1);
  if (e.key === 'ArrowRight') navPreview(1);
});

$('btnRefresh').addEventListener('click', async () => {
  if (state.tab && state.tab.id) {
    try { await chrome.runtime.sendMessage({ type: 'clearNetAssets', tabId: state.tab.id }); } catch (e) { }
  }
  state.assets = []; state.byUrl = new Map();
  closePreview();
  await scan();
});
$('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btnOpenCanvas').addEventListener('click', () => {
  chrome.tabs.create({ url: state.settings.canvasBase.replace(/\/+$/, '') + '/' });
});
$('canvasBar').addEventListener('click', () => {
  chrome.tabs.create({ url: state.settings.canvasBase.replace(/\/+$/, '') + '/' });
});

/* ---------------- 启动 ---------------- */
(async function init() {
  await loadSettings();
  await checkCanvas();
  await scan();
})();
