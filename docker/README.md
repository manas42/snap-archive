# Snap Archive · Docker 版（容器内独立服务）

跑在 NAS 上那个 **DSH 容器里**（同一个容器、同一批挂载卷），但**自己是独立的 node 进程** ——
不碰 DSH 的 profile、不碰 DSH 的进程、不碰 DSH 的端口。
交互与 [`mobile/index.html`](../mobile/index.html)（零服务端版）**完全一致**，只是把「文件访问层」
从 WebDAV 换成了本地挂载卷。

访问：`http://<NAS>:8005/` 　（端口可换，见下）

## 与另外两版的关系

| 版本 | 入口 | 文件访问 | 部署形态 |
| --- | --- | --- | --- |
| 桌面版 | `webapp/` | 浏览器 File System Access API | 本机 `node webapp/server.js` |
| 手机版（零服务端） | `mobile/index.html` | NAS 自带 WebDAV（PROPFIND/MOVE/…） | 一个 HTML `PUT` 到 NAS |
| **Docker 版（本目录）** | `docker/server.mjs` | **直接读写容器内挂载卷**（`/api/*`） | **在已有 DSH 容器里跑一个 node 进程** |

三套实现互相独立、不共享代码；本版页面由 `mobile/index.html` 派生，派生规则见
[「与手机版的差异」](#与手机版的差异)。

## 为什么是「同容器里的独立进程」

- **不用再挂一次卷**：直接用 DSH 容器里已经挂好的照片目录。
- **与 DSH 完全解耦**：各自启动、各自升级、互不影响；DSH 崩了不影响分类，反之亦然。
- **零依赖**：只用 node 内置模块，不需要 `npm install`、不需要 `sharp`、不需要联网装包。
- **改代码即生效**：源码放挂载卷里，harness 在容器里直接改，见[下文](#改代码怎么生效harness-实时修)。

> 另一种形态是把它做成 **DSH 插件**（复用 DSH 端口、由 DSH 托管进程，代价是要动 profile 且首次需重启 DSH）。
> 本目录选择独立进程形态。若哪天真想改挂到 DSH 端口下，只需把 `src/routes.mjs` 的
> `ROUTE_PREFIX` 从 `''` 改成 `'/snap'`，再按 cordis 插件规范注册一个 prefix 路由即可 ——
> 业务实现 `src/impl.mjs` 一行都不用动。

## 目录结构

```
docker/
  server.mjs            独立服务入口：起 http、绑 0.0.0.0:8005、按 mtime 动态加载实现
  src/routes.mjs        路由前缀的单一来源（改前缀只改这里）
  src/impl.mjs          ★ 全部业务：list / move / rmdir / config / media + 路径安全
  index.html            页面（由 mobile/index.html 派生，网络层换成 /api/*）
  make-test-corpus.mjs  生成测试素材（纯 Node，多格式/中文名/同名冲突/分页/假视频）
  lint.mjs              静态接线检查（no-undef）：拦住"引用了不存在的标识符"这类漏改
  test-api.mjs          服务端行为测试（56 条断言，不需要浏览器）
  test-ui.mjs           前端交互测试（无头浏览器跑真实 index.html，113 条断言）
```

## 部署

两条路，选一条：

- **省事（推荐）**：只改一次 compose —— 把[第 4 步](#4-容器重启后自动拉起并顺便自动取代码)那段插进
  entrypoint（`exec dsh web` 之前），它会**自己取代码、自己拉起服务**。然后重建容器即可，1~3 步都不用做。
- **手动**：按 1 → 2 → 3 走一遍，先把服务跑起来看效果，之后再考虑接进启动流程。

### 1. 把代码弄进容器（放挂载卷里）

目标路径举例 `/workspace/snap-archive/` —— 必须落在**已挂进容器的卷**里，这是"harness 能实时修"的前提。

```sh
git clone --depth 1 https://github.com/manas42/snap-archive.git /workspace/snap-archive
```

拉不动时的**实测可用**备选（本机验证：三种都能下到 176483 字节的有效 gzip、解出 `snap-archive-main/`）：

```sh
# ① 走代理 clone —— 保留 .git，之后还能 git pull 更新
git clone --depth 1 https://gh-proxy.com/https://github.com/manas42/snap-archive.git /workspace/snap-archive

# ② 直连 codeload 取 tarball（不经过 github.com 域；只需 curl + tar）
mkdir -p /workspace/snap-archive && \
curl -fsSL https://codeload.github.com/manas42/snap-archive/tar.gz/refs/heads/main \
  | tar xz -C /workspace/snap-archive --strip-components=1

# ③ 代理取 tarball
mkdir -p /workspace/snap-archive && \
curl -fsSL https://gh-proxy.com/https://github.com/manas42/snap-archive/archive/refs/heads/main.tar.gz \
  | tar xz -C /workspace/snap-archive --strip-components=1
```

> 容器里没有 `git` 就先 `apt-get install -y git`，或直接用 ②③（只需要 curl + tar）。
> 嫌麻烦可以跳过这一步 —— 下面第 4 步的 entrypoint 会自己取。

### 2. 起服务

```bash
SNAP_ROOTS="photos=/data/photos;targets=/data/targets" \
  PORT=8005 \
  node /workspace/snap-archive/docker/server.mjs
```

### 3. 端口（`network_mode: host` 下不需要任何映射）

容器若是 `network_mode: host`，**不要写 `ports`** —— Docker 会直接丢弃映射并打警告。
进程监听 `0.0.0.0:8005` 就已经在局域网可达（`HOST` 默认就是 `0.0.0.0`）。
只有用 bridge 网络时才需要加一条 `8005:8005`。

### 4. 容器重启后自动拉起（并顺便自动取代码）

独立进程得自己保证"容器起来它也跟着起来"。**如果容器 command 是一段 entrypoint 脚本**
（例如 `bash -c` 一大段脚本、最后 `exec dsh web`），把下面这段插到 `exec dsh web` **之前**即可 ——
它一次解决「取代码」和「拉起来」两件事，于是你只需要改一次 compose、重建一次容器：

```yaml
        # 5.5) 首次启动自动取代码（之后代码留在卷里；改代码 = 改文件，刷新即生效）
        if [ ! -f /workspace/snap-archive/docker/server.mjs ]; then
          echo "[snap] 首次启动：正在获取 Snap Archive 代码..."
          command -v git >/dev/null 2>&1 || apt-get install -y -qq git >/dev/null 2>&1 || true
          git clone --depth 1 https://github.com/manas42/snap-archive.git /workspace/snap-archive >/dev/null 2>&1 \
            || git clone --depth 1 https://gh-proxy.com/https://github.com/manas42/snap-archive.git /workspace/snap-archive >/dev/null 2>&1 \
            || true
          # 兜底：没有 git 或 clone 失败 → 用 tarball（只需 curl + tar）
          if [ ! -f /workspace/snap-archive/docker/server.mjs ]; then
            rm -rf /workspace/snap-archive
            mkdir -p /workspace/snap-archive
            curl -fsSL https://codeload.github.com/manas42/snap-archive/tar.gz/refs/heads/main 2>/dev/null \
              | tar xz -C /workspace/snap-archive --strip-components=1 2>/dev/null || true
          fi
        fi

        # 5.6) 启动 Snap Archive（独立 node 服务；host 网络下监听 0.0.0.0:8005 即可局域网访问）
        if [ -f /workspace/snap-archive/docker/server.mjs ]; then
          SNAP_ROOTS="photos=/data/photos;targets=/data/targets" \
          SNAP_CONFIG_FILE=/dsh/data/snap-archive/config.json \
          PORT=8005 \
          nohup node /workspace/snap-archive/docker/server.mjs >/dsh/snap-archive.log 2>&1 &
          echo "[ok] Snap Archive 已拉起（容器内 8005，host 网络直接访问；日志 /dsh/snap-archive.log）"
        else
          echo "[!] 代码没取到，Snap Archive 未启动 —— 可手动 git clone 到 /workspace/snap-archive"
        fi
```

把路径与 `SNAP_ROOTS` 换成你自己的。这段**在真实 compose 上验证过**：

- YAML 能解析、抽出的 shell 通过 `bash -n`
- 插入段不含裸露 `$`，不会被 compose 插值吃掉
- ★ 在 `set -e` 之下、把 `git`/`curl` 换成必定失败的命令实测：entrypoint **不会被中断**，
  照常打印 `[!] 代码没取到` 并继续走到 `exec dsh web` —— 这点最关键，否则"取代码失败"会把
  整个 DSH 一起拖得起不来

**A. 容器 command 只是单命令**（如 `dsh web`）—— 改成并行拉起：

```sh
sh -c "node /volume1/docker/snap-archive/server.mjs & exec dsh web"
```

**C. 用进程管理器**（s6-overlay / supervisord）—— 加一个 program 段落，最正规。

> compose 会插值 `$`，脚本里的 shell 变量要写成 `$$`；上面那段本身不含 shell 变量，原样贴即可
> （`SNAP_ROOTS` 赋值里的 `;` 在引号内是安全的）。
> 想先确认服务本身没问题，也可以按第 2 步手动起一次再接进启动流程。

### 5. 验证

**先看启动日志里的「卷自检」**，它用真实代码路径逐个报告每个卷能不能读：

```
[snap-archive] ---- 卷自检 ----
[snap-archive] [ok] photos → /data/photos  (1234 项)
[snap-archive] [!] targets → /data/targets  ERROR: ENOENT（路径不对，或这个目录没挂进容器）
```

出现 `[!]` 就说明 `SNAP_ROOTS` 里那条路径在容器里不存在 —— 典型原因是宿主机路径写错、
或者那个目录压根没挂进容器。**全部 `[ok]` 之后再往下看**（不然页面点进去只会是空的，不好定位）。

```bash
curl http://<NAS>:8005/api/health     # 各卷路径与条目数
```

浏览器打开 `http://<NAS>:8005/`。手机上「添加到主屏幕」即可当 App 用。

## 配置

全部通过环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SNAP_ROOTS` | ✅ | 卷白名单 `"名称=容器内绝对路径;名称=另一个路径"`（分号或换行分隔） |
| `PORT` | | 监听端口，默认 `8005` |
| `HOST` | | 监听地址，默认 `0.0.0.0`（不然手机连不上） |
| `SNAP_CONFIG_FILE` | | 前端配置落盘位置，默认 `<本目录>/data/snap-config.json` |

`SNAP_ROOTS` 把容器内真实路径映射成**虚拟路径的第一段**，形状与 WebDAV 的「挂载点」一致：

```
SNAP_ROOTS = "photos=/data/photos;targets=/data/targets"

虚拟路径（前端 href）  /photos/2024/a.jpg
媒体地址（前端 url）   /media/photos/2024/a.jpg
```

这样前端的 `baseOf` / `parentOf` / `normPath` / `labelOf` 等路径工具**一行都不用改**；
`GET /api/list?path=/` 返回卷列表，正好等价于 WebDAV 根返回挂载点列表，所以目录选择器也不用改。

前端配置（源目录、20 个目标槽位、丢弃目录、撤销栈、筛选/排序/自动播放）经
`GET|PUT /api/config` 持久化，原子写（tmp + rename）。

## 改代码怎么生效（"harness 实时修"）

| 改了什么 | 怎么生效 |
| --- | --- |
| `src/impl.mjs`（业务逻辑） | **下一次请求即生效**，不用重启 |
| `index.html`（页面/样式/交互） | **刷新浏览器即生效**，不用重启 |
| `src/routes.mjs`（路由前缀） | 要重启服务 |
| `server.mjs`（入口） | 要重启服务 |

实现方式：`server.mjs` 按 `src/impl.mjs` 的 `mtime + size` 做缓存键动态 `import()`；
`index.html` 每次请求都从磁盘读。于是 harness 在容器里改完文件，手机那边立刻就是新行为。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 各卷路径与条目数、配置文件位置 |
| `GET` | `/api/list?path=` | 列目录；`path=/` 返回卷列表；目录不存在 → 404 |
| `POST` | `/api/move` | `{src, destDir, noRename?}` → `{finalName, destHref, renamed, mode}` |
| `POST` | `/api/rmdir` | `{path}`；**只删空目录** |
| `GET`/`PUT` | `/api/config` | 前端配置读写 |
| `GET`/`HEAD` | `/media/<虚拟路径>` | 原图/原视频字节；支持 `Range`，以及 **ETag / Last-Modified 条件请求**（命中返回 304，翻页预览不会把整张原图重下一遍） |
| `GET` | `/` | 页面 |

条目形状：`{name, dir, href, url, size, mtime, kind}` ——
`href` 是**纯路径标识**（供 `normPath` 等比较用，目录带尾斜杠），
`url` 是**可直接 GET 的媒体地址**。两者别混用。

## 安全

- **绝不覆盖**：`move` 用 `link(2)` / `COPYFILE_EXCL` 做**原子占位**，`EEXIST` 才改名为「名 (1).ext」。
  不能退化成"先 stat 再 rename" —— POSIX `rename` 会静默覆盖同名文件，一次并发重名就是永久丢图。
- **路径白名单**：显式拒绝 `..`、绝对路径；拼接后再校验前缀；`realpath` 后仍须落在卷根内（防软链逃逸）。
  指向卷外的软链**不会出现在列表里**，读写一律 403。
- **删除只对空目录**：服务端用 `fs.rmdir`（非空直接 `ENOTEMPTY`）。
  > 这比手机版更安全：实测该 NAS 对非空目录的 WebDAV `DELETE` 会**递归删掉整棵树**，
  > 手机版只能靠前端数条目数兜底；这里服务端天然兜底。
- **CSRF**：写接口校验 `Origin` 与 `Host` 一致；不带 `Origin` 的客户端（curl）放行。
- **局域网明文**：与手机版一样，整条链路是内网明文 HTTP，**不要做公网端口转发**。

## 与手机版的差异

页面派生自 `mobile/index.html`，改动只在网络层与三处跟"跨盘"有关的提示：

**替换**（函数名与签名不变，业务代码几乎不用改）

| 位置 | 手机版 | 本版 |
| --- | --- | --- |
| `propfind` | `PROPFIND Depth:1` + XML 解析 | `GET /api/list` |
| `statOf` | `PROPFIND Depth:0` | 删除（服务端保证原子性，前端不再需要） |
| `listDirs` | 同 `propfind` | 同左 |
| `place` | `MOVE` + `Overwrite:F`，412 改名重试；跨盘降级 `COPY→校验→DELETE` | `POST /api/move`（服务端原子占位；EXDEV 时服务端内部兜底） |
| `loadConfig`/`saveConfig` | `GET`/`PUT` 同目录 `snap-config.json` | `GET`/`PUT /api/config` |
| `undo()` | 裸 `MOVE`/`COPY`/`DELETE` | 一次反向 `move`（`noRename=true`，冲突即中止） |
| `deleteSourceDir()` | `DELETE` 目录 | `POST /api/rmdir` |
| 常量 | `ORIGIN`/`DIR`/`CFG_URL` | `ROUTE`/`API`（`ORIGIN` 留空串，让 `ORIGIN + 路径` 退化成虚拟路径） |

**删除**：`poolOf` 的跨盘判断与 5 处「⚠ 跨盘」提示（两个卷实际在同一块磁盘上，硬链接/rename 本就能成功）。

**href → url**：6 处媒体加载点（主图、左右预览、图集网格、缩略图条、预取）。

## 本机自测（不需要 NAS）

```bash
SNAP_ROOTS="photos=/tmp/snap-test/待分类;store=/tmp/snap-test" \
  SNAP_CONFIG_FILE=/tmp/snap-config.json PORT=8005 node docker/server.mjs &
node docker/lint.mjs         # 静态接线检查（不需要服务在跑，秒级）
node docker/test-api.mjs     # 服务端：56 条断言
node docker/test-ui.mjs      # 前端：113 条断言（需要 jsdom，见下）
```

> **改完前端先跑 `node docker/lint.mjs`**：它不需要运行任何东西，就能发现"引用了不存在的
> 标识符"这类漏改。这个项目已经栽过两次（`DIR` 让页面启动即白屏、`srcPool` 让设置面板一点就炸），
> 而这类问题语法合法、服务端测试也照过，只有真跑到那一行才炸。harness 在容器里改完 `index.html`
> 后跑一遍这个，再让你刷新，基本不会再出这种事。

> 运行时兼容性：已在 **Node 22.22.2**（与容器 `node:22-bookworm` 同代）和 Node 26 上分别跑过，
> 服务端与前端都是全绿 —— 免得等部署到 NAS 才发现版本差异。

素材由两个测试**各自在开跑前重建**，所以先跑哪个都行、也不会互相污染
（想单独造素材：`node docker/make-test-corpus.mjs`）。

> ⚠️ 两个测试都会**真的移动文件**，所以开跑前有一道安全闸：若服务挂的不是这两个临时卷
> （要求卷名是 `photos` / `store`，且路径指向素材根），它会拒绝运行并打印正确命令。
> 另外**别把 `BASE` 指向你的真实照片目录** —— 它是拿来跑一次性语料的。

**服务端**（`test-api.mjs`）覆盖：中文+空格文件名、`kind` 分类、`..` 与 `..%2f` 穿越、软链逃逸、
Range 206、ETag/304 条件请求、同名改名不覆盖、`noRename` 冲突中止且源毫发无损、非空目录拒删、卷根拒删。

**前端**（`test-ui.mjs`）把 `index.html` 里那份前端 JS 真的在 [jsdom](https://github.com/jsdom/jsdom)
里跑起来，驱动真实交互流程：启动 → 列目录 → 预览渲染 → 图集分页/点选 → 筛选切换 → 分类移动 →
同名改名 → 撤销 → 切目录 → 删空目录 → 配置持久化 → **设置面板 → 目录选择器 → 批量勾选 →
排序切换 → 槽位/源互换 → 开关与全屏 → 方向键与数字键分类**，并断言全程没有未捕获异常。
其中还专门断言了"面板打开时键盘必须失效"这条安全设计。

> 为什么要连冷门路径一起覆盖：设置面板曾经引用了一个重构中被删掉的变量（`srcPool`），
> **一打开就抛错** —— 而只跑主流程的测试完全看不见它。同理，启动路径上的 `DIR` 也是这么躲过检查的。

> 这一类测试抓得到 API 测试与 `node --check` 都抓不到的 bug —— 例如"启动时引用了重构中被删掉的
> 标识符"，语法完全合法、接口全部正常，但页面一打开就是白的。

jsdom / eslint / globals 都是**开发依赖**（在 `docker/` 下 `npm i` 一次即可），部署时不需要：
服务端本身零依赖，`node server.mjs` 直接跑。不想在本目录装的话，可以在别处装好后用
`SNAP_JSDOM=… node test-ui.mjs`、`SNAP_ESLINT=… SNAP_GLOBALS=… node lint.mjs` 指过去。

> 目录 `docs/` 与 `tools/` 不入库（含 NAS 私有信息）；`tools/slice/` 是同一路线的只读验证原型，
> 其中 `safeResolve` / `realWithinRoot` 的路径校验思路被本版沿用。
