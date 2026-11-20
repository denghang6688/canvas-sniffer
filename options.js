// options.js
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

const $ = (id) => document.getElementById(id);

async function load() {
  const s = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
  $('canvasBase').value = s.canvasBase;
  $('minPx').value = s.minPx;
  $('folderMode').value = s.folderMode;
  $('folderFixed').value = s.folderFixed;
  $('downloadDir').value = s.downloadDir;
  $('provider').value = s.provider;
  $('model').value = s.model;
  $('classifyPrompt').value = s.classifyPrompt;
  $('hlsConcurrency').value = s.hlsConcurrency;
  $('hlsCredentials').checked = !!s.hlsCredentials;
}

function flash(el, text, ok) {
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  setTimeout(() => { el.textContent = ''; el.className = 'msg'; }, 3200);
}

$('btnSave').addEventListener('click', async () => {
  const patch = {
    canvasBase: ($('canvasBase').value || DEFAULT_SETTINGS.canvasBase).trim().replace(/\/+$/, ''),
    minPx: Math.max(40, Math.min(2000, parseInt($('minPx').value || '200', 10))),
    folderMode: $('folderMode').value,
    folderFixed: $('folderFixed').value.trim() || '素材嗅探',
    downloadDir: $('downloadDir').value.trim() || '素材嗅探',
    provider: $('provider').value.trim() || 'comfly',
    model: $('model').value.trim(),
    classifyPrompt: $('classifyPrompt').value.trim(),
    hlsConcurrency: Math.max(1, Math.min(16, parseInt($('hlsConcurrency').value || '5', 10))),
    hlsCredentials: !!$('hlsCredentials').checked
  };
  await chrome.storage.local.set(patch);
  flash($('saveMsg'), '已保存', true);
});

$('btnTest').addEventListener('click', async () => {
  const base = ($('canvasBase').value || DEFAULT_SETTINGS.canvasBase).trim().replace(/\/+$/, '');
  flash($('testMsg'), '测试中…', true);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(base + '/api/health', { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (r.ok) flash($('testMsg'), '连接成功 ' + (j.version ? 'v' + j.version : ''), true);
    else flash($('testMsg'), 'HTTP ' + r.status, false);
  } catch (e) {
    flash($('testMsg'), '连接失败：' + (e.message || e), false);
  }
});

$('btnOpenCanvas').addEventListener('click', () => {
  const base = ($('canvasBase').value || DEFAULT_SETTINGS.canvasBase).trim().replace(/\/+$/, '');
  chrome.tabs.create({ url: base + '/' });
});

/* ---------------- 检查更新 ---------------- */
const UPDATE_URLS = [
  'https://raw.githubusercontent.com/denghang6688/canvas-sniffer/main/update.json',
  'https://www.modelscope.cn/models/hans186/canvas-sniffer/resolve/master/update.json'
];

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function fetchUpdateInfo() {
  let best = null;
  for (const url of UPDATE_URLS) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.version && (!best || cmpVersion(j.version, best.version) > 0)) best = j;
    } catch (e) { }
  }
  return best;
}

$('btnCheckUpdate').addEventListener('click', async () => {
  const cur = chrome.runtime.getManifest().version;
  $('curVersion').textContent = 'v' + cur;
  flash($('updateMsg'), '检查中…', true);
  const info = await fetchUpdateInfo();
  if (!info) { flash($('updateMsg'), '检查失败：无法访问更新源', false); return; }
  const d = cmpVersion(info.version, cur);
  if (d > 0) {
    flash($('updateMsg'), `发现新版本 v${info.version}`, true);
    $('btnGoUpdate').style.display = '';
    $('btnGoUpdate').onclick = () => chrome.tabs.create({
      url: (info.sources && info.sources.github && info.sources.github.page) || info.sources.modelscope.page
    });
  } else if (d === 0) {
    flash($('updateMsg'), '已是最新版本', true);
    $('btnGoUpdate').style.display = 'none';
  } else {
    flash($('updateMsg'), `本地比更新源新（源：v${info.version}）`, true);
    $('btnGoUpdate').style.display = 'none';
  }
});

$('curVersion').textContent = 'v' + chrome.runtime.getManifest().version;

load();
