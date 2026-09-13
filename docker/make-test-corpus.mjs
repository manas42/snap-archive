#!/usr/bin/env node
/**
 * 生成 Snap Archive 的测试素材（覆盖中文名、同名冲突、分页、子目录、非媒体文件、假视频）。
 *
 * 纯 Node 实现（PNG/BMP 手写，只依赖内置 zlib），因此两个测试脚本都可以直接 import 它、
 * 各自重建一份干净素材 —— 这样 test-api 与 test-ui 谁先跑都行，不会互相污染。
 *
 *   node docker/make-test-corpus.mjs [根目录]     # 默认 /tmp/snap-test
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** CRC32（PNG 分块校验用；自己实现以免依赖 zlib.crc32 的 Node 版本差异） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 手写 PNG（8 位 RGB，无滤波）。 */
function png(file, w, h, [r, g, b]) {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    const off = y * stride
    raw[off] = 0                                     // 滤波类型 0
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = r
      raw[off + 2 + x * 3] = g
      raw[off + 3 + x * 3] = b
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

/** 手写 24 位 BMP（纯色，行按 4 字节对齐，bottom-up）。 */
function bmp(file, w, h, [r, g, b]) {
  const rowSize = w * 3
  const pad = (4 - (rowSize % 4)) % 4
  const pxSize = (rowSize + pad) * h
  const buf = Buffer.alloc(54 + pxSize)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(54 + pxSize, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22)
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(0, 30); buf.writeUInt32LE(pxSize, 34)
  buf.writeInt32LE(2835, 38); buf.writeInt32LE(2835, 42)
  for (let y = 0; y < h; y++) {
    const off = 54 + y * (rowSize + pad)
    for (let x = 0; x < w; x++) {
      buf[off + x * 3] = b
      buf[off + x * 3 + 1] = g
      buf[off + x * 3 + 2] = r
    }
  }
  writeFileSync(file, buf)
}

/**
 * 重建整套测试素材（会先删掉根目录）。
 * @param {string} ROOT - 素材根目录。
 * @returns {{root:string, srcDir:string, srcFiles:number, srcDirs:string[], dstDir:string, dstFiles:string[]}}
 */
export function makeCorpus(ROOT = '/tmp/snap-test') {
  rmSync(ROOT, { recursive: true, force: true })
  const src = path.join(ROOT, '待分类')
  for (const d of ['待分类', '目标A', '目标B', '丢弃', '待分类/子目录']) {
    mkdirSync(path.join(ROOT, d), { recursive: true })
  }

  // 24 张彩色 PNG —— 正好够图集分页（20/页）再加溢出
  for (let i = 0; i < 24; i++) {
    png(path.join(src, `img${String(i).padStart(2, '0')}.png`), 240 + i * 4, 180,
      [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256])
  }
  png(path.join(src, '竖拍测试.png'), 120, 300, [200, 80, 60])              // 竖图
  png(path.join(src, '中文 名字 带空格.png'), 300, 120, [60, 160, 200])      // 中文 + 空格
  bmp(path.join(src, '位图样本.bmp'), 200, 150, [90, 200, 120])             // bmp
  png(path.join(src, '子目录', '嵌套图.png'), 160, 160, [240, 200, 60])      // 子目录里的图
  writeFileSync(path.join(src, '假视频.mp4'), Buffer.alloc(2048))           // 假视频（只测筛选/列表）
  writeFileSync(path.join(src, 'note.txt'), '非媒体文件：用于测试「目录非空不可删」\n')
  // 同名冲突：源里和目标A 里各一个 dup.png → 分类时应改名为 "dup (1).png"
  png(path.join(src, 'dup.png'), 100, 100, [255, 0, 0])
  const dst = path.join(ROOT, '目标A')
  png(path.join(dst, 'dup.png'), 100, 100, [0, 255, 0])

  return {
    root: ROOT,
    srcDir: src,
    srcFiles: readdirSync(src).filter((f) => !f.startsWith('子目录')).length,
    srcDirs: readdirSync(path.join(src, '子目录')),
    dstDir: dst,
    dstFiles: readdirSync(dst),
  }
}

// 直接执行时打印摘要
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const c = makeCorpus(process.argv[2] || '/tmp/snap-test')
  console.log('ROOT   =', c.root)
  console.log('待分类  =', c.srcFiles, '个条目')
  console.log('子目录  =', c.srcDirs)
  console.log('目标A   =', c.dstFiles)
}
