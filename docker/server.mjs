#!/usr/bin/env node
/**
 * Snap Archive · 独立服务入口。
 *
 * 自己起一个 node:http 服务、监听自己的端口（默认 8005），**不碰 DSH 的 profile / 进程 / 端口**。
 * 业务实现与"DSH 插件"形态完全共用 `src/impl.mjs`（本文件与它只通过 handle() 打交道）。
 *
 * 环境变量：
 *   SNAP_ROOTS       卷白名单 "名称=绝对路径;名称=绝对路径"（必填）
 *   SNAP_CONFIG_FILE 前端配置落盘位置（默认 <本目录>/data/snap-config.json）
 *   HOST             监听地址（默认 0.0.0.0 —— 不然手机连不上）
 *   PORT             监听端口（默认 8005）
 *
 * 改 src/impl.mjs 后**不需要重启**：本文件按 mtime 动态 import 它（harness 实时修的前提）。
 */

import http from 'node:http'
import path from 'node:path'
import { stat } from 'node:fs/promises'

const config = {
  roots: process.env.SNAP_ROOTS || '',
  configFile: process.env.SNAP_CONFIG_FILE || path.join(import.meta.dirname, 'data', 'snap-config.json'),
}
const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 8005)

/** 动态加载缓存：key 由 impl.mjs 的 mtime+size 组成，源文件一变就换新模块。 */
let cache = { key: '', mod: null }
async function impl() {
  const url = new URL('./src/impl.mjs', import.meta.url)
  const st = await stat(url)
  const key = `${st.mtimeMs}:${st.size}`
  if (cache.key !== key) cache = { key, mod: await import(`${url.href}?v=${encodeURIComponent(key)}`) }
  return cache.mod
}

const server = http.createServer(async (req, res) => {
  try {
    await (await impl()).handle(req, res, config)
  } catch (e) {
    // 兜底：任何意外都要给出响应，别把连接挂死
    const message = String((e && e.message) || e)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: message }))
    } else {
      try { res.end() } catch { /* 已断连 */ }
    }
  }
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[snap-archive] 端口 ${PORT} 已被占用：换一个 PORT，或先停掉占用它的进程。`)
    process.exit(1)
  }
  console.error('[snap-archive] 服务错误：', e)
  process.exit(1)
})

server.listen(PORT, HOST, async () => {
  console.log(`[snap-archive] 已启动  http://${HOST}:${PORT}/`)
  console.log(`[snap-archive]   SNAP_ROOTS       = ${config.roots || '(空！必须配置，否则列表里没有卷)'}`)
  console.log(`[snap-archive]   SNAP_CONFIG_FILE = ${config.configFile}`)

  // 卷自检：直接请求自己的 /api/health，用真实代码路径逐个报告"这个卷到底能不能读"。
  // 首次部署最常见的错就是路径写错 / 没挂上 —— 与其等用户点进页面看到空白，不如启动就喊出来。
  try {
    const h = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()
    console.log('[snap-archive] ---- 卷自检 ----')
    if (!h.roots.length) {
      console.log('[snap-archive] [!] 一个卷都没有：SNAP_ROOTS 为空或格式不对。')
      console.log('[snap-archive]     正确格式："名称=容器内绝对路径;名称=另一个路径"')
    }
    for (const v of h.roots) {
      const bad = typeof v.entries === 'string'
      console.log(`[snap-archive] ${bad ? '[!]' : '[ok]'} ${v.name} → ${v.path}`
        + (bad ? `  ${v.entries}（路径不对，或这个目录没挂进容器）` : `  (${v.entries} 项)`))
    }
  } catch (e) {
    console.log('[snap-archive] 卷自检失败：' + (e && e.message))
  }
  console.log('[snap-archive] 改 src/impl.mjs 无需重启；改本文件或路由前缀需重启。')
})

// 优雅退出：容器 stop / Ctrl-C 时先关监听，最多等 3 秒
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[snap-archive] 收到 ${sig}，正在退出…`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
