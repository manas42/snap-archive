#!/usr/bin/env node
'use strict';

/**
 * tools/count-coupling.mjs —— 复现「改造量」那个数字。
 *
 * 方案文档里写了「app.js 1760 行中，直接依赖目录/文件句柄的约 802 行、与句柄无关的约 958 行」。
 * 任何影响决策的数字都必须可复现，所以把它做成脚本：想质疑就自己跑一遍。
 *
 * 统计口径：
 *   · 逐行扫描 app.js，按 `function name(` 切成函数块（含 async function），记录每个函数的起止行。
 *   · 命中 FS_FUNCS 名单的函数计为「句柄相关」——名单是人工判定的，脚本把它打印出来供你复核。
 *   · 另统计"直接调用句柄 API"的行数（正则匹配调用点）。
 *
 * 用法：node tools/count-coupling.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'app.js');

// 人工判定：这些函数直接操作目录/文件句柄（或句柄的持久化）
const FS_FUNCS = new Set([
  'listImages', 'sortFiles', 'countFiles', 'ensureReadwrite', 'pickDirectory', 'getDirsFromDrop',
  'uniqueName', 'moveFile', 'applySource', 'loadSource', 'resetSource', 'listDirEntries',
  'dirEntryExists', 'uniqueEntryName', 'moveDirContents', 'stashLeftoversToDel', 'deleteEmptySource',
  'applyTarget', 'loadTarget', 'clearTarget', 'applyDel', 'loadDelTarget', 'persistTarget',
  'refreshTargetCount', 'refreshTargetCounts', 'isSameDir', 'dirDupLabel', 'loadBatch',
  'promoteToSource', 'swapSourceWithSort', 'swapSourceWithDel', 'applySourceSort', 'openGrid',
  'openTargetGrid', 'getOrCreatePreviewMedia', 'loadPreviewMedia', 'placeInCell', 'applyStored',
  'restoreFromStorage', 'restorePending', 'resyncTargetCounts', 'openPickerFor',
]);

const HANDLE_API = /(\.values\(\)|getFileHandle|getDirectoryHandle|createWritable|removeEntry|\.remove\(\)|queryPermission|requestPermission|\.getFile\(\)|\.move\(|createObjectURL|indexedDB|\.put\(|\.get\()/;

const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const funcs = [];
let cur = null;
for (let i = 0; i < lines.length; i++) {
  const m = /^(?:async )?function (\w+)/.exec(lines[i]);
  if (m) {
    if (cur) funcs.push({ name: cur.name, from: cur.from, to: i });   // 上一行结束
    cur = { name: m[1], from: i + 1 };
  }
}
if (cur) funcs.push({ name: cur.name, from: cur.from, to: lines.length });

const fsFuncs = funcs.filter((f) => FS_FUNCS.has(f.name));
const fsLines = fsFuncs.reduce((n, f) => n + (f.to - f.from + 1), 0);
const apiHits = lines.reduce((n, l) => n + (HANDLE_API.test(l) ? 1 : 0), 0);

const pct = (n) => ((n / lines.length) * 100).toFixed(1);
console.log(`文件：${path.relative(ROOT, FILE)}`);
console.log(`总行数：${lines.length}`);
console.log('');
console.log(`句柄相关函数：${fsFuncs.length} 个，共 ${fsLines} 行（${pct(fsLines)}%）`);
console.log(`其余行数：${lines.length - fsLines}（${pct(lines.length - fsLines)}%）`);
console.log(`直接出现句柄 API 的行：${apiHits} 行`);
console.log('');
console.log('被判为「句柄相关」的函数：');
for (const f of fsFuncs) console.log(`  ${String(f.from).padStart(5)}-${String(f.to).padEnd(5)} ${f.name}  (${f.to - f.from + 1} 行)`);
console.log('');
console.log('未命中的函数（即假设可原样复用的部分）：');
for (const f of funcs.filter((f) => !FS_FUNCS.has(f.name))) {
  console.log(`  ${String(f.from).padStart(5)}-${String(f.to).padEnd(5)} ${f.name}  (${f.to - f.from + 1} 行)`);
}
