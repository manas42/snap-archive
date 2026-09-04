'use strict';

/* ============================================================
 * Snap Archive — 纯本地、无后端、键盘/鼠标驱动的图片人工分类器
 * 依赖浏览器 File System Access API（推荐 Chrome / Edge）
 * 文件夹句柄持久化到 IndexedDB（localStorage 只能存字符串，无法存句柄）
 * ============================================================ */

const SUPPORTED_EXT = new Set(['bmp', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'webm', 'avif']);
const VIDEO_EXT = new Set(['webm']);
const SORT_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const SORT_COUNT = 10;
const MAX_UNDO = 50;
const REORDER_TYPE = 'application/x-snap-sort';
const DB_NAME = 'snap-archive';
const DB_STORE = 'handles';

const state = {
  source: null,                      // { handle, name, files: FileSystemFileHandle[] }
  targets: new Array(SORT_COUNT).fill(null), // { handle, name, count }
  delTarget: null,                   // 固定 Del 槽位 { handle, name, count }
  index: 0,
  currentUrl: null,
  undoStack: [],
};

let pendingHandles = [];
let busy = false;
let toastTimer = null;

/* ---------- DOM 引用 ---------- */
const $ = (id) => document.getElementById(id);
const sourceInfo = $('sourceInfo');
const sourceName = $('sourceName');
const changeSourceBtn = $('changeSourceBtn');
const clearBtn = $('clearBtn');
const restoreBanner = $('restoreBanner');
const restoreText = $('restoreText');
const restoreBtn = $('restoreBtn');
const canvas = $('canvas');
const sourceDrop = $('sourceDrop');
const preview = $('preview');
const previewStage = $('previewStage');
const fileChip = $('fileChip');
const targetPane = $('targetPane');
const stats = $('stats');
const toastEl = $('toast');

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

function dbPut(key, handle) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}
function dbGet(key) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
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
async function listImages(dirHandle) {
  const files = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file') continue;
    if (SUPPORTED_EXT.has(extOf(entry.name))) files.push(entry);
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
  const files = await listImages(handle);
  state.source = { handle, name: handle.name, files };
  state.index = 0;
  state.undoStack = [];
  renderAll();
  if (!silent) {
    if (files.length === 0) toast('该文件夹中没有支持的图片文件', 'warn');
    else toast(`已载入 ${files.length} 张图片`);
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
  previewStage.innerHTML = '';
  dbDelete('source').catch(() => {});
  renderAll();
}

async function applyTarget(idx, handle, silent = false) {
  const count = await countFiles(handle);
  state.targets[idx] = { handle, name: handle.name, count };
  renderTargets();
  if (!silent) toast(`目标 ${SORT_KEYS[idx]} → ${handle.name}（${count} 个文件）`);
}

async function loadTarget(idx, handle) {
  await dbPut('target-' + idx, handle);
  await applyTarget(idx, handle);
}

function clearTarget(idx) {
  state.targets[idx] = null;
  dbDelete('target-' + idx).catch(() => {});
  renderTargets();
}

async function applyDel(handle, silent = false) {
  const count = await countFiles(handle);
  state.delTarget = { handle, name: handle.name, count };
  renderTargets();
  if (!silent) toast(`固定 Del → ${handle.name}（${count} 个文件）`);
}

async function loadDelTarget(handle) {
  await dbPut('del', handle);
  await applyDel(handle);
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
 * 预览
 * ============================================================ */
async function renderPreview() {
  if (!state.source) return;
  if (state.source.files.length === 0) {
    previewStage.innerHTML = '';
    fileChip.hidden = true;
    renderStats();
    return;
  }

  const fileHandle = state.source.files[state.index];
  let file;
  try {
    file = await fileHandle.getFile();
  } catch (e) {
    toast('读取文件失败：' + e.message, 'error');
    return;
  }

  if (state.currentUrl) URL.revokeObjectURL(state.currentUrl);
  const url = URL.createObjectURL(file);
  state.currentUrl = url;

  previewStage.innerHTML = '';
  const isVideo = VIDEO_EXT.has(extOf(file.name));
  const media = isVideo ? document.createElement('video') : document.createElement('img');
  if (isVideo) {
    media.autoplay = true;
    media.loop = true;
    media.muted = true;
    media.controls = true;
  }
  media.src = url;
  media.addEventListener('error', () => toast('无法预览该文件', 'warn'));
  previewStage.appendChild(media);

  fileChip.textContent = file.name;
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
  const clearEl = slot.querySelector('.slot-clear');
  const keyEl = slot.querySelector('.key');
  keyEl.textContent = keyLabel;
  if (t) {
    slot.classList.add('filled');
    slot.classList.remove('empty');
    nameEl.textContent = t.name;
    countEl.textContent = `${t.count} 个文件`;
    clearEl.hidden = false;
  } else {
    slot.classList.remove('filled');
    slot.classList.add('empty');
    nameEl.textContent = slot.classList.contains('del') ? '拖入固定文件夹' : '拖入文件夹';
    countEl.textContent = '—';
    clearEl.hidden = true;
  }
}

function renderTargets() {
  for (let i = 0; i < SORT_COUNT; i++) {
    updateSlot(slotEls[i], state.targets[i], SORT_KEYS[i]);
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

    files.splice(state.index, 1);
    if (state.index >= files.length) state.index = Math.max(0, files.length - 1);
    target.count += 1;

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
    if (t) t.count = Math.max(0, t.count - 1);

    if (state.source) {
      state.source.files = await listImages(state.source.handle);
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
  const [item] = arr.splice(from, 1);
  const insertAt = from < to ? to - 1 : to;
  arr.splice(insertAt, 0, item);
  renderTargets();
}

/* ============================================================
 * 持久化：恢复 / 清空
 * ============================================================ */
async function applyStored(key, handle) {
  try {
    if (key === 'source') {
      await dbPut('source', handle);
      await applySource(handle, true);
    } else if (key === 'del') {
      await dbPut('del', handle);
      await applyDel(handle, true);
    } else {
      const idx = parseInt(key.slice('target-'.length), 10);
      await dbPut(key, handle);
      await applyTarget(idx, handle, true);
    }
  } catch (e) {
    dbDelete(key).catch(() => {});
    toast(`恢复 ${handle.name} 失败：${e.message}`, 'warn');
  }
}

async function restoreFromStorage() {
  const keys = ['source', ...SORT_KEYS.map((_, i) => 'target-' + i), 'del'];
  try {
    for (const key of keys) {
      const handle = await dbGet(key);
      if (!handle || handle.kind !== 'directory') continue;
      let p = 'prompt';
      try { p = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* noop */ }
      if (p === 'granted') await applyStored(key, handle);
      else pendingHandles.push({ key, handle });
    }
  } catch (e) {
    console.warn('restore error', e);
  }
  updateRestoreBanner();
}

async function restorePending() {
  const list = pendingHandles;
  pendingHandles = [];
  for (const { key, handle } of list) {
    try {
      let p = 'prompt';
      try { p = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* noop */ }
      if (p !== 'granted') {
        try { p = await handle.requestPermission({ mode: 'readwrite' }); } catch (e) { /* noop */ }
      }
      try { p = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* noop */ }
      if (p === 'granted') await applyStored(key, handle);
      else pendingHandles.push({ key, handle });
    } catch (e) {
      dbDelete(key).catch(() => {});
    }
  }
  updateRestoreBanner();
  if (pendingHandles.length === 0) toast('已恢复上次的文件夹');
  else toast(`仍有 ${pendingHandles.length} 个文件夹未授权`, 'warn');
}

function updateRestoreBanner() {
  const n = pendingHandles.length;
  restoreBanner.hidden = n === 0;
  if (n > 0) {
    const names = pendingHandles.map((p) => p.handle.name).join('、');
    restoreText.textContent = `上次有 ${n} 个文件夹需要重新授权：${names}`;
  }
}

async function clearAll() {
  await dbClear();
  state.source = null;
  state.targets = new Array(SORT_COUNT).fill(null);
  state.delTarget = null;
  state.index = 0;
  state.undoStack = [];
  if (state.currentUrl) { URL.revokeObjectURL(state.currentUrl); state.currentUrl = null; }
  previewStage.innerHTML = '';
  pendingHandles = [];
  updateRestoreBanner();
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
    <span class="key">${keyLabel}</span>
    <button class="slot-clear" type="button" title="移除该文件夹">✕</button>`;
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
  const clearEl = slot.querySelector('.slot-clear');
  clearEl.addEventListener('click', (e) => { e.stopPropagation(); clearTarget(i); });

  // 单击：已填 → 分类；未填 → 选择文件夹
  slot.addEventListener('click', async () => {
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
  const clearEl = slot.querySelector('.slot-clear');
  clearEl.addEventListener('click', (e) => { e.stopPropagation(); clearDelTarget(); });

  slot.addEventListener('click', async () => {
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
  title.textContent = '目标文件夹（单击分类 · 拖入指定）';
  targetPane.appendChild(title);

  SORT_KEYS.forEach((key, i) => {
    const slot = buildSlot(key, false);
    wireSortSlot(slot, i);
    targetPane.appendChild(slot);
    slotEls[i] = slot;
  });

  const sep = document.createElement('hr');
  sep.className = 'del-sep';
  targetPane.appendChild(sep);

  delSlotEl = buildSlot('Del', true);
  wireDelSlot(delSlotEl);
  targetPane.appendChild(delSlotEl);
}

/* 批量拖入到右侧空白处 → 依次填充 0–9 槽位 */
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
    try { t.count = await countFiles(t.handle); } catch (e) { /* ignore */ }
  }
  if (state.delTarget) {
    try { state.delTarget.count = await countFiles(state.delTarget.handle); } catch (e) { /* ignore */ }
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
clearBtn.addEventListener('click', clearAll);
restoreBtn.addEventListener('click', restorePending);
renderAll();
restoreFromStorage();
