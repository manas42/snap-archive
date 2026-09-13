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
  make-test-corpus.py   生成测试素材（多格式/中文名/同名冲突/分页/假视频）
  test-api.mjs          服务端行为测试（49 条断言，不需要浏览器）
```

## 部署

### 1. 代码放进容器能读到的挂载卷

把 `docker/` 整个目录拷到 NAS 上某个**已挂进 DSH 容器**的路径下（例如 `/volume1/docker/snap-archive/`）。
放挂载卷里是"harness 能实时修"的前提。

### 2. 起服务

```bash
SNAP_ROOTS="photos=/data/photos;targets=/data/targets" \
  PORT=8005 \
  node /volume1/docker/snap-archive/server.mjs
```

### 3. 端口映射

给 DSH 容器加一条 `8005:8005` 的端口映射（你已经预留了 8005）。

### 4. 容器重启后自动拉起

独立进程需要自己保证"容器起来它也跟着起来"。按你的容器启动方式选一种：

**A. 容器 command 是 `dsh web`（或类似单命令）** —— 改成并行拉起：

```sh
sh -c "node /volume1/docker/snap-archive/server.mjs & exec dsh web"
```

**B. 有 entrypoint 脚本** —— 在脚本里 `nohup node /volume1/docker/snap-archive/server.mjs >/tmp/snap.log 2>&1 &`，
再接原来的 `exec`。

**C. 用进程管理器**（s6-overlay / supervisord）—— 加一个 program 段落，最正规。

> 先别急着改成常驻：可以按第 2 步手动起一次，确认能用之后再接到启动流程里。

### 5. 验证

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
| `GET`/`HEAD` | `/media/<虚拟路径>` | 原图/原视频字节，支持 `Range` |
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
python3 docker/make-test-corpus.py
SNAP_ROOTS="photos=/tmp/snap-test/待分类;store=/tmp/snap-test" \
  SNAP_CONFIG_FILE=/tmp/snap-config.json PORT=8005 node docker/server.mjs &
node docker/test-api.mjs
```

覆盖：中文+空格文件名、`kind` 分类、`..` 与 `..%2f` 穿越、软链逃逸、Range 206、
同名改名不覆盖、`noRename` 冲突中止且源毫发无损、非空目录拒删、卷根拒删。

> 目录 `docs/` 与 `tools/` 不入库（含 NAS 私有信息）；`tools/slice/` 是同一路线的只读验证原型，
> 其中 `safeResolve` / `realWithinRoot` 的路径校验思路被本版沿用。
