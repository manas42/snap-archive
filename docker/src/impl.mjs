/**
 * Snap Archive · DSH 插件版——全部业务逻辑。
 *
 * 这个文件被 server.mjs 按 mtime 动态加载，所以 **改这里保存后，下一次请求就是新代码**
 * （不用重启 DSH、不用碰容器）。因此业务都集中在这一个文件里，避免拆散导致局部不重载。
 *
 * 与 mobile 版（零服务端版）的对应关系：
 *   PROPFIND 列目录        → GET  /api/list
 *   MOVE + Overwrite:F     → POST /api/move   （用 link(2)/COPYFILE_EXCL 做原子占位，绝不覆盖）
 *   COPY→校验→DELETE 兜底   → 服务端 EXDEV 兜底（同卷时零拷贝）
 *   GET 取图/视频           → GET  /media/... （支持 Range，视频可拖进度条）
 *   DELETE 空目录           → POST /api/rmdir （fs.rmdir 只删空目录，比 NAS 的 DELETE 更安全）
 *   PUT/GET snap-config.json→ GET/PUT /api/config
 *
 * 路径模型：每个挂载卷暴露成一个虚拟根段，形状与 WebDAV 的「挂载点」完全一致，
 * 于是前端的 baseOf/parentOf/normPath/labelOf 等路径工具一行都不用改。
 *   roots = "photos=/data/photos;targets=/data/targets"
 *   → 虚拟路径 /photos/2024/a.jpg     （前端 href，纯路径标识）
 *   → 媒体 URL  /media/photos/2024/a.jpg
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTE_PREFIX, API_BASE, MEDIA_BASE } from './routes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_FILE = path.join(HERE, '..', 'index.html')

const IMG = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'])
const VID = new Set(['mp4', 'webm'])
const MAX_NAME_TRIES = 50

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm',
}

/* ============================ 小工具 ============================ */

const extOf = (n) => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1).toLowerCase() }

/** 逐段百分号编码（保留 / 分隔），中文/空格/emoji 目录名都能安全进 URL。 */
const encVPath = (vp) => String(vp).split('/').map(encodeURIComponent).join('/')

/** 逐段解码 pathname —— 逐段而不是整体解码，避免 %2F 被当成路径分隔符。 */
function decodePathname(p) {
  return String(p).split('/').map((s) => { try { return decodeURIComponent(s) } catch { return s } }).join('/')
}

function json(res, code, obj, headers) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(headers || {}),
  })
  res.end(body)
}

const fail = (code, message, extra) => Object.assign(new Error(message), { httpCode: code }, extra || {})
const notFound = (m) => fail(404, m || '不存在')
const badPath = (m) => fail(403, m || '路径不合法')

/** 出错时的统一响应；响应头已发出就只收尾，免得把连接挂死。 */
function sendErr(res, e) {
  if (res.headersSent) { try { res.end() } catch { /* 已断连 */ } return }
  const code = e && e.httpCode ? e.httpCode : (e && e.code === 'ENOENT' ? 404 : 500)
  json(res, code, { error: (e && e.message) || String(e), code: (e && e.code) || null })
}

async function readJson(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw fail(413, '请求体过大')
    chunks.push(c)
  }
  const s = Buffer.concat(chunks).toString('utf8').trim()
  if (!s) return {}
  try { return JSON.parse(s) } catch { throw fail(400, 'JSON 解析失败') }
}

/**
 * 写操作的跨源校验（防 CSRF）：只比对 Origin 与 Host。
 * 没有 Origin 头的客户端（curl、同源表单）放行 —— 浏览器发起的跨源 fetch 一定带 Origin。
 */
function assertSameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return
  let host
  try { host = new URL(origin).host } catch { throw fail(403, '来源不合法') }
  if (host !== req.headers.host) throw fail(403, '跨源请求被拒绝')
}

/* ============================ 卷与路径 ============================ */

/**
 * 解析卷白名单。优先插件配置，其次环境变量 SNAP_ROOTS。
 * 格式："名称=绝对路径;名称=绝对路径"（也接受换行分隔）。
 */
function rootsOf(config) {
  const spec = String((config && config.roots) || process.env.SNAP_ROOTS || '').trim()
  const out = []
  for (const raw of spec.split(/[;\n]+/)) {
    const s = raw.trim()
    if (!s) continue
    const i = s.indexOf('=')
    if (i < 0) { out.push({ name: path.basename(s) || s, path: path.resolve(s) }); continue }
    const name = s.slice(0, i).trim()
    const p = s.slice(i + 1).trim()
    if (!name || !p) continue
    out.push({ name, path: path.resolve(p) })
  }
  return out
}

/** 卷根的 realpath 缓存（卷路径本身可能是软链，前缀比较必须用真实路径）。 */
const realCache = new Map()
async function realRoot(vol) {
  if (realCache.has(vol.path)) return realCache.get(vol.path)
  let real = vol.path
  try { real = await fsp.realpath(vol.path) } catch { /* 不存在就保持原样，后续读操作会如实报错 */ }
  realCache.set(vol.path, real)
  return real
}

/** 虚拟路径 → 段；显式拒绝 '..'（不静默钳制，免得掩盖调用方的错误）。 */
function segs(vp) {
  const out = []
  for (const p of String(vp == null ? '/' : vp).replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') throw badPath('路径不得包含 ..')
    out.push(p)
  }
  return out
}

/**
 * 解析虚拟路径。'/' 返回 null（表示"卷根"，用来列卷）。
 * 三道关：段级拒绝 .. → 拼接后必须在卷根前缀内 → realpath 后仍必须在卷根内（防软链逃逸）。
 */
async function locate(roots, vp) {
  const parts = segs(vp)
  if (parts.length === 0) return null
  const vol = roots.find((r) => r.name === parts[0])
  if (!vol) throw notFound(`未知的卷：${parts[0]}`)
  const rel = parts.slice(1).join('/')
  const base = await realRoot(vol)
  const abs = rel ? path.resolve(base, rel) : base
  if (abs !== base && !abs.startsWith(base + path.sep)) throw badPath('路径越出卷根')
  return { vol, rel, abs, base }
}

/** 目标必须存在，且 realpath 之后仍落在卷根内。 */
async function assertInside(loc) {
  let real
  try { real = await fsp.realpath(loc.abs) }
  catch (e) { if (e.code === 'ENOENT') throw notFound('目录或文件不存在'); throw e }
  if (real !== loc.base && !real.startsWith(loc.base + path.sep)) throw badPath('符号链接逃出了卷根')
  return real
}

/* ============================ 列目录 ============================ */

/**
 * 列目录。虚拟路径 '/' 返回**卷列表**（形状等价于 WebDAV 根返回挂载点列表），
 * 所以前端的目录选择器不用改就能从根浏览到各个卷。
 */
async function listEntries(roots, vp) {
  const loc = await locate(roots, vp)
  if (!loc) {
    return roots.map((r) => ({
      name: r.name, dir: true, href: `/${r.name}/`, url: null, size: 0, mtime: 0, kind: 'dir',
    }))
  }
  await assertInside(loc)
  const entries = await fsp.readdir(loc.abs, { withFileTypes: true })
  const out = []
  for (const e of entries) {
    const childAbs = path.join(loc.abs, e.name)
    let st
    try { st = await fsp.lstat(childAbs) } catch { continue }   // 断链或竞态：跳过而不是整个请求失败
    if (st.isSymbolicLink()) {
      // 软链：realpath 之后仍须落在卷内，否则不列出（免得把卷外的东西暴露进来）
      let real
      try { real = await fsp.realpath(childAbs) } catch { continue }
      if (real !== loc.base && !real.startsWith(loc.base + path.sep)) continue
      try { st = await fsp.stat(childAbs) } catch { continue }
    }
    const isDir = st.isDirectory()
    const vchild = `/${loc.vol.name}/${loc.rel ? loc.rel + '/' : ''}${e.name}`
    out.push({
      name: e.name,
      dir: isDir,
      href: isDir ? vchild + '/' : vchild,
      url: isDir ? null : MEDIA_BASE + encVPath(vchild),
      size: isDir ? 0 : st.size,
      mtime: Math.round(st.mtimeMs),
      kind: isDir ? 'dir' : (IMG.has(extOf(e.name)) ? 'image' : VID.has(extOf(e.name)) ? 'video' : 'other'),
    })
  }
  return out
}

/* ============================ 移动（分类 / 撤销） ============================ */

/**
 * 把 src 放进 destDir，**绝不覆盖**。
 *
 * 为什么不能用 rename：POSIX rename 会静默覆盖同名目标。mobile 版靠 WebDAV 的
 * `Overwrite: F` → 412 挡住；这里用 link(2)/COPYFILE_EXCL 做原子占位，
 * EEXIST 才改名重试 —— 与 412→改名重试 完全等价，但由服务端一次完成。
 *
 * @param opts.noRename - true 时目标同名直接报 409（撤销用：必须"冲突即中止"）。
 */
async function doMove(roots, srcVp, destDirVp, opts) {
  const noRename = !!(opts && opts.noRename)

  const srcLoc = await locate(roots, srcVp)
  if (!srcLoc) throw badPath('源不能是卷根')
  const srcReal = await assertInside(srcLoc)
  const srcStat = await fsp.stat(srcReal)
  if (srcStat.isDirectory()) throw fail(400, '只支持移动文件，不支持移动目录')

  const destLoc = await locate(roots, destDirVp)
  if (!destLoc) throw badPath('目标必须是卷内的目录')
  await assertInside(destLoc)
  if (!(await fsp.stat(destLoc.abs)).isDirectory()) throw fail(400, '目标不是目录')

  const name = path.basename(srcReal)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const suffix = dot > 0 ? name.slice(dot) : ''

  for (let i = 0; i < MAX_NAME_TRIES; i++) {
    const finalName = i === 0 ? name : `${stem} (${i})${suffix}`
    const destAbs = path.join(destLoc.abs, finalName)

    let mode
    try {
      mode = await placeExclusive(srcReal, destAbs)
    } catch (e) {
      if (e.code === 'EEXIST') {
        if (noRename) throw fail(409, '原位置已有同名文件', { code: 'EEXIST' })
        continue                                     // 换个名字再来，绝不覆盖
      }
      throw e
    }

    // 目标已原子落地，再删源。删源失败时如实报告（两份都在，没丢数据），不自动回滚。
    try {
      await fsp.unlink(srcReal)
    } catch (e) {
      throw fail(500, `目标已创建但删除源失败：${e.message}。目标已有副本、源仍在，请手动处理。`)
    }

    const vdest = `/${destLoc.vol.name}/${destLoc.rel ? destLoc.rel + '/' : ''}${finalName}`
    return { finalName, destHref: vdest, renamed: i > 0, mode }
  }
  throw fail(409, `同名文件过多（已试 ${MAX_NAME_TRIES} 个名字）`)
}

/**
 * 原子且不覆盖地创建 dest：优先硬链接（同设备、零拷贝、瞬时），
 * 文件系统不支持硬链接（EXDEV/EPERM/ENOTSUP…）时退化为独占复制。
 */
async function placeExclusive(src, dest) {
  try {
    await fsp.link(src, dest)
    return 'move'
  } catch (e) {
    if (e.code === 'EEXIST') throw e
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(e.code)) throw e
    await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL)   // 目标存在时同样抛 EEXIST
    // 跨设备复制：先把数据刷盘，再让调用方删源，避免掉电留下半截目标
    try { const fh = await fsp.open(dest, 'r+'); await fh.sync(); await fh.close() } catch { /* fsync 失败不致命 */ }
    return 'copy'
  }
}

/* ============================ 删除空目录 ============================ */

/**
 * 只删空目录。
 * 这里比 mobile 版更安全：该 NAS 对非空目录的 WebDAV DELETE 会**递归删掉整棵树**（实测 204），
 * 旧版只能靠前端数条目数兜底；fs.rmdir 对非空目录直接 ENOTEMPTY，服务端天然兜底。
 */
async function doRmdir(roots, vp) {
  const loc = await locate(roots, vp)
  if (!loc) throw badPath('不能删除卷根')
  if (loc.rel === '') throw badPath('不能删除卷根本身')
  await assertInside(loc)

  let entries
  try { entries = await fsp.readdir(loc.abs) }
  catch (e) { if (e.code === 'ENOENT') throw notFound('目录已经不存在了'); throw e }

  if (entries.length) {
    const names = entries.slice(0, 5).join('、')
    const more = entries.length > 5 ? ` 等共 ${entries.length} 项` : ''
    throw fail(409, `目录不是空的，不能删：还有 ${entries.length} 项（${names}${more}）。`
      + '本应用只处理图片和视频，请先在文件管理器里清空后再删。')
  }
  await fsp.rmdir(loc.abs)
  return { deleted: true }
}

/* ============================ 配置持久化 ============================ */

/** 配置落点：插件配置 > 环境变量 > <DSH_HOME>/data/snap-archive/config.json。 */
function configFileOf(config) {
  const p = String((config && config.configFile) || process.env.SNAP_CONFIG_FILE || '').trim()
  if (p) return path.resolve(p)
  const home = process.env.DSH_HOME || path.join(process.env.HOME || '.', '.dsh')
  return path.join(home, 'data', 'snap-archive', 'config.json')
}

async function readConfig(config) {
  try { return JSON.parse(await fsp.readFile(configFileOf(config), 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return null; throw fail(500, '配置读取失败：' + e.message) }
}

/** 原子写：同目录 .tmp + rename，避免半截 JSON 被读成损坏配置。 */
async function writeConfig(config, obj) {
  const file = configFileOf(config)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8')
  await fsp.rename(tmp, file)
  return file
}

/* ============================ 媒体字节 ============================ */

/** 原图/原视频字节；支持 Range，否则 `<video>` 的进度条拖不动。 */
async function serveMedia(roots, vp, req, res) {
  const loc = await locate(roots, vp)
  if (!loc) throw badPath('没有指定文件')
  const real = await assertInside(loc)
  const st = await fsp.stat(real)
  if (!st.isFile()) throw fail(400, '不是文件')
  const type = MIME[extOf(real)] || 'application/octet-stream'

  const range = req.headers.range
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(String(range).trim()) : null
  if (m) {
    let start = m[1] === '' ? null : Number(m[1])
    let end = m[2] === '' ? null : Number(m[2])
    if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1 }
    else { if (start === null) start = 0; if (end === null || end >= st.size) end = st.size - 1 }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    })
    if (req.method === 'HEAD') { res.end(); return }
    fs.createReadStream(real, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    'accept-ranges': 'bytes',
    // 与原版一致：图集与预览必须共用同一个 URL，靠浏览器校验复用缓存
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') { res.end(); return }
  fs.createReadStream(real).pipe(res)
}

/* ============================ 路由分发 ============================ */

async function serveUI(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET, HEAD' })
    return
  }
  let html
  try { html = await fsp.readFile(UI_FILE) }
  catch (e) { json(res, 500, { error: `找不到页面文件 ${UI_FILE}：${e.message}` }); return }
  // no-cache：改完 index.html 刷新即生效，不会被启发式缓存挡住
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(req.method === 'HEAD' ? undefined : html)
}

async function handleApi(req, res, config, sub, url) {
  const roots = rootsOf(config)

  if (sub === '/health') {
    const vols = []
    for (const r of roots) {
      let entries = null
      try { entries = (await fsp.readdir(await realRoot(r))).length } catch (e) { entries = 'ERROR: ' + e.code }
      vols.push({ name: r.name, path: r.path, entries })
    }
    return json(res, 200, {
      ok: true, service: 'snap-archive', node: process.version,
      roots: vols, configFile: configFileOf(config), ui: UI_FILE,
    })
  }

  if (sub === '/list') {
    if (req.method !== 'GET') return json(res, 405, { error: 'use GET' }, { allow: 'GET' })
    const p = url.searchParams.get('path') || '/'
    return json(res, 200, { path: p, entries: await listEntries(roots, p) })
  }

  if (sub === '/move') {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST' }, { allow: 'POST' })
    assertSameOrigin(req)
    const body = await readJson(req)
    if (!body || typeof body.src !== 'string' || typeof body.destDir !== 'string')
      return json(res, 400, { error: '需要 { src, destDir }' })
    return json(res, 200, await doMove(roots, body.src, body.destDir, { noRename: !!body.noRename }))
  }

  if (sub === '/rmdir') {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST' }, { allow: 'POST' })
    assertSameOrigin(req)
    const body = await readJson(req)
    if (!body || typeof body.path !== 'string') return json(res, 400, { error: '需要 { path }' })
    return json(res, 200, await doRmdir(roots, body.path))
  }

  if (sub === '/config') {
    if (req.method === 'GET') {
      const c = await readConfig(config)
      if (c === null) return json(res, 404, { error: '还没有配置文件' })
      return json(res, 200, c)
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      assertSameOrigin(req)
      const body = await readJson(req)
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return json(res, 400, { error: 'body 必须是 JSON 对象' })
      return json(res, 200, { saved: true, file: await writeConfig(config, body) })
    }
    return json(res, 405, { error: 'use GET or PUT' }, { allow: 'GET, PUT' })
  }

  return json(res, 404, { error: 'unknown api: ' + sub })
}

/**
 * 服务路由总入口（由 server.mjs 动态加载后调用）。
 * @param req - node:http 请求。
 * @param res - node:http 响应。
 * @param config - 插件配置。
 */
export async function handle(req, res, config) {
  let decoded
  try { decoded = decodePathname(new URL(req.url || '/', 'http://dsh.internal').pathname) }
  catch { json(res, 400, { error: '路径编码不合法' }); return }

  try {
    if (decoded === ROUTE_PREFIX || decoded === ROUTE_PREFIX + '/') return await serveUI(req, res)

    if (decoded === API_BASE || decoded.startsWith(API_BASE + '/')) {
      const url = new URL(req.url || '/', 'http://dsh.internal')
      return await handleApi(req, res, config, decoded.slice(API_BASE.length) || '/', url)
    }

    if (decoded.startsWith(MEDIA_BASE + '/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return json(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET, HEAD' })
      return await serveMedia(rootsOf(config), decoded.slice(MEDIA_BASE.length), req, res)
    }
  } catch (e) {
    return sendErr(res, e)
  }

  json(res, 404, { error: 'not found' })
}
