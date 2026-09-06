'use strict';

/* ============================================================
 * Snap Archive — 纯本地、无后端、键盘/鼠标驱动的图片人工分类器
 * 依赖浏览器 File System Access API（推荐 Chrome / Edge）
 * 文件夹句柄持久化到 IndexedDB（localStorage 只能存字符串，无法存句柄）
 * ============================================================ */

const SUPPORTED_EXT = new Set(['bmp', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'webm', 'mp4', 'avif']);
const VIDEO_EXT = new Set(['webm', 'mp4']);
const SORT_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']; // 前 10 个槽位才有数字快捷键
const SORT_COUNT = 20; // 目标槽位总数（第 11–20 个无数字快捷键，仅鼠标点击分类）
const MAX_UNDO = 50;
const REORDER_TYPE = 'application/x-snap-sort';
const DB_NAME = 'snap-archive';
const DB_STORE = 'handles';
const SORT_PREF_KEY = 'snap-archive-sort';
const FILTER_PREF_KEY = 'snap-archive-filter';
const SORT_NEW_FIRST = 'mtime-desc'; // 新到旧（默认）
const SORT_OLD_FIRST = 'mtime-asc';  // 旧到新
let sourceSortMode = SORT_NEW_FIRST;
try { sourceSortMode = localStorage.getItem(SORT_PREF_KEY) || SORT_NEW_FIRST; } catch (e) { /* noop */ }
if (sourceSortMode !== SORT_NEW_FIRST && sourceSortMode !== SORT_OLD_FIRST) sourceSortMode = SORT_NEW_FIRST;
// 源文件类型过滤：all=图片+视频，image=仅图片，video=仅视频
let sourceFilter = 'all';
try { sourceFilter = localStorage.getItem(FILTER_PREF_KEY) || 'all'; } catch (e) { /* noop */ }
if (!['all', 'image', 'video'].includes(sourceFilter)) sourceFilter = 'all';
// 主图视频是否自动播放（预览图总是不自动播放），偏好持久化
const AUTOPLAY_PREF_KEY = 'snap-archive-autoplay';
let autoplayVideo = true;
try { autoplayVideo = localStorage.getItem(AUTOPLAY_PREF_KEY) !== '0'; } catch (e) { /* noop */ }

function keyLabelFor(i) {
  return i < SORT_KEYS.length ? SORT_KEYS[i] : '';
}
function slotLabel(i) {
  return i < SORT_KEYS.length ? `目标 ${SORT_KEYS[i]}` : `槽位 ${i}`;
}

const state = {
  source: null,                      // { handle, name, files: FileSystemFileHandle[] }
  targets: new Array(SORT_COUNT).fill(null), // { handle, name, count }
  delTarget: null,                   // 固定 Del 槽位 { handle, name, count }
  index: 0,
  currentUrl: null,
  undoStack: [],
};

let pendingHandles = []; // 待恢复的文件夹句柄（存储中有记录、等待用户确认恢复的）
let busy = false;
let toastTimer = null;

/* ---------- DOM 引用 ---------- */
const $ = (id) => document.getElementById(id);
const sourceInfo = $('sourceInfo');
const sourceName = $('sourceName');
const changeSourceBtn = $('changeSourceBtn');
const clearBtn = $('clearBtn');
const clearTargetsBtn = $('clearTargetsBtn');
const undoBtn = $('undoBtn');
const restoreBanner = $('restoreBanner');
const restoreText = $('restoreText');
const restoreBtn = $('restoreBtn');
const dismissRestoreBtn = $('dismissRestoreBtn');
const canvas = $('canvas');
const sourceDrop = $('sourceDrop');
const preview = $('preview');
const previewStage = $('previewStage');
const fileChip = $('fileChip');
const targetPane = $('targetPane');
const stats = $('stats');
const toastEl = $('toast');
const gridBtn = $('gridBtn');
const gridModal = $('gridModal');
const gridOverlay = $('gridOverlay');
const gridClose = $('gridClose');
const gridBox = $('gridBox');
const gridPrev = $('gridPrev');
const gridNext = $('gridNext');
const gridPageInfo = $('gridPageInfo');
const gridTitle = $('gridTitle');
const gridSortNew = $('gridSortNew');
const gridSortOld = $('gridSortOld');
const filterSelect = $('filterSelect');
const autoplayCheck = $('autoplayCheck');

const slotEls = new Array(SORT_COUNT).fill(null);
let delSlotEl = null;

/* ============================================================
 * IndexedDB 持久化（文件夹句柄）
 * ============================================================ */
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function dbPut(key, handle, count) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put({ handle, count }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}
function dbGet(key) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => {
      const r = req.result;
      if (!r) return resolve(null);
      if (r.handle) return resolve(r); // 新格式 { handle, count }
      return resolve({ handle: r, count: undefined }); // 旧格式：裸句柄
    };
    req.onerror = () => reject(req.error);
  }));
}
function dbDelete(key) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}
function dbClear() {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

/* ============================================================
 * 工具函数
 * ============================================================ */
function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function toast(msg, type = 'success') {
  toastEl.textContent = msg;
  toastEl.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 2600);
}

/* ============================================================
 * 目录 / 文件操作
 * ============================================================ */
// filterMode: 'all'（默认）｜'image'（仅图片）｜'video'（仅视频）
async function listImages(dirHandle, filterMode = 'all') {
  const files = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file') continue;
    const ext = extOf(entry.name);
    if (!SUPPORTED_EXT.has(ext)) continue;
    const isVideo = VIDEO_EXT.has(ext);
    if (filterMode === 'image' && isVideo) continue;
    if (filterMode === 'video' && !isVideo) continue;
    files.push(entry);
  }
  return sortFiles(files, sourceSortMode);
}

// 按修改时间排序：mtime-desc=新到旧（默认），mtime-asc=旧到新；同时间按文件名自然序稳定排序
async function sortFiles(files, mode) {
  if (files.length <= 1) return files;
  if (mode === SORT_NEW_FIRST || mode === SORT_OLD_FIRST) {
    const metas = await Promise.all(files.map(async (f) => {
      let t = 0;
      try { t = (await f.getFile()).lastModified; } catch (e) { /* noop */ }
      return { f, t };
    }));
    const dir = mode === SORT_OLD_FIRST ? 1 : -1;
    metas.sort((a, b) => {
      if (a.t !== b.t) return (a.t - b.t) * dir;
      return a.f.name.localeCompare(b.f.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return metas.map((m) => m.f);
  }
  files.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
  return files;
}

async function countFiles(dirHandle) {
  let n = 0;
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') n++;
  }
  return n;
}

async function ensureReadwrite(handle) {
  if (typeof handle.queryPermission !== 'function') return true;
  let p = await handle.queryPermission({ mode: 'readwrite' });
  if (p === 'granted') return true;
  try {
    p = await handle.requestPermission({ mode: 'readwrite' });
  } catch (e) {
    return false;
  }
  return p === 'granted';
}

async function pickDirectory() {
  if (typeof window.showDirectoryPicker !== 'function') {
    throw new Error('请使用 Chrome 或 Edge 浏览器（需要 File System Access API）');
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e instanceof TypeError) {
      handle = await window.showDirectoryPicker();
      await ensureReadwrite(handle);
    } else {
      throw e;
    }
  }
  return handle;
}

async function getDirsFromDrop(e) {
  const items = e.dataTransfer && e.dataTransfer.items;
  if (!items || items.length === 0) return [];
  if (typeof DataTransferItem.prototype.getAsFileSystemHandle !== 'function') {
    throw new Error('请使用 Chrome 或 Edge 浏览器（需要 File System Access API）');
  }
  const dirs = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const h = await item.getAsFileSystemHandle();
    if (h && h.kind === 'directory') dirs.push(h);
  }
  return dirs;
}

async function uniqueName(dirHandle, name) {
  try { await dirHandle.getFileHandle(name); } catch (e) { return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext}`;
    try { await dirHandle.getFileHandle(candidate); } catch (e) { return candidate; }
  }
  return name;
}

async function moveFile(sourceHandle, fileHandle, targetHandle, destName) {
  if (typeof fileHandle.move === 'function') {
    await fileHandle.move(targetHandle, destName);
    return;
  }
  const file = await fileHandle.getFile();
  const dest = await targetHandle.getFileHandle(destName, { create: true });
  const w = await dest.createWritable();
  await w.write(file);
  await w.close();
  await sourceHandle.removeEntry(fileHandle.name);
}

/* ============================================================
 * 加载 / 应用 源与目标文件夹
 * ============================================================ */
async function applySource(handle, silent = false) {
  const files = await listImages(handle, sourceFilter);
  state.source = { handle, name: handle.name, files };
  state.index = 0;
  state.undoStack = [];
  renderAll();
  if (!silent) {
    if (files.length === 0) toast(`没有符合当前过滤的${sourceFilter === 'video' ? '视频' : sourceFilter === 'image' ? '图片' : '文件'}`, 'warn');
    else toast(`已载入 ${files.length} ${sourceFilter === 'video' ? '个视频' : sourceFilter === 'image' ? '张图片' : '个文件'}`);
  }
}

async function loadSource(handle) {
  await dbPut('source', handle);
  const ok = await ensureReadwrite(handle);
  await applySource(handle);
  if (!ok) toast('源文件夹暂未授权写入，首次移动时会再次请求', 'warn');
}

function resetSource() {
  state.source = null;
  state.index = 0;
  state.undoStack = [];
  if (state.currentUrl) { URL.revokeObjectURL(state.currentUrl); state.currentUrl = null; }
  revokePreviewUrls();
  previewStage.innerHTML = '';
  dbDelete('source').catch(() => {});
  renderAll();
}

// 切换源文件类型过滤（图片 / 视频 / 全部）：重扫目录并按偏好排序，
// 当前文件若仍符合新过滤则保留定位，否则回到第一张
async function setSourceFilter(mode) {
  if (!['all', 'image', 'video'].includes(mode)) return;
  sourceFilter = mode;
  try { localStorage.setItem(FILTER_PREF_KEY, mode); } catch (e) { /* noop */ }
  if (filterSelect) filterSelect.value = mode;
  if (!state.source) return;
  const cur = state.source.files[state.index] || null;
  try {
    state.source.files = await listImages(state.source.handle, sourceFilter);
    if (cur) {
      const ni = state.source.files.indexOf(cur);
      state.index = ni >= 0 ? ni : 0;
    } else {
      state.index = 0;
    }
    revokePreviewUrls();
    renderAll();
    if (state.source.files.length === 0) {
      toast('过滤后没有符合条件的文件', 'warn');
    }
  } catch (e) {
    toast('切换过滤失败：' + e.message, 'error');
  }
}

async function applyTarget(idx, handle, silent = false, cachedCount) {
  let t;
  if (typeof cachedCount === 'number') {
    t = { handle, name: handle.name, count: cachedCount, key: 'target-' + idx };
  } else if (cachedCount === null) {
    t = { handle, name: handle.name, count: null, key: 'target-' + idx }; // 后台计数
  } else {
    const count = await countFiles(handle);
    t = { handle, name: handle.name, count, key: 'target-' + idx };
  }
  state.targets[idx] = t;
  if (t.count === null) refreshTargetCount(t);
  else persistTarget(t);
  renderTargets();
  if (!silent) toast(`${slotLabel(idx)} → ${handle.name}（${t.count} 个文件）`);
}

async function loadTarget(idx, handle) {
  await applyTarget(idx, handle);
}

function clearTarget(idx) {
  state.targets[idx] = null;
  dbDelete('target-' + idx).catch(() => {});
  renderTargets();
}

async function applyDel(handle, silent = false, cachedCount) {
  let t;
  if (typeof cachedCount === 'number') {
    t = { handle, name: handle.name, count: cachedCount, key: 'del' };
  } else if (cachedCount === null) {
    t = { handle, name: handle.name, count: null, key: 'del' }; // 后台计数
  } else {
    const count = await countFiles(handle);
    t = { handle, name: handle.name, count, key: 'del' };
  }
  state.delTarget = t;
  if (t.count === null) refreshTargetCount(t);
  else persistTarget(t);
  renderTargets();
  if (!silent) toast(`固定 Del → ${handle.name}（${t.count} 个文件）`);
}

async function loadDelTarget(handle) {
  await applyDel(handle);
}

function persistTarget(t) {
  if (t && t.key) dbPut(t.key, t.handle, t.count).catch(() => {});
}

function currentTargetFor(t) {
  if (!t || !t.key) return null;
  if (t.key === 'del') return state.delTarget === t ? t : null;
  const idx = parseInt(t.key.slice('target-'.length), 10);
  return state.targets[idx] === t ? t : null;
}

async function refreshTargetCount(t) {
  try {
    const count = await countFiles(t.handle);
    if (currentTargetFor(t) === t) {
      t.count = count;
      persistTarget(t);
      renderTargets();
    }
  } catch (e) { /* ignore */ }
}

function clearDelTarget() {
  state.delTarget = null;
  dbDelete('del').catch(() => {});
  renderTargets();
}

async function loadBatch(dirs, startIdx = 0) {
  const capacity = SORT_COUNT - startIdx;
  const n = Math.min(dirs.length, capacity);
  for (let j = 0; j < n; j++) {
    await loadTarget(startIdx + j, dirs[j]);
  }
  if (dirs.length > capacity) {
    toast(`已填充 ${startIdx}–${SORT_COUNT - 1}，丢弃多余 ${dirs.length - n} 个`, 'warn');
  } else if (n > 0) {
    toast(`已载入 ${n} 个目标文件夹`);
  }
}

/* ============================================================
 * 交换：目标槽位 ⇄ 源文件夹
 * ============================================================ */
// 通用：把某个目标的 handle 提升为新源；返回旧源 handle（供放回槽位）；失败返回 null
async function promoteToSource(t) {
  if (busy) { toast('正在处理，请稍候', 'warn'); return null; }
  if (!state.source) { toast('请先载入源文件夹', 'warn'); return null; }
  if (!t) { toast('该槽位没有文件夹', 'warn'); return null; }
  const oldHandle = state.source.handle;
  try {
    await dbPut('source', t.handle); // 更新持久化记录
    await applySource(t.handle, true); // 静默载入：重置撤销栈并渲染
    return oldHandle;
  } catch (e) {
    toast('交换失败：' + e.message, 'error');
    return null;
  }
}

async function swapSourceWithSort(idx) {
  const t = state.targets[idx];
  const old = await promoteToSource(t);
  if (!old) return;
  try {
    await applyTarget(idx, old, true); // 原源文件夹放回该槽位
    toast(`已交换：${t.name} ⇄ 源文件夹`);
  } catch (e) {
    toast('交换失败：' + e.message, 'error');
  }
}

async function swapSourceWithDel() {
  const t = state.delTarget;
  const old = await promoteToSource(t);
  if (!old) return;
  try {
    await applyDel(old, true);
    toast(`已交换：${t.name} ⇄ 源文件夹`);
  } catch (e) {
    toast('交换失败：' + e.message, 'error');
  }
}

/* ============================================================
 * 图集：5×4 栅格分页浏览文件夹图片
 *  - kind=source（源文件夹）：点击缩略图定位到该图继续分类
 *  - kind=target（目标槽位）：只读预览，点击无跳转
 * ============================================================ */
const GRID_COLS = 5;
const GRID_ROWS = 4;
const GRID_PER_PAGE = GRID_COLS * GRID_ROWS;
let gridPage = 0;
let gridUrls = [];
let gridKind = 'source'; // 'source' | 'target'
let gridFiles = [];      // 当前浏览的图片句柄列表

function gridPageCount() {
  return Math.ceil(gridFiles.length / GRID_PER_PAGE);
}

// 切换排序（新到旧 / 旧到新）：作用于当前图集的 gridFiles，
// 查看源图集时同步主预览顺序并保持当前图片不丢失
async function applySourceSort(mode) {
  if (mode === sourceSortMode) { updateGridSortUI(); return; }
  const oldMode = sourceSortMode;
  sourceSortMode = mode;
  try { localStorage.setItem(SORT_PREF_KEY, mode); } catch (e) { /* noop */ }
  try {
    const cur = (gridKind === 'source' && state.source)
      ? (state.source.files[state.index] || null)
      : null;
    if (gridFiles.length > 1) {
      gridFiles = await sortFiles(gridFiles, mode);
    }
    if (gridKind === 'source' && state.source) {
      state.source.files = gridFiles;
      if (cur) {
        const ni = gridFiles.indexOf(cur);
        if (ni >= 0) state.index = ni;
      }
      renderAll(); // 保持当前文件预览与统计同步
    }
  } catch (e) {
    sourceSortMode = oldMode;
    toast('排序失败：' + e.message, 'error');
  }
  updateGridSortUI();
}

function updateGridSortUI() {
  const isNew = sourceSortMode === SORT_NEW_FIRST;
  gridSortNew.classList.toggle('active', isNew);
  gridSortOld.classList.toggle('active', !isNew);
  // 只读预览（目标槽位图集）不允许切排序：避免全局偏好与源顺序脱节
  const ro = gridKind !== 'source';
  gridSortNew.disabled = ro;
  gridSortOld.disabled = ro;
}

async function switchGridSort(mode) {
  if (gridKind !== 'source') return; // 只读预览不切排序
  if (mode === sourceSortMode) return;
  await applySourceSort(mode);
  gridPage = 0;
  await renderGridPage();
}

// 源文件夹图集：可点击跳转
async function openGrid() {
  if (!state.source) { toast('请先载入源文件夹', 'warn'); return; }
  if (state.source.files.length === 0) { toast('源文件夹中没有图片', 'warn'); return; }
  gridKind = 'source';
  gridFiles = state.source.files;
  gridTitle.textContent = `图集 · ${state.source.name}（共 ${state.source.files.length} 张）`;
  updateGridSortUI();
  gridPage = Math.floor(state.index / GRID_PER_PAGE); // 定位到当前图片所在页
  gridModal.hidden = false;
  await renderGridPage();
}

// 目标槽位图集：只读预览
async function openTargetGrid(t) {
  if (!t) { toast('该槽位没有文件夹', 'warn'); return; }
  try {
    const files = await listImages(t.handle); // 按当前排序偏好排列
    if (files.length === 0) { toast(`「${t.name}」中没有可预览的图片`, 'warn'); return; }
    gridKind = 'target';
    gridFiles = files;
    gridTitle.textContent = `图集 · ${t.name}（共 ${files.length} 张 · 只读预览）`;
    updateGridSortUI();
    gridPage = 0;
    gridModal.hidden = false;
    await renderGridPage();
  } catch (e) {
    toast('打开图集失败：' + e.message, 'error');
  }
}

function closeGrid() {
  gridModal.hidden = true;
  for (const u of gridUrls) URL.revokeObjectURL(u);
  gridUrls = [];
  gridFiles = [];
  gridBox.innerHTML = '';
}

function pickGridImage(gi) {
  if (gridKind !== 'source') return; // 只读模式不跳转
  closeGrid();
  state.index = gi;
  renderAll();
  toast(`已定位到第 ${gi + 1} 张，继续分类`);
}

async function renderGridPage() {
  for (const u of gridUrls) URL.revokeObjectURL(u);
  gridUrls = [];
  gridBox.innerHTML = '';
  gridBox.classList.toggle('readonly', gridKind !== 'source');
  const total = gridFiles.length;
  const pages = Math.max(1, gridPageCount());
  if (gridPage < 0) gridPage = 0;
  if (gridPage > pages - 1) gridPage = pages - 1;
  const start = gridPage * GRID_PER_PAGE;
  const pageFiles = gridFiles.slice(start, start + GRID_PER_PAGE);

  const cells = await Promise.all(pageFiles.map(async (fh, j) => {
    const gi = start + j;
    const fig = document.createElement('figure');
    fig.className = 'grid-item';
    // 视频格用 video 元素显示首帧缩略（静音、不自动播放）
    const isVideo = VIDEO_EXT.has(extOf(fh.name));
    const media = isVideo ? document.createElement('video') : document.createElement('img');
    media.alt = fh.name;
    if (isVideo) {
      media.muted = true;
      media.playsInline = true;
      media.preload = 'metadata';
      // 元数据就绪后回卷到首帧，让缩略图显示第一帧画面
      media.addEventListener('loadedmetadata', () => {
        try { media.currentTime = 0; } catch (e) { /* noop */ }
      }, { once: true });
    }
    try {
      const file = await fh.getFile();
      const url = URL.createObjectURL(file);
      gridUrls.push(url);
      media.src = url;
      fig.appendChild(media);
      const badge = document.createElement('span');
      badge.className = 'grid-index';
      badge.textContent = String(gi + 1);
      fig.appendChild(badge);
      if (gridKind === 'source') {
        fig.addEventListener('click', () => pickGridImage(gi));
      }
    } catch (e) {
      fig.textContent = '⚠️';
      fig.classList.add('broken');
    }
    return fig;
  }));
  for (const c of cells) gridBox.appendChild(c);

  gridPageInfo.textContent = `${gridPage + 1} / ${pages}`;
  gridPrev.disabled = gridPage === 0;
  gridNext.disabled = gridPage >= pages - 1;
}

/* ============================================================
 * 预览：三联对比——中间当前图，左侧上一张、右侧下一张
 * （两侧按 75% 宽度并减淡，点击只切换不归类；无图时该侧留空）
 *
 * 平滑策略：媒体元素与 object URL 按文件句柄缓存并复用。
 * 翻页时主画面直接“挪用”刚在侧栏解码好的相邻图元素，零重新解码；
 * 只有窗口远端新出现的图才异步补图。缓存保留当前 ±8 张。
 * ============================================================ */
const previewMediaCache = new Map(); // FileSystemFileHandle -> { handle, el, url, loading, failed }
const PREVIEW_CACHE_RADIUS = 8;
let triCells = null; // { L, M, R }

function previewCellRefs() {
  if (!triCells || !previewStage.contains(triCells.L)) {
    const L = document.createElement('div');
    L.className = 'tri-side';
    const M = document.createElement('div');
    M.className = 'tri-main';
    const R = document.createElement('div');
    R.className = 'tri-side';
    L.addEventListener('click', () => prev());
    R.addEventListener('click', () => next());
    triCells = { L, M, R };
    previewStage.appendChild(L);
    previewStage.appendChild(M);
    previewStage.appendChild(R);
  }
  return triCells;
}

// 释放并清空全部预览缓存（换源 / 重置 / 清缓存时调用）
function revokePreviewUrls() {
  for (const rec of previewMediaCache.values()) {
    if (rec.url) URL.revokeObjectURL(rec.url);
  }
  previewMediaCache.clear();
}

// 只保留当前窗口 ±RADIUS 内的缓存，窗口外的 URL 释放、元素丢弃
function prunePreviewCache(files, index) {
  if (files.length === 0) { revokePreviewUrls(); return; }
  const lo = Math.max(0, index - PREVIEW_CACHE_RADIUS);
  const hi = Math.min(files.length - 1, index + PREVIEW_CACHE_RADIUS);
  const keep = new Set();
  for (let k = lo; k <= hi; k++) keep.add(files[k]);
  for (const [h, rec] of previewMediaCache) {
    if (keep.has(h)) continue;
    if (rec.url) URL.revokeObjectURL(rec.url);
    previewMediaCache.delete(h);
  }
}

function getOrCreatePreviewMedia(handle) {
  let rec = previewMediaCache.get(handle);
  if (rec) return rec;
  const isVideo = VIDEO_EXT.has(extOf(handle.name));
  const el = isVideo ? document.createElement('video') : document.createElement('img');
  el.draggable = false;
  if (isVideo) {
    el.muted = true;
    el.playsInline = true;
    // 元数据就绪后回卷到首帧（只显示第一帧，供侧栏/未播放主图使用）
    el.addEventListener('loadedmetadata', () => {
      try { el.currentTime = 0; } catch (e) { /* noop */ }
    }, { once: true });
    // 播放状态 → 所在格中央图标：暂停 ▶ / 播放中 ⏸
    const syncCellState = () => {
      const cell = el.closest('.tri-main, .tri-side');
      if (!cell) return;
      cell.classList.toggle('playing', !el.paused);
      cell.classList.toggle('paused', el.paused);
    };
    el.addEventListener('play', syncCellState);
    el.addEventListener('pause', syncCellState);
    // 主图画面切换播放/暂停。
    // 用 pointerdown（按下即翻转）而非 click：避免与原生 controls 的
    // shadow 播放按钮事件重定向冲突（否则会“暂停一帧又恢复 / 点了不播”）。
    el.addEventListener('pointerdown', (ev) => {
      if (!el.closest('.tri-main')) return; // 侧栏交给格子做前后切换
      if (ev.button !== 0) return;          // 仅左键
      const r = el.getBoundingClientRect();
      // 原生控件区（底部进度/音量条，及右侧音量/全屏弹出）交由控件本身处理
      if (ev.clientY - r.top > r.height - 56) return;
      if (r.right - ev.clientX < 64) return;
      if (el.paused) { try { el.play().catch(() => {}); } catch (e) { /* noop */ } }
      else { el.pause(); }
    });
    // Chromium 对带 controls 的 video 有内置“点击画面切换播放/暂停”，
    // 与上面的 pointerdown 切换叠加会造成每次点击翻转两次（点一下动一下/停一帧又播）。
    // 这里吞掉 click 的 UA 默认行为，仅保留我们一次性的 pointerdown 切换。
    el.addEventListener('click', (e) => e.preventDefault());
  }
  rec = { handle, el, url: null, loading: false, failed: false };
  previewMediaCache.set(handle, rec);
  return rec;
}

async function loadPreviewMedia(rec) {
  if (rec.loading || rec.url || rec.failed) return;
  rec.loading = true;
  try {
    const file = await rec.handle.getFile();
    if (!previewMediaCache.has(rec.handle)) return; // 已被淘汰
    const url = URL.createObjectURL(file);
    rec.url = url;
    rec.el.src = url;
    if (rec.el.tagName === 'VIDEO') {
      rec.el.loop = true;
      const inMain = !!rec.el.closest('.tri-main');
      // 仅「主图 + 自动播放开启」才整段预载；其余只取元数据/首帧
      rec.el.preload = (inMain && autoplayVideo) ? 'auto' : 'metadata';
      if (inMain) {
        // 主图：是否自动播放取决于开关；关闭时停在首帧等待手动播放
        if (autoplayVideo) {
          try { await rec.el.play(); } catch (e) { /* noop */ }
        } else {
          try { rec.el.currentTime = 0; } catch (e) { /* noop */ }
        }
      } else {
        // 侧栏：不自动播放，只停在首帧
        try { rec.el.currentTime = 0; } catch (e) { /* noop */ }
      }
    }
  } catch (e) {
    rec.failed = true; // 文件不可读（可能已被移走）→ 该格留空
    previewMediaCache.delete(rec.handle);
  } finally {
    rec.loading = false;
  }
}

function applyRole(rec, role) {
  const el = rec.el;
  if (el.tagName !== 'VIDEO') return;
  if (role === 'main') {
    el.controls = true;
    if (rec.url) {
      if (autoplayVideo) {
        try { el.play().catch(() => {}); } catch (e) { /* noop */ }
      } else {
        try { el.pause(); el.currentTime = 0; } catch (e) { /* noop */ }
      }
    }
  } else {
    // 切回侧栏：停播并回到首帧
    el.controls = false;
    try { el.pause(); el.currentTime = 0; } catch (e) { /* noop */ }
  }
}

// 自动播放开关变化：应用偏好并即时作用到当前主视频
function applyAutoplayPref() {
  try { localStorage.setItem(AUTOPLAY_PREF_KEY, autoplayVideo ? '1' : '0'); } catch (e) { /* noop */ }
  const cell = triCells && triCells.M;
  const el = cell && cell.firstElementChild;
  if (!el || el.tagName !== 'VIDEO' || !el.closest('.tri-main')) return;
  if (autoplayVideo) {
    if (el.paused) { try { el.play().catch(() => {}); } catch (e) { /* noop */ } }
  } else {
    try { el.pause(); el.currentTime = 0; } catch (e) { /* noop */ }
  }
}

// 把某文件放进指定格：replaceChildren 天然完成“从旧格移动到新格”，
// 已解码的元素移动时不重载，因此主画面切换无黑屏
function placeInCell(cell, fh, role) {
  const isVideo = !!fh && VIDEO_EXT.has(extOf(fh.name));
  if (!fh) {
    cell.replaceChildren();
    cell.classList.remove('filled', 'video', 'paused', 'playing');
    return;
  }
  const rec = getOrCreatePreviewMedia(fh);
  cell.replaceChildren(rec.el);
  cell.classList.add('filled');
  if (isVideo) {
    // 中央播放图标状态：默认暂停，播放/暂停事件会同步修正
    cell.classList.add('video', 'paused');
    cell.classList.remove('playing');
  } else {
    cell.classList.remove('video', 'paused', 'playing');
  }
  applyRole(rec, role);
  loadPreviewMedia(rec); // 未加载过才真正异步读文件
}

async function renderPreview() {
  if (!state.source) { return; }
  const files = state.source.files;
  if (files.length === 0) {
    revokePreviewUrls();
    previewStage.innerHTML = '';
    fileChip.hidden = true;
    renderStats();
    return;
  }
  prunePreviewCache(files, state.index);
  const cells = previewCellRefs();

  const prevFh = state.index > 0 ? files[state.index - 1] : null;
  const curFh = files[state.index];
  const nextFh = state.index < files.length - 1 ? files[state.index + 1] : null;

  placeInCell(cells.L, prevFh, 'side');
  placeInCell(cells.M, curFh, 'main');
  placeInCell(cells.R, nextFh, 'side');

  fileChip.textContent = curFh.name;
  fileChip.hidden = false;
  renderStats();
}

function renderStats() {
  if (state.source) {
    const total = state.source.files.length;
    const cur = total === 0 ? 0 : state.index + 1;
    stats.textContent = `第 ${cur}/${total} 张 · 剩余 ${Math.max(0, total - state.index)}`;
  } else {
    stats.textContent = '';
  }
}

/* ============================================================
 * 渲染目标槽位
 * ============================================================ */
function updateSlot(slot, t, keyLabel) {
  const nameEl = slot.querySelector('.slot-name');
  const countEl = slot.querySelector('.slot-count');
  const swapEl = slot.querySelector('.slot-swap');
  const gridEl = slot.querySelector('.slot-grid');
  const clearEl = slot.querySelector('.slot-clear');
  const keyEl = slot.querySelector('.key');
  if (keyLabel) {
    keyEl.hidden = false;
    keyEl.textContent = keyLabel;
  } else {
    keyEl.hidden = true;
  }
  if (t) {
    slot.classList.add('filled');
    slot.classList.remove('empty');
    nameEl.textContent = t.name;
    countEl.textContent = t.count === null ? '…' : `${t.count} 个文件`;
    swapEl.hidden = false;
    gridEl.hidden = false;
    clearEl.hidden = false;
  } else {
    slot.classList.remove('filled');
    slot.classList.add('empty');
    nameEl.textContent = slot.classList.contains('del') ? '拖入固定文件夹' : '拖入文件夹';
    countEl.textContent = '—';
    swapEl.hidden = true;
    gridEl.hidden = true;
    clearEl.hidden = true;
  }
}

function renderTargets() {
  for (let i = 0; i < SORT_COUNT; i++) {
    updateSlot(slotEls[i], state.targets[i], keyLabelFor(i));
    slotEls[i].draggable = !!state.targets[i];
  }
  updateSlot(delSlotEl, state.delTarget, 'Del');
}

function renderAll() {
  if (state.source) {
    sourceInfo.hidden = false;
    sourceName.textContent = state.source.name;
    sourceDrop.hidden = true;
    preview.hidden = false;
  } else {
    sourceInfo.hidden = true;
    sourceDrop.hidden = false;
    preview.hidden = true;
  }
  renderPreview();
  renderTargets();
  updateUndoState();
}

// 撤销栈为空时禁用右上角「撤销」按钮（与 Ctrl+Z 同一 undo 栈）
function updateUndoState() {
  undoBtn.disabled = state.undoStack.length === 0;
}

/* ============================================================
 * 核心操作：移动 / 前进后退 / 撤销 / 排序
 * ============================================================ */
function next() {
  if (!state.source || state.source.files.length === 0) return;
  if (state.index < state.source.files.length - 1) {
    state.index++;
    renderPreview();
  } else {
    toast('已经是最后一张', 'warn');
  }
}

function prev() {
  if (!state.source || state.source.files.length === 0) return;
  if (state.index > 0) {
    state.index--;
    renderPreview();
  } else {
    toast('已经是第一张', 'warn');
  }
}

async function moveCurrentTo(target) {
  if (busy) return;
  if (!state.source) { toast('请先载入待分类文件夹', 'warn'); return; }
  if (!target) { toast('该栏位尚未指定文件夹', 'warn'); return; }
  const files = state.source.files;
  if (files.length === 0) { toast('没有待处理的图片', 'warn'); return; }

  busy = true;
  try {
    if (!(await ensureReadwrite(state.source.handle))) {
      toast('源文件夹缺少写入权限', 'error');
      return;
    }
    if (!(await ensureReadwrite(target.handle))) {
      toast('目标文件夹缺少写入权限', 'error');
      return;
    }

    const fileHandle = files[state.index];
    const originalName = fileHandle.name;
    const destName = await uniqueName(target.handle, originalName);
    await moveFile(state.source.handle, fileHandle, target.handle, destName);

    // 移动成功后再启动纯视觉动画；不 await、不阻塞下方立即切图
    flyToSlot(mainMediaEl(), slotElForTarget(target));

    files.splice(state.index, 1);
    if (state.index >= files.length) state.index = Math.max(0, files.length - 1);
    if (typeof target.count === 'number') { target.count += 1; persistTarget(target); }

    state.undoStack.push({
      fileHandle,
      sourceHandle: state.source.handle,
      targetHandle: target.handle,
      name: destName,
      originalName,
    });
    if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();

    if (files.length === 0) toast('🎉 全部处理完成');
    else toast(`已移动到 ${target.name} ✓`);
    renderAll();
  } catch (e) {
    toast('移动失败：' + e.message, 'error');
  } finally {
    busy = false;
  }
}

function moveCurrentToSort(idx) { return moveCurrentTo(state.targets[idx]); }
function moveCurrentToDel() { return moveCurrentTo(state.delTarget); }

function findTargetByHandle(h) {
  for (const t of state.targets) if (t && t.handle === h) return t;
  if (state.delTarget && state.delTarget.handle === h) return state.delTarget;
  return null;
}

async function undo() {
  if (busy) return;
  const rec = state.undoStack.pop();
  if (!rec) { toast('没有可撤销的操作', 'warn'); return; }

  busy = true;
  try {
    if (typeof rec.fileHandle.move === 'function') {
      await rec.fileHandle.move(rec.sourceHandle, rec.originalName);
    } else {
      const file = await rec.fileHandle.getFile();
      const dest = await rec.sourceHandle.getFileHandle(rec.originalName, { create: true });
      const w = await dest.createWritable();
      await w.write(file);
      await w.close();
      await rec.targetHandle.removeEntry(rec.name);
    }

    const t = findTargetByHandle(rec.targetHandle);
    if (t && typeof t.count === 'number') { t.count = Math.max(0, t.count - 1); persistTarget(t); }

    if (state.source) {
      state.source.files = await listImages(state.source.handle, sourceFilter);
      const idx = state.source.files.findIndex((f) => f.name === rec.originalName);
      if (idx >= 0) state.index = idx;
    }

    toast('已撤销 ✓');
    renderAll();
  } catch (e) {
    toast('撤销失败：' + e.message, 'error');
  } finally {
    busy = false;
  }
}

function reorderTargets(from, to) {
  if (from === to) return;
  const arr = state.targets;
  [arr[from], arr[to]] = [arr[to], arr[from]]; // 直接互换：把已有文件夹放到指定槽位
  renderTargets();
}

/* ============================================================
 * 移动飞入动画：克隆当前主图，缩小飞向目标槽位
 * ============================================================ */
// 目标对象 -> 对应槽位 DOM 元素（用于动画落点）
function slotElForTarget(t) {
  if (!t) return null;
  if (t.key === 'del') return delSlotEl;
  const idx = parseInt(t.key.slice('target-'.length), 10);
  return Number.isInteger(idx) && slotEls[idx] ? slotEls[idx] : null;
}

// 当前主画面媒体元素（中间格子里已带 src 的那个）
function mainMediaEl() {
  const cell = triCells && triCells.M;
  if (!cell || !cell.firstElementChild) return null;
  const el = cell.firstElementChild;
  return el.src ? el : null;
}

// 目标槽位闪光（与飞入动画同步，提示落点）
function flashSlot(slotEl) {
  if (!slotEl) return;
  slotEl.classList.remove('slot-flash');
  void slotEl.offsetWidth; // 强制重排以重启动画
  slotEl.classList.add('slot-flash');
  setTimeout(() => slotEl.classList.remove('slot-flash'), 620);
}

function flyToSlot(sourceEl, slotEl) {
  if (!sourceEl || !slotEl) return;
  flashSlot(slotEl); // 落点闪光与动画同时开始
  const s = sourceEl.getBoundingClientRect();
  const t = slotEl.getBoundingClientRect();
  if (s.width < 4 || s.height < 4 || t.width < 4 || t.height < 4) return;
  const ghost = sourceEl.cloneNode(true);
  if (ghost.tagName === 'VIDEO') {
    ghost.muted = true;
    ghost.loop = true;
    ghost.controls = false;
    ghost.playsInline = true;
    try { const p = ghost.play(); if (p) p.catch(() => {}); } catch (e) { /* noop */ }
  }
  const endScale = Math.min(t.width / s.width, t.height / s.height);
  const startScale = Math.max(endScale * 1.5, .28);
  ghost.className = 'fly-ghost';
  ghost.style.left = s.left + 'px';
  ghost.style.top = s.top + 'px';
  ghost.style.width = s.width + 'px';
  ghost.style.height = s.height + 'px';
  // 起点即已是小残影（不整图盖住主区），随后平移收窄飞入槽位
  ghost.style.transform = `scale(${startScale})`;
  ghost.style.opacity = '.9';
  document.body.appendChild(ghost);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const dx = (t.left + t.width / 2) - (s.left + s.width / 2);
    const dy = (t.top + t.height / 2) - (s.top + s.height / 2);
    ghost.style.transform = `translate(${dx}px, ${dy}px) scale(${endScale})`;
    ghost.style.opacity = '.1';
  }));
  setTimeout(() => ghost.remove(), 420);
}

/* ============================================================
 * 持久化：恢复 / 清空
 * ============================================================ */
async function applyStored(key, record) {
  const handle = record.handle;
  const count = typeof record.count === 'number' ? record.count : null;
  try {
    if (key === 'source') {
      await applySource(handle, true);
    } else if (key === 'del') {
      await applyDel(handle, true, count);
    } else {
      const idx = parseInt(key.slice('target-'.length), 10);
      await applyTarget(idx, handle, true, count);
    }
  } catch (e) {
    dbDelete(key).catch(() => {});
    toast(`恢复 ${handle.name} 失败：${e.message}`, 'warn');
  }
}

async function restoreFromStorage() {
  // 打开页面时不静默恢复任何文件夹：仅扫描存储里有哪些记录，
  // 收集进 pendingHandles 并弹出顶部提示条，等用户点「恢复」再真正恢复。
  const keys = ['source', ...Array.from({ length: SORT_COUNT }, (_, i) => 'target-' + i), 'del'];
  pendingHandles = [];
  try {
    for (const key of keys) {
      const record = await dbGet(key);
      if (!record || !record.handle || record.handle.kind !== 'directory') continue;
      pendingHandles.push({ key, handle: record.handle });
    }
  } catch (e) {
    console.warn('restore scan error', e);
  }
  updateRestoreBanner();
}

async function restorePending() {
  const list = pendingHandles;
  pendingHandles = [];
  let ok = 0;
  const skipped = [];
  for (const { key, handle } of list) {
    try {
      let p = 'prompt';
      try { p = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* noop */ }
      if (p !== 'granted') {
        try { p = await handle.requestPermission({ mode: 'readwrite' }); } catch (e) { /* noop */ }
      }
      try { p = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* noop */ }
      if (p === 'granted') {
        const record = await dbGet(key);
        await applyStored(key, record || { handle, count: null });
        ok++;
      } else {
        // 授权被拒：句柄仍有效则保留记录（下次打开可再问），本次跳过
        skipped.push(handle.name);
      }
    } catch (e) {
      skipped.push(handle.name);
      dbDelete(key).catch(() => {}); // 句柄已失效（如文件夹被删除），清掉记录
    }
  }
  updateRestoreBanner();
  if (skipped.length === 0) {
    if (ok > 0) toast(`已恢复上次的会话（${ok} 个文件夹）`);
  } else if (ok > 0) {
    toast(`已恢复 ${ok} 个文件夹；${skipped.length} 个未授权：${skipped.join('、')}`, 'warn');
  } else {
    toast(`未恢复：${skipped.join('、')} 授权被拒绝或不可用`, 'warn');
  }
}

function updateRestoreBanner() {
  const n = pendingHandles.length;
  restoreBanner.hidden = n === 0;
  if (n === 0) return;
  restoreText.textContent = '';
  // 提示条只点出源文件夹名，其余目标文件夹不逐个列出
  const src = pendingHandles.find((p) => p.key === 'source');
  if (src) {
    restoreText.append('检测到上次会话：');
    const strong = document.createElement('strong');
    strong.textContent = src.handle.name;
    restoreText.append(strong);
    restoreText.append('，恢复上次的文件夹配置？');
  } else {
    restoreText.textContent = `检测到上次保存的 ${n} 个文件夹，是否恢复？`;
  }
}

function dismissRestore() {
  pendingHandles = [];
  updateRestoreBanner();
}

// 清空全部目标文件夹（20 个普通槽位 + 固定 Del 槽），源文件夹与撤销栈保留
function clearAllTargets() {
  let had = false;
  for (let i = 0; i < SORT_COUNT; i++) {
    if (state.targets[i]) had = true;
    state.targets[i] = null;
    dbDelete('target-' + i).catch(() => {});
  }
  if (state.delTarget) had = true;
  state.delTarget = null;
  dbDelete('del').catch(() => {});
  renderTargets();
  if (had) toast('已清空全部目标文件夹');
  else toast('当前没有目标文件夹', 'warn');
}

async function clearAll() {
  await dbClear();
  state.source = null;
  state.targets = new Array(SORT_COUNT).fill(null);
  state.delTarget = null;
  state.index = 0;
  state.undoStack = [];
  if (state.currentUrl) { URL.revokeObjectURL(state.currentUrl); state.currentUrl = null; }
  revokePreviewUrls();
  previewStage.innerHTML = '';
  dismissRestore();
  renderAll();
  toast('已清空所有配置（磁盘文件未改动）');
}

/* ============================================================
 * 事件绑定
 * ============================================================ */
function isReorderDrag(e) {
  return Array.from(e.dataTransfer.types).includes(REORDER_TYPE);
}

function wireSourceCanvas() {
  // 空态：点击 dropzone 选择文件夹
  sourceDrop.addEventListener('click', async () => {
    try {
      const handle = await pickDirectory();
      await loadSource(handle);
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message || '选择失败', 'error');
    }
  });
  // 整个画布（空态 + 预览态）都可拖入文件夹
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); canvas.classList.add('dragover'); });
  canvas.addEventListener('dragleave', () => canvas.classList.remove('dragover'));
  canvas.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    canvas.classList.remove('dragover');
    try {
      const dirs = await getDirsFromDrop(e);
      if (dirs.length === 0) { toast('请拖入文件夹', 'error'); return; }
      await loadSource(dirs[0]);
    } catch (err) {
      toast(err.message || '读取失败', 'error');
    }
  });
}

function buildSlot(keyLabel, isDel) {
  const slot = document.createElement('div');
  slot.className = 'slot empty' + (isDel ? ' del' : '');
  slot.innerHTML = `
    <span class="grip">${isDel ? '🗑' : '⠿'}</span>
    <div class="slot-body">
      <div class="slot-name">${isDel ? '拖入固定文件夹' : '拖入文件夹'}</div>
      <div class="slot-count">—</div>
    </div>
    <div class="slot-actions">
      <span class="key">${keyLabel}</span>
      <button class="slot-swap" type="button" title="与源文件夹交换" hidden>⇄</button>
      <button class="slot-grid" type="button" title="图集预览" hidden>▦</button>
      <button class="slot-clear" type="button" title="移除该文件夹">✕</button>
    </div>`;
  return slot;
}

async function openPickerFor(i) {
  try {
    const handle = await pickDirectory();
    await loadTarget(i, handle);
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message || '选择失败', 'error');
  }
}

function wireSortSlot(slot, i) {
  const swapEl = slot.querySelector('.slot-swap');
  swapEl.addEventListener('click', (e) => { e.stopPropagation(); swapSourceWithSort(i); });
  const gridEl = slot.querySelector('.slot-grid');
  gridEl.addEventListener('click', (e) => { e.stopPropagation(); openTargetGrid(state.targets[i]); });
  const clearEl = slot.querySelector('.slot-clear');
  clearEl.addEventListener('click', (e) => { e.stopPropagation(); clearTarget(i); });

  // 单击（仅卡牌主体区域）：已填 → 分类；未填 → 选择文件夹。
  // 右侧操作区（快捷键角标 + ⇄/▦/✕）不响应分类，避免误触移动
  slot.querySelector('.slot-body').addEventListener('click', async () => {
    if (state.targets[i]) await moveCurrentTo(state.targets[i]);
    else await openPickerFor(i);
  });

  // 拖动排序
  slot.addEventListener('dragstart', (e) => {
    if (!state.targets[i]) { e.preventDefault(); return; }
    e.dataTransfer.setData(REORDER_TYPE, String(i));
    e.dataTransfer.effectAllowed = 'move';
    slot.classList.add('dragging');
  });
  slot.addEventListener('dragend', () => slot.classList.remove('dragging'));

  // 拖入文件夹
  slot.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (isReorderDrag(e)) { e.dataTransfer.dropEffect = 'move'; slot.classList.add('over-reorder'); }
    else slot.classList.add('dragover');
  });
  slot.addEventListener('dragleave', () => slot.classList.remove('dragover', 'over-reorder'));
  slot.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    slot.classList.remove('dragover', 'over-reorder');
    if (isReorderDrag(e)) {
      const from = parseInt(e.dataTransfer.getData(REORDER_TYPE), 10);
      reorderTargets(from, i);
      return;
    }
    try {
      const dirs = await getDirsFromDrop(e);
      if (dirs.length === 0) { toast('请拖入文件夹', 'error'); return; }
      if (dirs.length === 1) await loadTarget(i, dirs[0]);
      else await loadBatch(dirs, i);
    } catch (err) {
      toast(err.message || '读取失败', 'error');
    }
  });
}

function wireDelSlot(slot) {
  const swapEl = slot.querySelector('.slot-swap');
  swapEl.addEventListener('click', (e) => { e.stopPropagation(); swapSourceWithDel(); });
  const gridEl = slot.querySelector('.slot-grid');
  gridEl.addEventListener('click', (e) => { e.stopPropagation(); openTargetGrid(state.delTarget); });
  const clearEl = slot.querySelector('.slot-clear');
  clearEl.addEventListener('click', (e) => { e.stopPropagation(); clearDelTarget(); });

  slot.querySelector('.slot-body').addEventListener('click', async () => {
    if (state.delTarget) await moveCurrentTo(state.delTarget);
    else {
      try {
        const h = await pickDirectory();
        await loadDelTarget(h);
      } catch (e) {
        if (e.name !== 'AbortError') toast(e.message || '选择失败', 'error');
      }
    }
  });

  slot.addEventListener('dragover', (e) => { e.preventDefault(); slot.classList.add('dragover'); });
  slot.addEventListener('dragleave', () => slot.classList.remove('dragover'));
  slot.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    slot.classList.remove('dragover');
    try {
      const dirs = await getDirsFromDrop(e);
      if (dirs.length === 0) { toast('请拖入文件夹', 'error'); return; }
      if (dirs.length > 1) { toast('Del 槽位只能单独指定一个文件夹', 'warn'); return; }
      await loadDelTarget(dirs[0]);
    } catch (err) {
      toast(err.message || '读取失败', 'error');
    }
  });
}

function buildSlots() {
  const title = document.createElement('div');
  title.className = 'pane-title';
  title.textContent = '目标文件夹（最多 20 个 · 0–9 有快捷键）';
  targetPane.appendChild(title);

  delSlotEl = buildSlot('Del', true);
  wireDelSlot(delSlotEl);
  targetPane.appendChild(delSlotEl);

  const sep = document.createElement('hr');
  sep.className = 'del-sep';
  targetPane.appendChild(sep);

  for (let i = 0; i < SORT_COUNT; i++) {
    const slot = buildSlot(keyLabelFor(i), false);
    wireSortSlot(slot, i);
    targetPane.appendChild(slot);
    slotEls[i] = slot;
  }
}

/* 批量拖入到右侧空白处 → 依次填充 0–19 槽位 */
targetPane.addEventListener('dragover', (e) => { e.preventDefault(); });
targetPane.addEventListener('drop', async (e) => {
  if (e.target.closest('.slot')) return;
  e.preventDefault();
  try {
    const dirs = await getDirsFromDrop(e);
    if (dirs.length === 0) return;
    await loadBatch(dirs);
  } catch (err) {
    toast(err.message || '读取失败', 'error');
  }
});

document.addEventListener('keydown', (e) => {
  // 图集打开时屏蔽分类热键，仅响应 Esc 关闭
  if (!gridModal.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeGrid(); }
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    return;
  }
  if (e.altKey) return;

  const k = e.key;
  if (k === ' ' || k === 'ArrowRight') {
    e.preventDefault();
    next();
  } else if (k === 'ArrowLeft') {
    e.preventDefault();
    prev();
  } else if (k === 'Delete') {
    e.preventDefault();
    moveCurrentToDel();
  } else if (SORT_KEYS.includes(k)) {
    e.preventDefault();
    moveCurrentToSort(SORT_KEYS.indexOf(k));
  }
});

/* ============================================================
 * 计数同步：应用内移动用 ±1 即时更新，切换回页面时重扫以校准外部改动
 * ============================================================ */
async function resyncTargetCounts() {
  if (busy) return;
  for (let i = 0; i < SORT_COUNT; i++) {
    const t = state.targets[i];
    if (!t) continue;
    try { t.count = await countFiles(t.handle); persistTarget(t); } catch (e) { /* ignore */ }
  }
  if (state.delTarget) {
    try { state.delTarget.count = await countFiles(state.delTarget.handle); persistTarget(state.delTarget); } catch (e) { /* ignore */ }
  }
  renderTargets();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resyncTargetCounts();
});
window.addEventListener('focus', resyncTargetCounts);

/* ============================================================
 * 初始化
 * ============================================================ */
buildSlots();
wireSourceCanvas();
changeSourceBtn.addEventListener('click', resetSource);
undoBtn.addEventListener('click', () => undo());
clearTargetsBtn.addEventListener('click', clearAllTargets);
clearBtn.addEventListener('click', clearAll);
restoreBtn.addEventListener('click', restorePending);
dismissRestoreBtn.addEventListener('click', dismissRestore);
gridBtn.addEventListener('click', openGrid);
gridClose.addEventListener('click', closeGrid);
gridOverlay.addEventListener('click', (e) => { if (e.target === gridOverlay) closeGrid(); });
gridPrev.addEventListener('click', async () => { if (gridPage > 0) { gridPage--; await renderGridPage(); } });
gridNext.addEventListener('click', async () => { if (gridPage < gridPageCount() - 1) { gridPage++; await renderGridPage(); } });
gridSortNew.addEventListener('click', () => switchGridSort(SORT_NEW_FIRST));
gridSortOld.addEventListener('click', () => switchGridSort(SORT_OLD_FIRST));
filterSelect.addEventListener('change', () => setSourceFilter(filterSelect.value));
filterSelect.value = sourceFilter;
autoplayCheck.checked = autoplayVideo;
autoplayCheck.addEventListener('change', () => {
  autoplayVideo = autoplayCheck.checked;
  applyAutoplayPref();
});
updateGridSortUI();
renderAll();
restoreFromStorage();
