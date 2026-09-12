#!/usr/bin/env node
'use strict';

/**
 * V0 纵切 —— 最小可跑的网关原型（约 120 行，唯一依赖 sharp）。
 *
 * 它要证明的事情只有一件：**手机能不能通过一个跑在 NAS 上的容器，快速看到 NAS 上照片的缩略图。**
 * 这一件事同时验证了：容器能跑、绑定挂载能读到照片目录、sharp 能出图、端口通、手机能连、中文路径没问题。
 * 这六件事里任何一件不成立，整个「网关方案」就要换形态 —— 所以先花半天把它跑通，再写正式代码。
 *
 * 环境变量：
 *   SNAP_ROOTS=/data     照片根目录（容器内路径）
 *   SNAP_CACHE=/cache    缩略图缓存目录
 *   PORT=8787
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const ROOT = path.resolve(process.env.SNAP_ROOTS || '/data');
const CACHE = path.resolve(process.env.SNAP_CACHE || '/cache');
const PORT = Number(process.env.PORT || 8787);
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);
const VID_EXT = new Set(['.mp4', '.webm']);

await fsp.mkdir(CACHE, { recursive: true });

/** 把外部传入的相对路径安全地解析到 ROOT 之内。
 *  三道关：① 显式拒绝 ".." 与绝对路径（不静默钳制，免得掩盖调用方的错误）
 *          ② 解析后必须落在 ROOT 前缀内
 *          ③ realpath 解析符号链接后仍必须落在 ROOT 内（防软链逃逸）
 */
function safeResolve(rel) {
  const clean = String(rel ?? '').replace(/\\/g, '/');
  const bad = (msg) => Object.assign(new Error(msg), { code: 'EBADPATH' });
  if (clean.split('/').includes('..')) throw bad('path must not contain ".."');
  if (path.isAbsolute(clean)) throw bad('absolute path not allowed');
  const p = path.resolve(ROOT, clean);
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw bad('path escapes root');
  return p;
}

/** 符号链接解析后再次校验（list/thumb 这类真正访问磁盘的入口都要过这一关） */
async function realWithinRoot(p) {
  const rp = await fsp.realpath(p);
  if (rp !== ROOT && !rp.startsWith(ROOT + path.sep)) {
    throw Object.assign(new Error('symlink escapes root'), { code: 'EBADPATH' });
  }
  return rp;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function listDir(rel) {
  const dir = await realWithinRoot(safeResolve(rel));
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    const kind = IMG_EXT.has(ext) ? 'image' : VID_EXT.has(ext) ? 'video' : null;
    if (!kind) continue;
    const st = await fsp.stat(path.join(dir, e.name));
    out.push({ name: e.name, kind, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  out.sort((a, b) => b.mtime - a.mtime);   // 新 → 旧
  return out;
}

async function thumb(relPath, w, res) {
  const src = await realWithinRoot(safeResolve(relPath));
  const st = await fsp.stat(src);
  // 缓存键必须带 size：只靠"路径+mtime(毫秒)"在极快替换时仍可能误命中
  const key = crypto.createHash('sha1')
    .update(`${relPath}|${st.mtimeMs}|${st.size}|${w}`).digest('hex').slice(0, 32);
  const cached = path.join(CACHE, key + '.webp');

  if (!fs.existsSync(cached)) {
    const buf = await fsp.readFile(src);                 // 用 buffer 喂 sharp：规避超长路径（ENAMETOOLONG）
    const tmp = cached + '.' + process.pid + '.tmp';
    await sharp(buf, { animated: false, limitInputPixels: 512 * 1024 * 1024 })
      .rotate()                                          // ← 无参 rotate() = 按 EXIF 自动旋转，手机竖拍照片才不会躺倒
      .resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(tmp);
    await fsp.rename(tmp, cached);                       // 原子落盘：避免半截文件被永久缓存
  }
  const data = await fsp.readFile(cached);
  res.writeHead(200, {
    'Content-Type': 'image/webp',
    'Content-Length': data.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: `"${key}"`,
  });
  res.end(data);
}

const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>V0 纵切 · 手机看 NAS 缩略图</title>
<style>
 body{margin:0;padding:12px;background:#0d1117;color:#c9d1d9;font:15px/1.6 -apple-system,"Noto Sans CJK SC",sans-serif;overscroll-behavior:none}
 h1{font-size:17px;margin:0 0 4px} .m{color:#8b949e;font-size:13px;margin-bottom:12px}
 .g{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}
 figure{margin:0;background:#161b22;border:1px solid #30363d;border-radius:10px;overflow:hidden}
 img{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#21262d}
 figcaption{font-size:11px;padding:4px 6px;color:#8b949e;word-break:break-all;line-height:1.35}
</style>
<h1>V0 纵切</h1><div class="m" id="m">加载中…</div><div class="g" id="g"></div>
<script>
fetch('/api/list').then(r=>r.json()).then(d=>{
  document.getElementById('m').textContent = '共 '+d.total+' 个媒体文件 · 根目录 '+d.root;
  document.getElementById('g').innerHTML = d.entries.slice(0,60).map(e=>
    '<figure><img loading="lazy" src="/api/thumb?path='+encodeURIComponent(e.name)+'&w=400" alt="">'+
    '<figcaption>'+e.name.replace(/</g,'&lt;')+'</figcaption></figure>').join('');
}).catch(e=>{document.getElementById('m').textContent='失败：'+e;});
</script>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/' ) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/health') {
      const probe = await fsp.readdir(ROOT).then((l) => l.length).catch((e) => 'ERROR: ' + e.code);
      return json(res, 200, { ok: true, root: ROOT, cache: CACHE, rootEntries: probe, node: process.version });
    }
    if (u.pathname === '/api/list') {
      const rel = u.searchParams.get('path') || '';
      const entries = await listDir(rel);
      return json(res, 200, { root: ROOT, path: rel, total: entries.length, entries });
    }
    if (u.pathname === '/api/thumb') {
      const rel = u.searchParams.get('path');
      const w = Math.min(2048, Math.max(64, Number(u.searchParams.get('w') || 800)));
      if (!rel) return json(res, 400, { error: 'path required' });
      return await thumb(rel, w, res);
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    const code = e.code === 'ENOENT' ? 404 : (e.code === 'EACCES' || e.code === 'EBADPATH') ? 403 : 500;
    json(res, code, { error: e.message, code: e.code || null });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`V0 纵切已启动  http://0.0.0.0:${PORT}`);
  console.log(`  SNAP_ROOTS=${ROOT}  SNAP_CACHE=${CACHE}`);
});
