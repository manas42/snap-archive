#!/usr/bin/env node
/**
 * Snap Archive · 静态接线检查（no-undef）。
 *
 * 为什么需要它：这个项目已经两次栽在同一类问题上 ——
 * 重构时删掉一个常量，却漏改了引用它的地方：
 *   · `DIR`     —— 页面启动路径，一打开就是白屏（boot 直接抛错）
 *   · `srcPool` —— 设置面板路径，一点开就抛错
 * 两者语法完全合法、服务端测试也照过，只有"真跑到那行"才会炸。而它们又都躲在
 * 不常走的路径里。这个检查不需要运行任何东西，就能把整类问题挡住 ——
 * 尤其适合 harness 在容器里改完前端之后先跑一遍，再让你刷新页面。
 *
 * 检查范围：
 *   ① index.html 里的内联脚本（浏览器环境，classic script）
 *   ② server.mjs 与 src/*.mjs（Node 环境，ESM）
 *
 * 需要 eslint 与 globals（仅开发依赖，部署不需要）：
 *   npm i -D eslint globals
 *   或：SNAP_ESLINT=/path/to/eslint/lib/api.js SNAP_GLOBALS=/path/to/globals/index.js node lint.mjs
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const HERE = import.meta.dirname
const INDEX = path.join(HERE, 'index.html')

/** 按"显式指定 → 常规解析 → 本机临时安装位置"依次尝试加载一个模块。 */
async function load(specs, what) {
  const tried = []
  for (const spec of specs) {
    if (!spec) continue
    try { return await import(spec) } catch (e) { tried.push(`${spec} (${e.code || e.message})`) }
  }
  throw new Error(`需要 ${what}。安装：npm i -D eslint globals\n  或设置 SNAP_ESLINT / SNAP_GLOBALS 指过去。\n尝试过：\n  ` + tried.join('\n  '))
}

const { ESLint } = await load(
  [process.env.SNAP_ESLINT, 'eslint', '/tmp/lint-test/node_modules/eslint/lib/api.js'], 'eslint')
const globals = (await load(
  [process.env.SNAP_GLOBALS, 'globals', '/tmp/lint-test/node_modules/globals/index.js'], 'globals')).default

/** 抽出 index.html 里最后一个内联 <script> 的内容（就是页面主脚本）。 */
function inlineScript(html) {
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  if (!blocks.length) throw new Error('index.html 里找不到内联脚本')
  return blocks[blocks.length - 1][1]
}

const eslint = new ESLint({
  overrideConfigFile: true,          // 不读项目配置，规则完全由这里给定
  overrideConfig: [
    {
      files: ['**/*.js'],
      languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser } },
      rules: { 'no-undef': 'error' },
    },
    {
      files: ['**/*.mjs'],
      languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
      rules: { 'no-undef': 'error' },
    },
  ],
})

// ① 前端内联脚本
const html = await readFile(INDEX, 'utf8')
const uiCode = inlineScript(html)

// ② Node 侧源码
const srcDir = path.join(HERE, 'src')
const nodeFiles = [
  path.join(HERE, 'server.mjs'),
  ...(await readdir(srcDir)).filter((f) => f.endsWith('.mjs')).map((f) => path.join(srcDir, f)),
]

const targets = [
  { label: 'index.html（内联脚本，浏览器环境）', code: uiCode, filePath: 'index.html-inline.js' },
  ...(await Promise.all(nodeFiles.map(async (f) => ({
    label: path.relative(HERE, f),
    code: await readFile(f, 'utf8'),
    filePath: path.relative(HERE, f),
  })))),
]

let problems = 0
for (const t of targets) {
  const results = await eslint.lintText(t.code, { filePath: t.filePath })
  const msgs = results.flatMap((r) => r.messages)
  if (!msgs.length) {
    console.log(`  ✅ ${t.label}`)
    continue
  }
  problems += msgs.length
  console.log(`  ❌ ${t.label}`)
  for (const m of msgs) {
    console.log(`       ${m.line}:${m.column}  ${m.message}  (${m.ruleId})`)
  }
}

console.log(problems
  ? `\n===== 发现 ${problems} 处未定义引用（这类问题会在运行到那一行时才炸）=====`
  : '\n===== 静态接线检查通过：没有未定义引用 =====')
process.exit(problems ? 1 : 0)
