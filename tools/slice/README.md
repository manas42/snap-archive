# V0 纵切：半天验证掉"推倒重来级"风险

这是「网关版」路线的 **M0 第一步**，也是评审认为收益最高的单点动作：
在写任何正式代码之前，先用 ~120 行代码把 **"手机能不能通过跑在 NAS 上的容器，快速看到 NAS 照片的缩略图"** 跑通。

> 说明：本仓库只保留代码与脚本；方案/调研文档含 NAS 私有信息，故意不入库（见 `.gitignore`）。

## 它一次性验证了什么

| # | 待验证假设 | 若失败意味着 |
| --- | --- | --- |
| ① | 极空间 Docker 能跑我们自己的服务 | 方案要退到 PC 常驻或手机 Termux |
| ② | **能把照片共享映射进容器**，并知道真实 `/volume` 路径 | 要改用变体 C2（WebDAV 反向代理，不依赖挂载） |
| ③ | `sharp` 在容器里能出图（含 EXIF 自动旋转） | 缩略图改用前端解码，体验降级 |
| ④ | 自定义端口可用、容器能联网装依赖 | 换端口 / 改为预装 node_modules 再挂载 |
| ⑤ | 手机 Edge 能连上且加载够快 | 决定"服务端缩略图"是必需项还是优化项 |
| ⑥ | 中文文件名/路径没问题 | 要先解决编码问题再谈其他 |

**关键点：它用的是官方 `node:22-bookworm-slim` 镜像 + 绑定挂载源码，不自建镜像。**
这就绕开了"自制镜像怎么送进 NAS"（原方案 Q2/R1）这个最烦人的部署障碍，而且改代码 = 改文件 + 重启容器。

## 先在电脑上验一遍（可选，5 分钟，零风险）

想先确认代码本身没问题，再动 NAS：

```bash
cd tools/slice
npm install --omit=dev          # 或用仓库里已有的 package-lock.json
SNAP_ROOTS=/mnt/z/你的照片目录 SNAP_CACHE=/tmp/slicecache PORT=8787 node server.mjs
# 浏览器打开 http://localhost:8787
```

（WSL 里 Windows 映射盘一般是 `/mnt/z`；也可以直接指向任意本地图片目录。）

## 这套代码已经在本机验证通过（不是"应该能跑"）

| 用例 | 结果 |
| --- | --- |
| `/api/health` | ✅ 返回 `{ok, root, cache, rootEntries, node}` |
| `/api/list` 过滤 | ✅ 非图片/视频文件被排除（4 个文件 → 3 条记录） |
| 中文文件名 | ✅ `竖拍测试.jpg` 正常列出与生成缩略图 |
| `/api/thumb` | ✅ 输出 WebP（`format=webp`），带稳定 `ETag` 与 `Cache-Control: immutable` |
| 缓存 | ✅ 第二次请求 ETag 一致，命中磁盘缓存 |
| **EXIF 旋转** | ✅ 原图 400×200 + `Orientation=6` → 缩略图 **100×200（竖的）**，证明 `.rotate()` 生效 |
| 路径穿越 `..` / 绝对路径 | ✅ 一律 403（显式拒绝，不静默钳制） |
| **符号链接逃逸** | ✅ 目录内软链指向 `/etc/passwd` → 403（realpath 二次校验拦下） |
| 首页 | ✅ 200，栅格展示缩略图 |

> 其中"路径穿越"和"符号链接逃逸"两条是我自己实测时先写出 bug、再修掉并回归的——所以 4.7 节承诺的 `realpath` 校验是**真做了**，不是文档里写写。

## 跑起来（4 步，在 NAS 上）

1. **拷目录**：把整个 `tools/slice/` 拷到 NAS 的一个共享里，例如 `/volume1/docker/snap-slice/`
   （从 Windows 资源管理器拖过去最方便，\\MyNAS 的那个共享）。
2. **改一行**：编辑该目录下的 `docker-compose.yml`，把
   `/volume1/请改成你的照片目录:/data:ro` 左侧换成一个**真实存在**的照片目录。
   > 不知道真实路径？在极空间 Docker 建容器时的"添加文件夹"选择器里能看到，或者先在 NAS 上随便找个共享路径试。
3. **部署**：极空间 → Docker → **Compose 项目** → 新建 → 粘贴 `docker-compose.yml` 内容 → 部署。
   首次启动会联网 `npm install sharp`（约 1–2 分钟），之后依赖留在 NAS 上，重启不重装。
4. **手机验证**：手机 Edge 打开 `http://192.0.2.10:8787`
   → 应该直接看到缩略图网格；`http://192.0.2.10:8787/api/health` 会回 JSON（含 `root` 与目录条目数）。

## 请回传这些信息（我据此定稿方案）

- `/api/health` 的 JSON 内容
- 网页上是否出现缩略图；**第一屏加载大约几秒**
- `docker-compose.yml` 里 `/data` 左侧最终用的真实路径长什么样（例如 `/volume1/xxx` 还是 `/vol1/xxx`）
- 手机能否访问、是否被证书/网络策略拦（访客 WiFi / AP 隔离会导致连不上）
- 容器日志里有没有报错（尤其 `npm install` 与 `sharp`）

## 排错

| 现象 | 原因与对策 |
| --- | --- |
| 网页打开但一张图都没有 | `/data` 没挂对，或那个目录下确实没有支持的格式（jpg/png/gif/webp/avif/bmp） |
| `/api/health` 里 `rootEntries` 是 `ERROR: ENOENT` | compose 里 `/data` 左侧路径写错了 |
| `ERROR: EACCES` | 权限不足；容器默认 root，通常是共享的 ACL 问题，换个目录试或检查共享权限 |
| `npm install` 失败 | 容器没网或镜像源不通；本文件已用 npmmirror 源，可再换 `registry.npmjs.org` 试 |
| 想把 PC 上装好的 `node_modules` 直接拷过去省掉安装 | ⚠️ 不一定行：容器是 Debian bookworm（glibc 2.36），若你在更新的发行版上安装，`sharp` 的原生库可能因 glibc 版本过新而加载失败。可行时优先让容器自己装（仓库里已有 `package-lock.json`，也可改成 `npm ci --omit=dev`） |
| 端口 8787 起不来 | 换一个（如 8899）并同步改 `ports` 与 `PORT`；此前扫描显示 8787 在 NAS 上空闲 |
| 缩略图很慢（>2s/张） | 这正是要测出来的结论：说明"服务端缩略图 + 预生成"是必需项 |

## 边界（它不是成品）

只有 3 个接口（`/api/health`、`/api/list`、`/api/thumb`），**只读**，没有移动/撤销/鉴权——那些属于 M1。
它的唯一使命是把部署与性能的不确定性一次性打掉。
