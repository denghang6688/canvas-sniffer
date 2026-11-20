// worker.js — offscreen document：承载 HLS 合并、下载、上传长任务
// 即使弹窗关闭，任务仍在后台继续，并通过 runtime 消息回报进度
const tasks = new Map();
const keyCache = new Map();

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'runTask') {
    const task = { cancelled: false };
    tasks.set(msg.taskId, task);
    runTask(msg, task)
      .catch((e) => done(msg.taskId, { ok: false, error: String(e && e.message || e) }))
      .finally(() => tasks.delete(msg.taskId));
    return;
  }
  if (msg.type === 'cancelTask') {
    const t = tasks.get(msg.taskId);
    if (t) t.cancelled = true;
  }
  if (msg.type === 'hlsPosterRun') {
    enqueuePoster(msg, reply);
    return true;
  }
});

function emit(type, payload) {
  try { chrome.runtime.sendMessage({ type, ...payload }); } catch (e) { }
}
function progress(taskId, text, pct) { emit('taskProgress', { taskId, text, pct }); }
function done(taskId, result) { emit('taskDone', { taskId, result }); }
function checkCancel(task) { if (task && task.cancelled) throw new Error('任务已取消'); }

/* ---------------- 通用工具 ---------------- */
const absUrl = (u, base) => { try { return new URL(u, base).href; } catch (e) { return ''; } };

function effUrl(a) { return a.origUrl || a.url || ''; }
function maxDim(a) { return Math.max(a.origW || a.w || 0, a.origH || a.h || 0); }

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

function folderName(tab, settings) {
  const s = settings || {};
  if (s.folderMode === 'none') return '';
  if (s.folderMode === 'fixed') return s.folderFixed || '素材嗅探';
  let host = 'page';
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch (e) { }
  const title = (tab.title || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 36);
  return (title || host).slice(0, 50);
}

async function fetchRaw(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } finally { clearTimeout(timer); }
}

async function fetchText(url, credentials) {
  const r = await fetchRaw(url, { credentials: credentials || 'omit' });
  return r.text();
}

function parseVariants(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
    const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/) || [];
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith('#')) j++;
    if (j >= lines.length) continue;
    const u = absUrl(lines[j], base);
    if (u) out.push({ url: u, w: parseInt(res[1] || 0, 10), h: parseInt(res[2] || 0, 10), bw });
  }
  return out.sort((a, b) => b.bw - a.bw || b.w - a.w);
}

async function mediaPlaylist(startUrl, credentials) {
  let url = startUrl;
  let text = await fetchText(url, credentials);
  let guard = 0;
  while (text.includes('#EXT-X-STREAM-INF') && guard++ < 3) {
    const variants = parseVariants(text, url);
    if (!variants.length) throw new Error('无法解析播放列表清晰度');
    url = variants[0].url;
    text = await fetchText(url, credentials);
  }
  return { url, text };
}

function parseMedia(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const seqLine = lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  let seq = seqLine ? parseInt(seqLine.split(':')[1], 10) || 0 : 0;
  const segs = [];
  for (const l of lines) {
    if (!l || l.startsWith('#')) continue;
    const u = absUrl(l, base);
    if (u) segs.push({ url: u, index: seq++ });
  }
  const keyLine = lines.find((l) => l.startsWith('#EXT-X-KEY:'));
  let key = null;
  if (keyLine) {
    const attrs = keyLine.slice(keyLine.indexOf(':') + 1);
    const method = (attrs.match(/METHOD=([^,]+)/i) || [])[1] || '';
    if (/AES-128/i.test(method)) {
      const uri = (attrs.match(/URI="([^"]+)"/i) || [])[1] || '';
      const iv = (attrs.match(/IV=(0x[0-9a-f]+)/i) || [])[1] || '';
      key = { method: 'AES-128', uri: uri ? absUrl(uri, base) : '', iv };
    }
  }
  return { segs, key };
}

async function cryptoKeyFor(uri, credentials) {
  if (keyCache.has(uri)) return keyCache.get(uri);
  const r = await fetchRaw(uri, { credentials: credentials || 'omit' }, 15000);
  const buf = await r.arrayBuffer();
  if (buf.byteLength !== 16) throw new Error('HLS 密钥长度不是 16 字节');
  const ck = await crypto.subtle.importKey('raw', buf, { name: 'AES-CBC' }, false, ['decrypt']);
  keyCache.set(uri, ck);
  return ck;
}

function ivFor(key, index) {
  if (key.iv) {
    const hex = key.iv.slice(2).padStart(32, '0').slice(-32);
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
    return out;
  }
  const out = new Uint8Array(16);
  let n = index;
  for (let i = 15; i >= 0; i--) { out[i] = n & 0xff; n = Math.floor(n / 256); }
  return out;
}

async function decryptSegment(buf, ck, iv) {
  // WebCrypto 的 AES-CBC 解密会自动校验并移除 PKCS#7 填充，不能再手动去掉尾字节
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, buf));
}

async function mergeHls(startUrl, opts = {}) {
  const credentials = opts.credentials || 'omit';
  const { url, text } = await mediaPlaylist(startUrl, credentials);
  const { segs, key } = parseMedia(text, url);
  if (!segs.length) throw new Error('播放列表里没有分片');
  if (key && !key.uri) throw new Error('加密流缺少密钥地址（URI），无法解密');
  const ck = key ? await cryptoKeyFor(key.uri, credentials) : null;

  const chunks = new Array(segs.length);
  let cursor = 0, doneCount = 0;
  const onProgress = opts.onProgress;
  async function worker() {
    while (cursor < segs.length) {
      checkCancel(opts.task);
      const i = cursor++;
      const seg = segs[i];
      let r;
      try {
        r = await fetchRaw(seg.url, { credentials }, 30000);
      } catch (e) {
        throw new Error(`分片 ${i + 1}/${segs.length} 下载失败：${e.message || e}`);
      }
      let buf = await r.arrayBuffer();
      if (ck) buf = await decryptSegment(buf, ck, ivFor(key, seg.index));
      chunks[i] = new Uint8Array(buf);
      doneCount++;
      if (onProgress) onProgress(doneCount, segs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency || 5, segs.length) }, worker));
  checkCancel(opts.task);
  return new Blob(chunks, { type: 'video/mp2t' });
}

/* ---------------- 任务：存入画布 ---------------- */
async function saveToCanvas(msg, task) {
  const assets = msg.assets || [];
  const settings = msg.settings || {};
  const tab = msg.tab || {};
  const base = (settings.canvasBase || 'http://127.0.0.1:2000').replace(/\/+$/, '');
  const folder = folderName(tab, settings);
  const credentials = settings.hlsCredentials ? 'include' : 'omit';
  let imported = 0, uploaded = 0, failed = 0;
  const notes = [];

  progress(msg.taskId, '连接画布…', 4);
  const direct = assets.filter((a) => (a.kind === 'image' || a.kind === 'video') && /^https?:/i.test(effUrl(a)));
  if (direct.length) {
    progress(msg.taskId, `画布下载中：${direct.length} 个直链素材…`, 20);
    try {
      const r = await fetchRaw(base + '/api/local-assets/import-urls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: direct.map((a) => ({ url: effUrl(a), name: safeName(a) })),
          folder,
          classify: !!settings.autoClassify,
          provider: settings.provider || 'comfly',
          model: settings.model || '',
          prompt: settings.classifyPrompt || ''
        })
      });
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j.items)) {
        j.items.forEach((it) => { it.ok ? imported++ : failed++; });
        const errs = j.items.filter((it) => !it.ok);
        if (errs.length) notes.push(`${errs.length} 个直链导入失败`);
      } else if (j.ok || j.count) {
        imported += j.count || direct.length;
      } else {
        failed += direct.length;
        notes.push('导入接口未返回结果明细');
      }
    } catch (e) {
      failed += direct.length;
      notes.push('直链导入失败：' + (e.message || e));
    }
  }

  progress(msg.taskId, '直链素材处理完毕', 55);
  const hlsList = assets.filter((a) => a.kind === 'hls');
  for (let i = 0; i < hlsList.length; i++) {
    checkCancel(task);
    const a = hlsList[i];
    try {
      const start = a.bestVariant || effUrl(a);
      const blob = await mergeHls(start, {
        credentials,
        concurrency: settings.hlsConcurrency || 5,
        task,
        onProgress: (d, total) => progress(msg.taskId,
          `合并视频 ${safeName(a)} ${d}/${total} 段`, 55 + ((i + d / total) / hlsList.length) * 20)
      });
      const fd = new FormData();
      fd.append('files', blob, safeName(a));
      if (folder) fd.append('folder', folder);
      const r = await fetchRaw(base + '/api/local-assets/upload', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (j.count > 0 || j.files || j.ok) uploaded++; else failed++;
    } catch (e) {
      failed++;
      notes.push(`${safeName(a)}：${e.message || e}`);
    }
  }

  const texts = assets.filter((a) => a.kind === 'text');
  if (texts.length) {
    checkCancel(task);
    progress(msg.taskId, `上传 ${texts.length} 条文字…`, 80);
    const fd = new FormData();
    texts.forEach((a) => {
      const blob = new Blob([`【${a.label || '文字'}】\n来源：${tab.url || ''}\n\n${a.text || ''}`], { type: 'text/plain;charset=utf-8' });
      fd.append('files', blob, safeName(a));
    });
    if (folder) fd.append('folder', folder);
    try {
      const r = await fetchRaw(base + '/api/local-assets/upload', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (j.count) uploaded += j.count; else if (j.ok) uploaded += texts.length; else failed += texts.length;
    } catch (e) {
      failed += texts.length;
      notes.push('文字上传失败：' + (e.message || e));
    }
  }

  const text = `已存入画布：直链 ${imported} / 上传 ${uploaded}${failed ? ` / 失败 ${failed}` : ''}${notes.length ? ' · ' + notes.slice(0, 2).join('；') : ''}`;
  progress(msg.taskId, text, 100);
  return { ok: failed === 0, imported, uploaded, failed, message: text };
}

/* ---------------- 任务：下载 ---------------- */
async function downloadAssets(msg, task) {
  const assets = msg.assets || [];
  const settings = msg.settings || {};
  const dir = (settings.downloadDir || '素材嗅探').replace(/^\/+|\/+$/g, '') || '素材嗅探';
  const credentials = settings.hlsCredentials ? 'include' : 'omit';
  let ok = 0, fail = 0;
  const notes = [];

  for (let i = 0; i < assets.length; i++) {
    checkCancel(task);
    const a = assets[i];
    const label = `(${i + 1}/${assets.length}) ${safeName(a)}`;
    try {
      let url = effUrl(a);
      let objectUrl = false;
      if (a.kind === 'text') {
        const blob = new Blob([a.text || ''], { type: 'text/plain;charset=utf-8' });
        url = URL.createObjectURL(blob);
        objectUrl = true;
      } else if (a.kind === 'hls') {
        progress(msg.taskId, `合并 HLS：${label}`, 5);
        const blob = await mergeHls(a.bestVariant || effUrl(a), {
          credentials,
          concurrency: settings.hlsConcurrency || 5,
          task,
          onProgress: (d, total) => progress(msg.taskId,
            `合并 HLS：${label} ${d}/${total} 段`, 5 + (d / total) * 85)
        });
        url = URL.createObjectURL(blob);
        objectUrl = true;
      }
      await chrome.downloads.download({
        url,
        filename: `${dir}/${safeName(a)}`,
        conflictAction: 'uniquify',
        saveAs: false
      });
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(url), 60000);
      ok++;
    } catch (e) {
      fail++;
      notes.push(`${safeName(a)}：${e.message || e}`);
    }
    progress(msg.taskId, `已完成 ${i + 1}/${assets.length}`, ((i + 1) / assets.length) * 100);
  }

  const text = `下载完成：成功 ${ok} 项${fail ? `，失败 ${fail} 项` : ''}（保存在「下载/${dir}」）${notes.length ? ' · ' + notes[0] : ''}`;
  progress(msg.taskId, text, 100);
  return { ok: fail === 0, okCount: ok, failed: fail, message: text };
}

async function runTask(msg, task) {
  if (msg.action === 'download') {
    const result = await downloadAssets(msg, task);
    done(msg.taskId, { ...result, action: 'download' });
  } else if (msg.action === 'save') {
    const result = await saveToCanvas(msg, task);
    done(msg.taskId, { ...result, action: 'save' });
  } else {
    done(msg.taskId, { ok: false, error: '未知任务类型' });
  }
}

/* ---------------- HLS 首帧海报（卡片预览） ----------------
   fMP4 分片：init 段 + 首个分片拼成 blob，用 <video> 解码截帧
   TS 分片：解析出 H.264 Annex-B 关键帧，用 WebCodecs 硬解出画面 */
const posterCache = new Map(); // url -> result（worker 存活期内复用）
const posterQueue = [];
let posterBusy = false;

function enqueuePoster(req, reply) {
  const cached = posterCache.get(req.url);
  if (cached) { reply(cached); return; }
  posterQueue.push({ req, reply });
  drainPosters();
}

async function drainPosters() {
  if (posterBusy) return;
  posterBusy = true;
  while (posterQueue.length) {
    const { req, reply } = posterQueue.shift();
    let result;
    try {
      result = await makeHlsPoster(req);
      if (result && result.ok) {
        if (posterCache.size > 20) posterCache.delete(posterCache.keys().next().value);
        posterCache.set(req.url, result);
      }
    } catch (e) {
      result = { ok: false, error: String(e && e.message || e) };
    }
    try { reply(result); } catch (e) { }
  }
  posterBusy = false;
}

function concatBytes(list) {
  let n = 0;
  list.forEach((b) => { n += b.length; });
  const out = new Uint8Array(n);
  let o = 0;
  list.forEach((b) => { out.set(b, o); o += b.length; });
  return out;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('图片编码失败'));
    fr.readAsDataURL(blob);
  });
}

async function makeHlsPoster(req) {
  const credentials = req.credentials || 'omit';
  const { url, text } = await mediaPlaylist(req.url, credentials);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segUrls = lines.filter((l) => l && !l.startsWith('#')).map((l) => absUrl(l, url)).filter(Boolean);
  if (!segUrls.length) throw new Error('播放列表里没有分片');
  const mapLine = lines.find((l) => l.startsWith('#EXT-X-MAP:'));
  const initUri = mapLine ? absUrl((mapLine.match(/URI="([^"]+)"/i) || [])[1] || '', url) : '';
  const keyLine = lines.find((l) => l.startsWith('#EXT-X-KEY:'));
  let key = null;
  if (keyLine) {
    const attrs = keyLine.slice(keyLine.indexOf(':') + 1);
    if (/AES-128/i.test((attrs.match(/METHOD=([^,]+)/i) || [])[1] || '')) {
      const uri = (attrs.match(/URI="([^"]+)"/i) || [])[1] || '';
      key = { uri: absUrl(uri, url), iv: (attrs.match(/IV=(0x[0-9a-f]+)/i) || [])[1] || '' };
      if (!key.uri) throw new Error('加密流缺少密钥地址');
    }
  }
  const seqLine = lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  const seq = seqLine ? parseInt(seqLine.split(':')[1], 10) || 0 : 0;
  const ck = key ? await cryptoKeyFor(key.uri, credentials) : null;

  const segs = [];
  for (let i = 0; i < Math.min(segUrls.length, 6); i++) {
    const r = await fetchRaw(segUrls[i], { credentials }, 20000);
    let buf = new Uint8Array(await r.arrayBuffer());
    if (ck) buf = await decryptSegment(buf, ck, ivFor(key, seq + i));
    segs.push(buf);
  }
  const first = segs[0];
  const isFmp4 = first.length > 8 &&
    String.fromCharCode(first[4], first[5], first[6], first[7]) === 'ftyp';
  if (isFmp4) return await posterFromFmp4(initUri, segs, credentials);
  return await posterFromTs(segs);
}

async function posterFromFmp4(initUri, segs, credentials) {
  const parts = [];
  if (initUri) {
    const r = await fetchRaw(initUri, { credentials }, 20000);
    parts.push(new Uint8Array(await r.arrayBuffer()));
  }
  parts.push(segs[0]);
  const blob = new Blob(parts, { type: 'video/mp4' });
  return await frameFromVideoBlob(blob);
}

function frameFromVideoBlob(blob) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    const url = URL.createObjectURL(blob);
    v.src = url;
    const cleanup = () => { try { v.pause(); } catch (e) { } URL.revokeObjectURL(url); };
    const to = setTimeout(() => { cleanup(); reject(new Error('视频解码超时')); }, 15000);
    v.addEventListener('error', () => { clearTimeout(to); cleanup(); reject(new Error('视频解码失败（浏览器不支持该编码）')); });
    v.addEventListener('loadeddata', () => {
      try { v.currentTime = Math.min(0.1, (v.duration || 1) * 0.1); } catch (e) { }
    });
    v.addEventListener('seeked', () => {
      clearTimeout(to);
      try {
        const c = document.createElement('canvas');
        const scale = Math.min(1, 640 / (v.videoWidth || 640));
        c.width = Math.max(2, Math.round((v.videoWidth || 640) * scale));
        c.height = Math.max(2, Math.round((v.videoHeight || 360) * scale));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        const out = c.toDataURL('image/jpeg', 0.72);
        cleanup();
        resolve({ ok: true, poster: out, w: v.videoWidth, h: v.videoHeight });
      } catch (e) { cleanup(); reject(e); }
    });
    v.load();
  });
}

function hex2(b) { return b.toString(16).padStart(2, '0').toUpperCase(); }

function tsPacketsMap(u8) {
  const byPid = new Map();
  const n = Math.floor(u8.length / 188);
  for (let p = 0; p < n; p++) {
    const o = p * 188;
    if (u8[o] !== 0x47) continue;
    const pusi = (u8[o + 1] & 0x40) !== 0;
    const pid = ((u8[o + 1] & 0x1f) << 8) | u8[o + 2];
    const afc = (u8[o + 3] >> 4) & 0x3;
    let i = o + 4;
    if ((afc & 0x2) && i < o + 188) i += 1 + u8[i];
    if (!(afc & 0x1) || i >= o + 188) continue;
    let e = byPid.get(pid);
    if (!e) { e = []; byPid.set(pid, e); }
    e.push({ start: pusi, data: u8.subarray(i, o + 188) });
  }
  return byPid;
}

function sectionBytes(chunks) {
  const parts = [];
  let started = false;
  for (const c of chunks) {
    if (c.start && started) break;
    if (c.start) { started = true; parts.push(c.data.subarray(1 + c.data[0])); }
    else if (started) parts.push(c.data);
  }
  return started && parts.length ? concatBytes(parts) : null;
}

function pesPayloads(chunks) {
  const out = [];
  let cur = null;
  for (const c of chunks) {
    if (c.start) {
      if (cur) out.push(cur);
      const d = c.data;
      const p = d.subarray(1 + d[0]);
      if (p.length < 9 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1) { cur = null; continue; }
      cur = p.subarray(9 + p[8]);
    } else if (cur) {
      cur = concatBytes([cur, c.data]);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function splitNals(u8) {
  const nals = [];
  const n = u8.length;
  let i = 0, start = -1;
  while (i < n - 3) {
    if (u8[i] === 0 && u8[i + 1] === 0) {
      if (u8[i + 2] === 1) {
        if (start >= 0) nals.push(u8.subarray(start, i));
        start = i + 3; i += 3; continue;
      } else if (u8[i + 2] === 0 && u8[i + 3] === 1) {
        if (start >= 0) nals.push(u8.subarray(start, i));
        start = i + 4; i += 4; continue;
      }
    }
    i++;
  }
  if (start >= 0 && start < n) nals.push(u8.subarray(start, n));
  return nals;
}

function buildAus(nals) {
  const aus = [];
  let cur = [], curKey = false, curVcl = false;
  const push = () => {
    if (cur.length && curVcl) aus.push({ nals: cur, key: curKey });
    cur = []; curKey = false; curVcl = false;
  };
  for (const nal of nals) {
    const t = nal[0] & 0x1f;
    if (t === 9) { push(); cur.push(nal); continue; }
    if (t >= 1 && t <= 5) {
      if (curVcl) push();
      cur.push(nal); curVcl = true;
      if (t === 5) curKey = true;
    } else {
      if (curVcl) push();
      cur.push(nal);
    }
  }
  push();
  return aus;
}

function tsToAnnexB(u8) {
  const byPid = tsPacketsMap(u8);
  let pmtPid = -1;
  const patSec = sectionBytes(byPid.get(0) || []);
  if (patSec) {
    for (let i = 8; i + 4 <= patSec.length - 4; i += 4) {
      const prog = (patSec[i] << 8) | patSec[i + 1];
      const pid = ((patSec[i + 2] & 0x1f) << 8) | patSec[i + 3];
      if (prog !== 0) { pmtPid = pid; break; }
    }
  }
  if (pmtPid < 0) throw new Error('TS 里没有找到节目映射表');
  const pmtSec = sectionBytes(byPid.get(pmtPid) || []);
  if (!pmtSec) throw new Error('TS 里没有 PMT 内容');
  const seclen = ((pmtSec[1] & 0x0f) << 8) | pmtSec[2];
  const end = Math.min(pmtSec.length, 3 + seclen - 4);
  const pil = ((pmtSec[10] & 0x0f) << 8) | pmtSec[11];
  let videoPid = -1;
  for (let i = 12 + pil; i + 5 <= end; i += 5 + (((pmtSec[i + 3] & 0x0f) << 8) | pmtSec[i + 4])) {
    const st = pmtSec[i];
    const pid = ((pmtSec[i + 1] & 0x1f) << 8) | pmtSec[i + 2];
    if (st === 0x1b || st === 0x24) { videoPid = pid; break; }
  }
  if (videoPid < 0) throw new Error('TS 里没有 H.264 视频轨');
  const payloads = pesPayloads(byPid.get(videoPid) || []);
  if (!payloads.length) throw new Error('TS 里没有视频数据');
  const nals = splitNals(concatBytes(payloads));
  let sps = null, pps = null;
  for (const nal of nals) {
    const t = nal[0] & 0x1f;
    if (t === 7 && !sps) sps = nal;
    if (t === 8 && !pps) pps = nal;
  }
  const aus = buildAus(nals);
  const keyIdx = aus.findIndex((a) => a.key);
  if (keyIdx < 0) return { sps, pps, keyAu: null };
  const au = aus[keyIdx];
  const parts = [];
  if (sps && !au.nals.some((x) => (x[0] & 0x1f) === 7)) parts.push(sps);
  if (pps && !au.nals.some((x) => (x[0] & 0x1f) === 8)) parts.push(pps);
  au.nals.forEach((x) => parts.push(x));
  const pieces = [];
  parts.forEach((x) => { pieces.push(Uint8Array.from([0, 0, 0, 1]), x); });
  return { sps, pps, keyAu: concatBytes(pieces) };
}

async function posterFromTs(segs) {
  if (typeof VideoDecoder === 'undefined') throw new Error('此浏览器不支持 WebCodecs，无法预览 TS 流');
  const { sps, keyAu } = tsToAnnexB(concatBytes(segs));
  if (!sps) throw new Error('TS 流里没有找到 SPS 参数集');
  if (!keyAu) throw new Error('TS 前 6 段未找到关键帧，无法出图');
  const codec = 'avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]);
  const frames = [];
  let decErr = '';
  const dec = new VideoDecoder({
    output: (f) => frames.push(f),
    error: (e) => { decErr = String(e && e.message || e); }
  });
  try {
    dec.configure({ codec, optimizeForLatency: true });
  } catch (e) {
    throw new Error('无法初始化解码器（' + codec + '）');
  }
  try {
    dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: keyAu }));
    await dec.flush();
  } catch (e) {
    decErr = String(e && e.message || e);
  }
  try { dec.close(); } catch (e) { }
  if (!frames.length) throw new Error('解码未产出画面' + (decErr ? '：' + decErr : ''));
  const f = frames[0];
  const w = f.displayWidth || f.codedWidth;
  const h = f.displayHeight || f.codedHeight;
  const scale = Math.min(1, 640 / (w || 640));
  const c = new OffscreenCanvas(Math.max(2, Math.round((w || 640) * scale)), Math.max(2, Math.round((h || 360) * scale)));
  c.getContext('2d').drawImage(f, 0, 0, c.width, c.height);
  f.close();
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
  const poster = await blobToDataUrl(blob);
  return { ok: true, poster, w, h };
}
