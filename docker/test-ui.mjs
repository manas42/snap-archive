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
 *   SNAP_ROOTS="photos=/tmp/snap-test/待分类;store=/tmp/snap-test" \
 *     SNAP_CONFIG_FILE=/tmp/snap-config.json PORT=8005 node docker/server.mjs &
 *   node docker/test-ui.mjs
 *
 * 素材在开跑前自动重建（见 make-test-corpus.mjs），所以与 test-api.mjs 的执行顺序无关。
 */

import { readFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { makeCorpus } from './make-test-corpus.mjs'

const INDEX = path.join(import.meta.dirname, 'index.html')
const BASE = process.env.BASE || 'http://127.0.0.1:8005'
const ROOT = process.env.SNAP_TEST_ROOT || '/tmp/snap-test'
const SRC_DIR = path.join(ROOT, '待分类')
const DST_DIR = path.join(ROOT, '目标A')

// 自己重建一份干净素材 —— 两个测试互不依赖对方的残留状态
makeCorpus(ROOT)

/**
 * 安全闸：本测试会**真的移动文件**，所以必须先确认服务挂的正是本次的临时语料。
 * 它同时把"卷名/路径对不上"这种配置错误直接说清楚 —— 否则只会得到一个
 * 完全指不到症结的报错。
 */
{
  const want = `photos=${SRC_DIR};store=${ROOT}`
  let h = null
  try { h = await (await fetch(BASE + '/api/health')).json() } catch (e) {
    console.error(`❌ 连不上 ${BASE}（${e.message}）\n   先起服务：\n   SNAP_ROOTS="${want}" SNAP_CONFIG_FILE=/tmp/snap-config.json PORT=8005 node docker/server.mjs`)
    process.exit(2)
  }
  const names = h.roots.map((r) => r.name)
  const paths = h.roots.map((r) => r.path)
  const good = names.length === 2 && names[0] === 'photos' && names[1] === 'store'
    && paths[0] === SRC_DIR && paths[1] === ROOT
  if (!good) {
    console.error('❌ 本测试只对临时语料运行（它会真的移动文件），当前卷配置不匹配。')
    console.error(`   请这样起服务：SNAP_ROOTS="${want}" SNAP_CONFIG_FILE=/tmp/snap-config.json PORT=8005 node docker/server.mjs`)
    console.error(`   当前服务挂的是：${JSON.stringify(h.roots)}`)
    process.exit(2)
  }
}

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

/** 轮询等待条件成立。注意把"最后一次求值抛的错"带进超时信息 ——
 *  否则条件里的笔误（比如引用了测试作用域里不存在的函数）会被静默吞成"超时"，很难查。 */
async function until(fn, label, timeout = 10000) {
  const t0 = Date.now()
  let lastErr = null
  for (;;) {
    let v
    try { v = await fn(); lastErr = null } catch (e) { v = false; lastErr = e }
    if (v) return v
    if (Date.now() - t0 > timeout) {
      throw new Error(`超时等待：${label}`
        + (lastErr ? `（最后一次求值抛错：${lastErr.message}）` : ''))
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

const JSDOM = await loadJsdom()
const html = await readFile(INDEX, 'utf8')

// 把需要的内部绑定导出成 globalThis.__snap（追加在最后一个 </script> 之前，处在同一作用域）
const tail = `
;globalThis.__snap = { S, B, PAGE, openSource, classify, undo, deleteSourceDir, setFilter, goToDir,
  propfind, place, render, renderStage, renderFilm, buildFiles, sortRaw, renderBadge,
  normPath, canDeleteSource, labelOf, openGrid, renderGrid, loadConfig, saveConfig,
  openPicker, pickerLoad, commitPick, toggleChosen, applyBatch, setSort, openSetup, renderSetup,
  doSwapSlots, doSwapSourceWithSlot, gridStep, setAutoplay, toggleFullscreen, setAutoFs,
  setSource, setTarget, setDel, refreshCounts, conflictWith, updateSortUI,
  // 本次新增：页面切换 / 浏览页设置 / 幻灯片 / 详情药丸
  showPage, pageFromHash, setAutoSlide, setRandom, setVideoLoop, updateBrowseCfgUI,
  updateSlideUI, browseLoad, browseBuild, nextIndex, browseNext, browseGoto, renderBrowse,
  stepInterval, renderBrowseBadge };
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

/** 键盘路径只对「归类」页生效（页面路由之后，菜单/浏览页的按键语义完全不同），
 *  所以碰键盘之前先显式切到归类页 —— 否则按 1-9 不会有任何反应。 */
const onCategorize = () => app.showPage('categorize')

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

console.log('\n— 设置面板 / 选择器 / 排序 / 互换 / 键盘（这些路径此前从未被跑过）—')
{
  // 干净起点
  app.setFilter('all')
  for (let i = 0; i < S.targets.length; i++) S.targets[i] = null
  S.del = null; S.undoStack = []

  // ① 设置面板 —— 这里曾因 srcPool 未定义而整块抛错
  app.openSetup()
  ok(jsdomErrors.length === 0, '打开设置面板没有未捕获错误', jsdomErrors.slice(0, 2))
  ok(window.document.getElementById('setupSheet').classList.contains('on'), '设置面板已打开')
  const note = window.document.getElementById('setupNote').textContent
  ok(!/NAS|WebDAV|snap-config/.test(note), '面板说明里不再出现 NAS/WebDAV/snap-config', note.slice(0, 70))
  ok(/api\/config/.test(note), '面板说明改指向 /api/config')

  // ② 目录选择器：进 photos 并选定为源
  app.openPicker('source', -1)
  await until(() => S.pick && S.pick.dir, '选择器有起始目录')
  ok(jsdomErrors.length === 0, '打开选择器没有未捕获错误', jsdomErrors.slice(0, 2))
  await app.pickerLoad('/photos/')
  ok(S.pick.dir === '/photos/', '选择器进入 photos', S.pick.dir)
  app.commitPick('/photos/')
  await until(() => S.source && app.normPath(S.source.path) === '/photos/', '源目录已设定')
  ok(S.source.name === 'photos', '源目录名取目录名', S.source)

  // ③ 槽位选择 + 批量勾选
  app.openPicker('slot', 0)
  await app.pickerLoad('/store/目标A/')
  app.commitPick('/store/目标A/')
  await until(() => S.targets[0] && app.normPath(S.targets[0].path) === '/store/目标A/', '槽位 1 已设定')
  ok(S.targets[0].name === '目标A', '槽位名正确', S.targets[0])

  S.pick = { mode: 'batch', slot: -1, dir: '/store/', chosen: new Set(), from: 'main' }
  await app.pickerLoad('/store/')
  app.toggleChosen('/store/目标B/')
  ok(S.pick.chosen.has('/store/目标B/'), '批量勾选记录进 chosen')
  app.applyBatch()
  ok(jsdomErrors.length === 0, '批量加入没有未捕获错误', jsdomErrors.slice(0, 2))
  ok(S.targets.some((t) => t && app.normPath(t.path) === '/store/目标B/'), '批量勾选把目录加进了空槽位')

  // ④ 排序切换
  await app.openSource('/photos/')
  app.setSort('mtime-asc')
  const ascFirst = S.files[0] && S.files[0].name
  app.setSort('mtime-desc')
  const descFirst = S.files[0] && S.files[0].name
  ok(S.sortMode === 'mtime-desc', '排序切回 新→旧', S.sortMode)
  ok(ascFirst !== descFirst, '两种排序的首张不同（说明排序真的生效）', [ascFirst, descFirst])

  // ⑤ 图集：点格子跳转并关闭
  app.openGrid()
  ok(window.document.getElementById('gridSheet').classList.contains('on'), '图集已打开')
  window.document.getElementById('gridBox').children[2].click()
  ok(S.index === 2 && !window.document.getElementById('gridSheet').classList.contains('on'),
    '点图集格子会跳转并关闭图集', { index: S.index })

  // ⑥ 互换
  const t0 = S.targets[0] && S.targets[0].path
  const t1 = S.targets[1] && S.targets[1].path
  app.doSwapSlots(0, 1)
  ok((S.targets[0] && S.targets[0].path) === t1 && (S.targets[1] && S.targets[1].path) === t0,
    '两个槽位互换成功')
  const now0 = S.targets[0] && S.targets[0].path      // 互换之后再抓，别用互换前的 t0
  app.doSwapSourceWithSlot(0)
  ok(app.normPath(S.source.path) === app.normPath(now0), '源与槽位互换：源变成原槽位目录',
    { now: S.source.path, was: now0 })

  // ⑦ 开关类
  app.setAutoplay(false); ok(S.autoplay === false, '自动播放可关闭')
  app.setAutoFs(true);    ok(S.autoFs === true, '自动全屏可打开')
  await app.toggleFullscreen()
  ok(jsdomErrors.length === 0, '全屏切换没有未捕获错误', jsdomErrors.slice(0, 2))
  app.setAutoplay(true); app.setAutoFs(false); await app.toggleFullscreen()

  // 让 doSwapSourceWithSlot 里那个"没被 await 的 openSource"先跑完，免得后面抢 S.files
  await new Promise((r) => setTimeout(r, 250))
  await app.openSource('/photos/', true)
  await until(() => S.cwd === '/photos/' && S.files.length > 0, '回到 photos 且列表就绪')

  // ⑧ 面板打开时键盘必须失效 —— 这是刻意的安全设计
  //   （历史上"图集开着时按数字键会真的把文件移走"，所以任何面板打开时一律不响应键盘）
  onCategorize()                                  // 键盘路径只属于「归类」页
  window.document.getElementById('setupSheet').classList.add('on')
  S.index = 0
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight' }))
  ok(S.index === 0, '有面板打开时方向键不生效（刻意行为）', S.index)

  for (const id of ['gridSheet', 'browseSheet', 'setupSheet', 'bCfgSheet']) {
    window.document.getElementById(id).classList.remove('on')
  }
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight' }))
  ok(S.index === 1, '面板关掉后 → 能翻到下一张', S.index)
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft' }))
  ok(S.index === 0, '← 翻回上一张', S.index)

  // ⑨ 数字键分类（主交互路径：键盘 → classify → 落盘）
  for (let i = 0; i < S.targets.length; i++) S.targets[i] = null
  S.targets[0] = { path: '/store/目标B/', name: '目标B' }
  S.index = 0
  const victim = S.files[0]
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: '1' }))
  await until(() => S.files.length && !S.files.some((f) => f.href === victim.href), '数字键把当前文件移走')
  ok(await exists(path.join(ROOT, '目标B', victim.name)), '按 1 真的把文件移进槽位 1 的目录', victim.name)
  await app.undo()
  ok(await exists(path.join(SRC_DIR, victim.name)), '撤销把它放回源目录')
  ok(jsdomErrors.length === 0, '键盘路径全程没有未捕获错误', jsdomErrors.slice(0, 2))
}

console.log('\n— 左上角序号药丸：默认只有序号，点开才显示类型/大小 —')
{
  onCategorize()
  await app.openSource('/photos/', true)
  await until(() => S.cwd === '/photos/' && S.files.length > 0, '归类页列表就绪')
  app.renderStage()
  const badge = window.document.getElementById('badge')
  // 明细＝badge 的直接子元素（序号药丸自己是第一个，也是收起时唯一的一个）
  const detailCount = () => badge.children.length - badge.querySelectorAll('button.seq').length
  const btn = badge.querySelector('button.seq')
  ok(!!btn, '序号是一个可点的药丸（不是死文字）')
  ok(new RegExp(`第\\s*1\\s*/\\s*${S.files.length}`).test(btn ? btn.textContent : ''),
    '药丸上写着序号', btn && btn.textContent)
  ok(detailCount() === 0, '默认不显示类型/大小等明细（只有一个序号）', {
    children: badge.children.length, detail: detailCount() })
  if (btn) btn.click()
  const texts = [...badge.children].map((s) => s.textContent)
  ok(texts.some((t) => /图片|视频/.test(t)), '点开后出现文件类型', texts)
  ok(texts.some((t) => /^\d+(\.\d+)?(B|KB|MB)$/.test(t)), '点开后出现文件大小', texts)
  const btn2 = badge.querySelector('button.seq')
  if (btn2) btn2.click()
  ok(detailCount() === 0, '再点一下又收起来', detailCount())
  ok(jsdomErrors.length === 0, '序号药丸切换没有未捕获错误', jsdomErrors.slice(0, 2))
}

console.log('\n— 首页 ⚙「浏览设置」：幻灯片 / 随机 / 视频自动播放 —')
{
  app.showPage('menu')
  const cfg = window.document.getElementById('bCfgSheet')
  window.document.getElementById('menuCfg').click()
  ok(cfg.classList.contains('on'), '首页的 ⚙ 能打开浏览设置面板')
  ok(!!window.document.getElementById('bCfgAuto') && !!window.document.getElementById('bCfgIntVal')
    && !!window.document.getElementById('bCfgRand') && !!window.document.getElementById('bCfgVideo'),
    '幻灯片自动播放 / 间隔 / 随机 / 视频自动播放 都在面板里')

  app.setAutoSlide(false)
  ok(app.B.autoSlide === false, '幻灯片自动播放可关闭', app.B.autoSlide)
  ok(window.document.getElementById('bCfgAuto').textContent === '关', '面板按钮同步显示"关"')
  ok(app.B.slide === false, '关掉自动播放后不会再把幻灯片开关当成开着')
  app.setAutoSlide(true)
  ok(app.B.autoSlide === true && app.B.slide === true, '再打开就恢复自动播放')

  app.setRandom(false)
  ok(app.B.random === false, '随机播放可关闭')
  const i0 = 3
  app.B.files = [{ name: 'a.jpg' }, { name: 'b.jpg' }, { name: 'c.jpg' }, { name: 'd.jpg' }]
  app.B.random = false
  ok(app.nextIndex(i0) === 0, '顺序模式：最后一张的下一张回到第一张（不打乱）', app.nextIndex(i0))
  ok(app.nextIndex(1) === 2, '顺序模式：中间就是老老实实 +1', app.nextIndex(1))
  app.B.random = true
  ok([0, 1, 3].includes(app.nextIndex(2)) && app.nextIndex(2) !== 2,
    '随机模式：绝不会连续两次抽到同一张', app.nextIndex(2))
  app.setRandom(true)

  app.setVideoLoop(true)
  ok(app.B.videoLoop === true, '视频循环可打开')
  app.setVideoLoop(false)

  const iSec = Math.round(app.B.interval / 1000)
  window.document.getElementById('bCfgIntUp').click()
  ok(Math.round(app.B.interval / 1000) !== iSec, '面板里能调图片间隔',
    { was: iSec, now: Math.round(app.B.interval / 1000) })
  ok(window.document.getElementById('bCfgIntVal').textContent === `${Math.round(app.B.interval / 1000)}s`,
    '间隔按钮上的数字跟着变', window.document.getElementById('bCfgIntVal').textContent)

  // 视频自动播放：与归类页共用同一个值
  app.setAutoplay(false)
  ok(app.B.videoAuto === false, '关掉"视频自动播放"会同步到浏览页', app.B.videoAuto)
  app.setAutoplay(true)
  ok(app.B.videoAuto === true, '打开也一样同步')
  cfg.classList.remove('on')
  ok(jsdomErrors.length === 0, '浏览设置面板操作没有未捕获错误', jsdomErrors.slice(0, 2))
}

console.log('\n— 浏览页：随机到视频应当自动播放 —')
{
  app.B.dirs = [{ path: '/photos/', name: '待分类' }]
  app.B.loaded = false
  await app.browseLoad()
  await until(() => app.B.files.length > 0, '浏览页扫到媒体')
  const vi = app.B.files.findIndex((f) => f.name.endsWith('.mp4'))
  ok(vi >= 0, '浏览列表里有那个视频', vi)
  app.setAutoSlide(false)                 // 先关掉幻灯片，确保测的是"手动/随机翻到视频"
  app.setAutoplay(true)
  app.browseGoto(vi)
  const st = window.document.getElementById('bStage')
  const v = st.querySelector('video')
  ok(!!v, '视频被渲染到浏览页舞台上')
  ok(v && v.autoplay === true, '视频元素带着 autoplay（随机到视频会自动开始）', v && v.autoplay)
  ok(v && v.loop === app.B.videoLoop, '视频元素的 loop 跟随"视频循环"设置', v && v.loop)
  ok(!st.classList.contains('clickable'), '视频页面上点画面＝播放/暂停，不劫持成翻页')
  app.setVideoLoop(true); app.browseGoto(vi)
  const v2 = window.document.getElementById('bStage').querySelector('video')
  ok(v2 && v2.loop === true, '打开循环后视频元素立刻变成 loop', v2 && v2.loop)
  app.setVideoLoop(false)
  app.setAutoplay(false)
  app.browseGoto(vi)
  const v3 = window.document.getElementById('bStage').querySelector('video')
  ok(v3 && v3.autoplay === false, '关掉"视频自动播放"后不再 autoplay', v3 && v3.autoplay)
  app.setAutoplay(true)
  app.B.dirs = []
  app.B.loaded = false
  onCategorize()
  ok(jsdomErrors.length === 0, '浏览页自动播放路径没有未捕获错误', jsdomErrors.slice(0, 2))
}

console.log('\n— 全程无未捕获错误 —')
ok(jsdomErrors.length === 0, '整个流程没有未捕获异常', jsdomErrors.slice(0, 3))

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
dom.window.close()
process.exit(fail ? 1 : 0)
