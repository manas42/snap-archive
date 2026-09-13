#!/usr/bin/env python3
"""
生成 Snap Archive 的测试素材（覆盖中文名、同名冲突、分页、子目录、非媒体文件、假视频）。

    python3 docker/make-test-corpus.py [根目录]      # 默认 /tmp/snap-test

配套的 API 测试见 docker/test-api.mjs。
"""
import zlib, struct, os, shutil, sys


def png(path, w, h, rgb):
    """手写 PNG（不依赖 Pillow）。"""
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    data = (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 6))
            + chunk(b'IEND', b''))
    open(path, 'wb').write(data)


def bmp(path, w, h, rgb):
    """手写 24 位 BMP（纯色，bottom-up）。"""
    row = bytes(rgb[::-1]) * w
    pad = (-w * 3) % 4
    px = (row + b'\x00' * pad) * h
    hdr = struct.pack('<2sIHHI', b'BM', 14 + 40 + len(px), 0, 0, 14 + 40)
    info = struct.pack('<IiiHHIIiiII', 40, w, h, 1, 24, 0, len(px), 2835, 2835, 0, 0)
    open(path, 'wb').write(hdr + info + px)


ROOT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/snap-test'
shutil.rmtree(ROOT, ignore_errors=True)
for d in ['待分类', '目标A', '目标B', '丢弃', '待分类/子目录']:
    os.makedirs(os.path.join(ROOT, d), exist_ok=True)

src = os.path.join(ROOT, '待分类')
# 24 张彩色 PNG —— 正好够图集分页（20/页）再加溢出
for i in range(24):
    png(os.path.join(src, f'img{i:02d}.png'), 240 + i * 4, 180,
        ((i * 37) % 256, (i * 91) % 256, (i * 53) % 256))
png(os.path.join(src, '竖拍测试.png'), 120, 300, (200, 80, 60))          # 竖图
png(os.path.join(src, '中文 名字 带空格.png'), 300, 120, (60, 160, 200))  # 中文 + 空格
bmp(os.path.join(src, '位图样本.bmp'), 200, 150, (90, 200, 120))         # bmp
png(os.path.join(src, '子目录', '嵌套图.png'), 160, 160, (240, 200, 60))  # 子目录里的图
open(os.path.join(src, '假视频.mp4'), 'wb').write(b'\x00' * 2048)        # 假视频（只测筛选/列表）
open(os.path.join(src, 'note.txt'), 'w').write('非媒体文件：用于测试「目录非空不可删」\n')
# 同名冲突：源里和目标A 里各有一个 dup.png → 分类时应改名为 "dup (1).png"
png(os.path.join(src, 'dup.png'), 100, 100, (255, 0, 0))
png(os.path.join(ROOT, '目标A', 'dup.png'), 100, 100, (0, 255, 0))


def count(p):
    return len([f for f in os.listdir(p) if os.path.isfile(os.path.join(p, f))])


print('ROOT   =', ROOT)
print('待分类  =', count(src), '个文件')
print('子目录  =', sorted(os.listdir(os.path.join(src, '子目录'))))
print('目标A   =', sorted(os.listdir(os.path.join(ROOT, '目标A'))))
