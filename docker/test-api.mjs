/**
 * Snap Archive · 服务端 API 行为测试（不需要浏览器）。
 *
 *   python3 docker/make-test-corpus.py                   # 1) 生成素材
 *   SNAP_ROOTS="photos=/tmp/snap-test/待分类;store=/tmp/snap-test" \
 *     SNAP_CONFIG_FILE=/tmp/snap-config.json PORT=8005 node docker/server.mjs   # 2) 起服务
 *   node docker/test-api.mjs                             # 3) 跑断言
 *
 * 换素材根目录：SNAP_TEST_ROOT=/path/to/corpus node docker/test-api.mjs
 * 换服务地址：  BASE=http://127.0.0.1:9000 node docker/test-api.mjs
 */

import http from 'node:http'

const ROOT = process.env.SNAP_TEST_ROOT || '/tmp/snap-test'
const BASE = process.env.BASE || 'http://127.0.0.1:8005'
const PORT = Number(new URL(BASE).port || 80)

let pass = 0, fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

const jget = async (p) => {
  const r = await fetch(BASE + p)
  let body = null
  try { body = await r.json() } catch { /* 非 JSON */ }
  return { status: r.status, body }
}
const jpost = async (p, payload) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })
  let body = null
  try { body = await r.json() } catch { /* 非 JSON */ }
  return { status: r.status, body }
}
/** 原样发送未规范化的 path —— fetch/浏览器会把 URL 里的 .. 规范化掉，根本发不出去。 */
const rawGet = (p) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
    res.resume(); resolve(res.statusCode)
  })
  req.on('error', () => resolve(0))
  req.end()
})

console.log('\n— 列目录 —')
{
  const { status, body } = await jget('/api/list?path=/')
  ok(status === 200 && body.entries.length === 2, '根路径返回 2 个卷', body)
  ok(body.entries.every((e) => e.dir && e.href.endsWith('/')), '卷条目 shape 正确（dir + 尾斜杠）')
}
{
  const { body } = await jget('/api/list?path=/photos/')
  const names = body.entries.map((e) => e.name)
  ok(body.entries.length === 31, '源目录 31 个条目（30 文件 + 1 子目录）', body.entries.length)
  ok(names.includes('中文 名字 带空格.png'), '中文+空格文件名正常列出')
  ok(names.includes('位图样本.bmp'), 'bmp 正常列出')
  const dir = body.entries.find((e) => e.name === '子目录')
  ok(dir && dir.dir === true && dir.href === '/photos/子目录/', '子目录 href 带尾斜杠')
  const img = body.entries.find((e) => e.name === 'img00.png')
  ok(img && img.kind === 'image' && typeof img.url === 'string' && img.url.startsWith('/media/'),
    '图片条目带可直接 GET 的 url', img)
  ok(img && img.href === '/photos/img00.png', 'href 是纯虚拟路径（保持路径语义）', img && img.href)
  const vid = body.entries.find((e) => e.name === '假视频.mp4')
  ok(vid && vid.kind === 'video', 'mp4 识别为 video')
  const txt = body.entries.find((e) => e.name === 'note.txt')
  ok(txt && txt.kind === 'other', '非媒体文件 kind=other（前端会过滤掉）')
}
ok((await jget('/api/list?path=/photos/子目录')).status === 200, '中文子目录可列')
ok((await jget('/api/list?path=/photos/不存在')).status === 404, '不存在的目录返回 404（前端据此返回 null）')

console.log('\n— 路径安全 —')
ok((await jget('/api/list?path=/photos/../../etc')).status === 403, '.. 穿越被拒（403）')
ok((await jget('/api/list?path=/../../etc')).status === 403, '根级 .. 穿越被拒（403）')
ok((await jget('/api/list?path=/photos/%2e%2e/%2e%2e/etc')).status === 403, '%2e%2e 编码穿越被拒')
ok((await jget('/api/list?path=/etc/passwd')).status === 404, '未知卷被拒（404）')
// %2e%2e 会被 WHATWG URL 规范化成 .. 并改写路径（同样到不了磁盘，但结果是 404 而非 403）。
// 真正能穿透到服务端路径检查的是 ..%2f 这种形式，用它来考验 segs() 这道防线。
ok((await rawGet('/media/photos/..%2f..%2f..%2fetc/passwd')) === 403, '媒体端点 ..%2f 穿越被拒（403）')

console.log('\n— 符号链接逃逸（卷外的东西一个都不能读）—')
{
  const fs = await import('node:fs')
  const linkDir = `${ROOT}/待分类/逃逸软链`
  const linkFile = `${ROOT}/待分类/逃逸文件.png`
  fs.symlinkSync('/etc', linkDir)
  fs.symlinkSync('/etc/passwd', linkFile)
  ok((await jget('/api/list?path=' + encodeURIComponent('/photos/逃逸软链'))).status === 403,
    '列「软链指向卷外」的目录 → 403')
  ok((await fetch(`${BASE}/media` + encodeURI('/photos/逃逸文件.png'))).status === 403,
    '取「软链指向卷外」的文件 → 403')
  const { body } = await jget('/api/list?path=/photos/')
  ok(!body.entries.some((e) => e.name === '逃逸软链' || e.name === '逃逸文件.png'),
    '指向卷外的软链不出现在列表里')
  fs.unlinkSync(linkDir)
  fs.unlinkSync(linkFile)
}

console.log('\n— 媒体字节与 Range —')
{
  const r = await fetch(`${BASE}/media/photos/img00.png`)
  const buf = Buffer.from(await r.arrayBuffer())
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png', 'PNG content-type 正确', r.headers.get('content-type'))
  ok(buf.length > 0 && Number(r.headers.get('content-length')) === buf.length, 'content-length 与实际字节一致')
  ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '返回的确实是 PNG 字节')
  ok(r.headers.get('accept-ranges') === 'bytes', '声明 accept-ranges: bytes')
}
{
  const r = await fetch(`${BASE}/media/photos/img00.png`, { headers: { range: 'bytes=0-99' } })
  const buf = Buffer.from(await r.arrayBuffer())
  ok(r.status === 206 && buf.length === 100, 'Range 返回 206 + 100 字节', { s: r.status, n: buf.length })
  ok(/^bytes 0-99\/\d+$/.test(r.headers.get('content-range') || ''), 'content-range 格式正确', r.headers.get('content-range'))
}
ok((await fetch(`${BASE}/media/photos/不存在.png`)).status === 404, '媒体不存在返回 404')

console.log('\n— 移动：同名绝不覆盖 —')
{
  // 撤销语义：目标已有同名 + noRename → 必须冲突中止（等价于原 WebDAV 的 412），且源毫发无损
  const { status } = await jpost('/api/move', { src: '/photos/dup.png', destDir: '/store/目标A/', noRename: true })
  ok(status === 409, 'noRename 且同名 → 409（撤销据此中止）', status)
  const fs = await import('node:fs')
  ok(fs.existsSync(`${ROOT}/待分类/dup.png`), '冲突中止后源文件毫发无损')
}
{
  // 目标目录里已有一个 dup.png，源里也有 dup.png → 必须改名为 "dup (1).png"
  const { status, body } = await jpost('/api/move', { src: '/photos/dup.png', destDir: '/store/目标A/' })
  ok(status === 200, '移动成功', body)
  ok(body.finalName === 'dup (1).png', '同名改名为 "dup (1).png"（不覆盖）', body && body.finalName)
  ok(body.renamed === true, 'renamed=true')
  ok(body.destHref === '/store/目标A/dup (1).png', 'destHref 是目标虚拟路径', body && body.destHref)
  const fs = await import('node:fs')
  ok(!fs.existsSync(`${ROOT}/待分类/dup.png`), '源文件已消失')
  ok(fs.existsSync(`${ROOT}/目标A/dup.png`), '目标原有 dup.png 仍在（没被覆盖）')
  ok(fs.existsSync(`${ROOT}/目标A/dup (1).png`), '新文件以改名落地')
}
{
  const { status, body } = await jpost('/api/move', { src: '/photos/img01.png', destDir: '/store/目标B/' })
  ok(status === 200 && body.finalName === 'img01.png' && body.renamed === false, '无冲突时不改名', body)
}
ok((await jpost('/api/move', { src: '/photos/不存在.png', destDir: '/store/目标B/' })).status === 404,
  '源不存在返回 404（前端据此从列表移除）')

console.log('\n— 删除目录：只删空目录 —')
{
  // 注意：卷根本身是另一条规则（见下），这里测的是卷内的非空目录
  const { status, body } = await jpost('/api/rmdir', { path: '/store/目标A/' })
  ok(status === 409, '非空目录拒绝删除（409）', { status })
  ok(/不是空/.test(body.error || ''), '错误文案说明非空', body && body.error)
  const fs = await import('node:fs')
  ok(fs.existsSync(`${ROOT}/目标A`), '非空目录在磁盘上未被删掉')
}
{
  const fs = await import('node:fs')
  fs.mkdirSync(`${ROOT}/空目录测试`, { recursive: true })
  const { status, body } = await jpost('/api/rmdir', { path: '/store/空目录测试/' })
  ok(status === 200 && body.deleted === true, '空目录可以删')
  ok(!fs.existsSync(`${ROOT}/空目录测试`), '空目录真的被删掉了')
}
ok((await jpost('/api/rmdir', { path: '/store/' })).status === 403, '拒绝删除卷根本身（403）')
ok((await jpost('/api/rmdir', { path: '/' })).status === 403, '拒绝删除卷根列表（403）')

console.log('\n— 配置持久化 —')
{
  const put = await fetch(`${BASE}/api/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, source: { path: '/photos/', name: '待分类' }, targets: [] }),
  })
  ok(put.status === 200, 'PUT 配置成功')
  const { status, body } = await jget('/api/config')
  ok(status === 200 && body.source.path === '/photos/', 'GET 读回同一份配置', body)
}

console.log('\n— 页面 —')
{
  const r = await fetch(`${BASE}/`)
  const html = await r.text()
  ok(r.status === 200 && (r.headers.get('content-type') || '').includes('text/html'), 'GET / 返回 HTML')
  ok(html.includes('<title>Snap Archive</title>'), '返回的是 Snap Archive 页面', html.slice(0, 60))
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
process.exit(fail ? 1 : 0)
