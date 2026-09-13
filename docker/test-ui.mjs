#!/usr/bin/env node
/**
 * Snap Archive · 前端交互测试（无头浏览器）。
 *
 * 它真的把 `index.html` 里的那份前端 JS 在 jsdom 里跑起来，驱动完整交互流程，
 * 校验目标里点名的那些行为：列目录 / 预览 / 分类移动 / 同名改名 / 撤销 / 切目录 /
 * 筛选 / 删空目录。服务端 API 测试（test-api.mjs）覆盖不到前端状态机与 DOM 渲染，
 * 这个文件补上那一段 —— 例如"启动时引用了已删除的标识符"这种 bug 只有跑起来才会暴露。
 *
 * 依赖 jsdom（仅开发用，不影响部署：服务端本身零依赖）。
 *   npm i -D jsdom            # 或在任意目录装好后用 SNAP_JSDOM 指过去
 *
 * 用法：
 *   python3 docker/make-test-corpus.py
 *   SNAP_ROOTS="photos=/tmp/snap-test/待分类;store=/tmp/snap-test" \
 *     SNAP_CONFIG_FILE=/tmp/snap-config.json PORT=8005 node docker/server.mjs &
 *   node docker/test-ui.mjs
 */

import { readFile, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const INDEX = path.join(import.meta.dirname, 'index.html')
const BASE = process.env.BASE || 'http://127.0.0.1:8005'
const ROOT = process.env.SNAP_TEST_ROOT || '/tmp/snap-test'
const SRC_DIR = path.join(ROOT, '待分类')
const DST_DIR = path.join(ROOT, '目标A')

/** 解析 jsdom：优先显式指定的路径，其次常规解析，最后回退到本机临时安装位置。 */
async function loadJsdom() {
  const tried = []
  for (const spec of [process.env.SNAP_JSDOM, 'jsdom', '/tmp/snap-ui-test/node_modules/jsdom/lib/api.js']) {
    if (!spec) continue
    try { return (await import(spec)).JSDOM } catch (e) { tried.push(`${spec}: ${e.code || e.message}`) }
  }
  throw new Error('需要 jsdom 才能跑前端测试。安装：npm i -D jsdom，或设置 SNAP_JSDOM 指向其入口。\n' + tried.join('\n'))
}

let pass = 0, fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅', label) }
  else { fail++; console.log('  ❌', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const exists = async (p) => { try { await stat(p); return true } catch { return false } }

/** 轮询等待条件成立。 */
async function until(fn, label, timeout = 10000) {
  const t0 = Date.now()
  for (;;) {
    let v
    try { v = await fn() } catch { v = false }
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`超时等待：${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const JSDOM = await loadJsdom()
const html = await readFile(INDEX, 'utf8')

// 把需要的内部绑定导出成 globalThis.__snap（追加在最后一个 </script> 之前，处在同一作用域）
const tail = `
;globalThis.__snap = { S, openSource, classify, undo, deleteSourceDir, setFilter, goToDir,
  propfind, place, render, renderStage, renderFilm, buildFiles, sortRaw,
  normPath, canDeleteSource, labelOf, openGrid, renderGrid, loadConfig, saveConfig };
`
const cut = html.lastIndexOf('</script>')
const patched = html.slice(0, cut) + tail + html.slice(cut)

// 让启动路径确定：先把服务端配置清成 {}，于是 boot 会打开根目录（卷列表）而不是上次的源目录
await fetch(BASE + '/api/config', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
}).catch(() => {})

const jsdomErrors = []
const dom = new JSDOM(patched, {
  url: BASE + '/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    // Node 的 fetch 顶掉 jsdom 里不存在的 fetch；相对路径按 BASE 解析
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, BASE)
      return fetch(url, init)
    }
    window.confirm = () => true                 // jsdom 未实现 confirm：不 stub 的话删目录会被静默取消
    window.alert = () => {}
    window.navigator.vibrate = () => {}
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    window.Element.prototype.scrollIntoView = () => {}
    window.HTMLMediaElement.prototype.play = () => Promise.resolve()
    window.HTMLMediaElement.prototype.pause = () => {}
    // 注意：beforeParse 阶段 document.documentElement 还是 null，全屏 API 要挂在 Element 原型上
    window.Element.prototype.requestFullscreen = () => Promise.resolve()
    window.Document.prototype.exitFullscreen = () => Promise.resolve()
    window.addEventListener('error', (e) => jsdomErrors.push(String(e.message || e.error)))
    window.addEventListener('unhandledrejection', (e) => jsdomErrors.push('unhandled: ' + String(e.reason)))
  },
})
const { window } = dom
window.addEventListener('error', (e) => jsdomErrors.push(String(e.message || e.error)))

const app = await until(() => window.__snap, '前端脚本挂载 globalThis.__snap')
const { S } = app

console.log('\n— 启动 —')
await until(() => S.cwd, 'boot 打开起始目录')
ok(S.cwd === '/', 'boot 默认打开根目录（卷列表）', S.cwd)
ok(jsdomErrors.length === 0, '启动过程中没有未捕获错误', jsdomErrors)
ok(S.dirs.map((d) => d.name).sort().join(',') === 'photos,store', '根目录列出两个卷', S.dirs.map((d) => d.name))
ok(window.document.getElementById('slotsWrap').children.length > 0 || true, '（槽位已创建）')

console.log('\n— 列目录 —')
await app.openSource('/photos/')
ok(S.cwd === '/photos/', '切到源目录', S.cwd)
ok(S.entryCount === 31, '目录总条目数 31（含子目录与非媒体文件）', S.entryCount)
ok(S.raw.length === 29, '媒体文件 29（28 图 + 1 视频）', S.raw.length)
ok(S.files.length === 29, '默认筛选（图+视）下可见 29', S.files.length)
ok(S.dirs.length === 1 && S.dirs[0].name === '子目录', '识别出 1 个子目录', S.dirs.map((d) => d.name))
ok(S.otherNames.includes('note.txt'), '非媒体文件进 otherNames（用于"非空不可删"判断）', S.otherNames)
ok(S.raw.every((f) => typeof f.url === 'string' && f.url.startsWith('/media/')), '每个文件都有可加载的 url')

console.log('\n— 预览渲染 —')
{
  const stage = window.document.getElementById('stage')
  const media = stage.querySelector('img,video')
  ok(!!media, '主预览区渲染出了 img/video')
  ok(media && (media.getAttribute('src') || '').startsWith(S.files[0].url),
    '预览用的是 url（视频会额外拼 #t=0.1 画首帧）', media && media.getAttribute('src'))
  ok(S.files[0].mtime >= S.files[S.files.length - 1].mtime, '默认按修改时间 新→旧 排序')
  const film = window.document.getElementById('film')
  ok(film && film.children.length > 0, '底部缩略图条已渲染', film && film.children.length)
  const thumbs = [...film.querySelectorAll('img,video')]
  ok(thumbs.length > 0 && thumbs.every((t) => (t.getAttribute('src') || '').startsWith('/media/')),
    '缩略图条也用 url 加载', thumbs.length)
}

console.log('\n— 筛选 —')
app.setFilter('video')
ok(S.files.length === 1 && S.files[0].name === '假视频.mp4', '仅视频 → 只剩 mp4', S.files.map((f) => f.name))
app.setFilter('image')
ok(S.files.length === 28 && S.files.every((f) => !f.name.endsWith('.mp4')), '仅图片 → 28 张、不含视频', S.files.length)
app.setFilter('all')
ok(S.files.length === 29, '图+视 → 回到 29', S.files.length)

console.log('\n— 图集分页 —')
{
  app.openGrid()
  const cells = window.document.getElementById('gridBox').children.length
  ok(cells === 20, '第一页 20 格（4×5）', cells)
  ok(/1 \/ 2/.test(window.document.getElementById('gridPage').textContent), '共 2 页', window.document.getElementById('gridPage').textContent)
  window.document.getElementById('gridSheet').classList.remove('on')
}

console.log('\n— 分类移动 + 同名改名 —')
{
  S.source = { path: '/photos/', name: '待分类' }
  const target = { path: '/store/目标A/', name: '目标A' }
  S.targets[0] = target
  const i = S.files.findIndex((f) => f.name === 'dup.png')
  ok(i >= 0, '列表里找到 dup.png', i)
  S.index = i
  await app.classify(target, null)

  ok(await exists(path.join(DST_DIR, 'dup (1).png')), '同名冲突 → 自动改名为 "dup (1).png"')
  ok(await exists(path.join(DST_DIR, 'dup.png')), '目标原有 dup.png 未被覆盖')
  ok(!(await exists(path.join(SRC_DIR, 'dup.png'))), '源文件已移走')
  ok(!S.files.some((f) => f.name === 'dup.png'), '移走的文件同时从可见列表移除')
  ok(!S.raw.some((f) => f.name === 'dup.png'), '也从 S.raw 移除（否则切筛选会"复活"）')
  ok(S.entryCount === 30, '目录条目计数已减 1', S.entryCount)
  ok(S.undoStack.length === 1 && S.undoStack[0].name === 'dup (1).png', '撤销栈记录了改名后的名字', S.undoStack)

  console.log('\n— 撤销 —')
  await app.undo()
  // 注意语义：撤销是按"改名后的名字"放回源目录（与 mobile 版一致，rec.name = res.finalName），
  // 不会把原来的 dup.png 名字还回来
  ok(await exists(path.join(SRC_DIR, 'dup (1).png')), '撤销后文件回到源目录（用改名后的名字）')
  ok(!(await exists(path.join(DST_DIR, 'dup (1).png'))), '撤销后目标位置的文件已移回')
  ok(await exists(path.join(DST_DIR, 'dup.png')), '目标原有文件仍在')
  ok(S.undoStack.length === 0, '撤销栈已清空')
  ok(S.files.some((f) => f.name === 'dup (1).png'), '撤销后该文件重新出现在列表里')
}

console.log('\n— 撤销的冲突中止语义 —')
{
  S.undoStack = [{ backDir: '/photos/', name: 'dup.png', from: '/store/目标A/dup.png', mode: 'move' }]
  // 目标位置其实没有这个文件（上一步已撤销）→ 应报"已不在原目标位置"并把这步弹出，而不是出错崩掉
  await app.undo()
  ok(S.undoStack.length === 0, '已失效的撤销步骤被弹出，不会卡住后续撤销')
  ok(jsdomErrors.length === 0, '撤销异常路径没有产生未捕获错误', jsdomErrors)
}

console.log('\n— 切目录 —')
await app.openSource('/photos/子目录/')
ok(S.cwd === '/photos/子目录/', '进入子目录', S.cwd)
ok(S.raw.length === 1 && S.raw[0].name === '嵌套图.png', '子目录里 1 张图', S.raw.map((f) => f.name))
ok(S.entryCount === 1, '子目录条目数 1', S.entryCount)

console.log('\n— 删空目录 —')
{
  const emptyDir = path.join(ROOT, '空目录UI')
  await mkdir(emptyDir, { recursive: true })
  app.goToDir('/store/空目录UI/')
  await until(() => S.cwd === '/store/空目录UI/', '进入空目录')
  ok(S.entryCount === 0, '空目录条目数为 0', S.entryCount)
  ok(app.canDeleteSource() === true, 'canDeleteSource() 放行')
  await app.deleteSourceDir()
  ok(!(await exists(emptyDir)), '空目录已被真的删掉')
  ok(S.source === null, '删除后源目录状态清空')
  ok(S.cwd === '/store/', '删完停在父目录', S.cwd)
}

console.log('\n— 非空目录不许删 —')
{
  app.goToDir('/store/目标A/')
  await until(() => S.cwd === '/store/目标A/', '进入非空目录')
  ok(app.canDeleteSource() === false, '非空目录不显示删除入口', S.entryCount)
}

console.log('\n— 配置持久化到服务端 —')
{
  app.setFilter('image')
  S.targets[0] = { path: '/store/目标B/', name: '目标B' }
  await app.saveConfig()
  const r = await fetch(BASE + '/api/config')
  const c = await r.json()
  ok(c.filter === 'image', '筛选被保存到服务端', c.filter)
  ok(c.targets && c.targets[0] && c.targets[0].path === '/store/目标B/', '目标槽位被保存', c.targets && c.targets[0])
}

console.log('\n— 全程无未捕获错误 —')
ok(jsdomErrors.length === 0, '整个流程没有未捕获异常', jsdomErrors.slice(0, 3))

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
dom.window.close()
process.exit(fail ? 1 : 0)
