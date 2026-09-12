# Snap Archive 手机版设计文档（零服务端 WebDAV 版）

> 本文由仓库现有实现反推而来，唯一依据是 `mobile/index.html`（单文件，1633 行）与 `tools/deploy-webdav.sh`。
> **行号基准**：文中行号对应 `mobile/index.html` 的 **1633 行**版本（本文写作时的当前工作区版本）。代码一旦改动，行号会整体漂移，越靠近文件末尾偏得越多；**追溯时请以函数名 / 常量名 / 字符串文案为准**，行号只用于快速定位。
> 文中括注的「行号 / 函数名 / 常量名」均指 `mobile/index.html`（除特别说明）。
> 为便于公开，示例中的主机、账号、存储池与目录名一律使用占位符（`192.0.2.10`、`ACCOUNT`、`pool-a` / `pool-b`、`photos/`、`to-sort/`）。

---

## 1. 概述

**要解决的问题**：在手机上把一堆"待分类"的照片/视频快速分流到若干目标目录，尽量少点、少等、不误删。
使用场景是"躺在床上用手机清相册"：一次只处理一张，看到就决定去向，一屏内完成（顶栏选源、中间看图、底部 20 个目标槽位一键移动）。

**运行形态**：

| 维度 | 取值 |
| --- | --- |
| 交付物 | 单个 HTML 文件（`mobile/index.html`），内联 CSS 与 JS，零依赖、零构建 |
| 后端 | **没有后端**。所有文件操作直接对**同源 WebDAV** 说话 |
| 数据面 | 照片/视频始终留在 NAS 上，应用只发 `PROPFIND` / `MOVE` / `COPY` / `DELETE`（`GET` 由 `<img>` / `<video>` 隐式发起） |
| 配置面 | 与本页同目录的 `snap-config.json`，用 WebDAV 的 `GET` / `PUT` 读写（`CFG_URL`） |
| 部署 | `tools/deploy-webdav.sh` 把文件 `PUT`（目录则先 `MKCOL`）到 NAS 的 WebDAV 路径下 |
| 打开方式 | 手机浏览器访问"该 HTML 文件的完整 WebDAV 地址" |
| 交互 | 触摸为主（点按/长按/滚动），键盘为辅（← → 空格 1–9 Ctrl/⌘+Z Esc） |

设计上贯彻三条写死的安全规则（见文件头注释 365–368 行）：

1. **一切写操作都带 `Overwrite: F`** —— 目标同名时服务器返回 `412`，绝不覆盖；
2. **跨盘时"先 `COPY` → 校验大小 → 才 `DELETE` 源"**，校验不过就保留源文件并报错；
3. **只移动、不删除文件**；"丢弃"也只是把文件移到用户指定的目录。唯一会真删的是**已经完全空掉的目录**（`DELETE`，见 §6.9）。

---

## 2. 部署与运行前提

### 2.1 文件放在哪

唯一必须部署的是 `mobile/index.html`；运行时唯一会产生/更新的附带文件是它旁边的 `snap-config.json`。
`tools/deploy-webdav.sh` 的典型用法（脚本头部注释）：

```bash
bash tools/deploy-webdav.sh mobile/index.html /pool-a/snap-archive-app/index.html   # 单文件
bash tools/deploy-webdav.sh mobile/ /pool-a/snap-archive-app/                      # 目录 → 递归上传
DAV_ROOT=/pool-a/snap-archive-app bash tools/deploy-webdav.sh mobile/              # 或用环境变量
```

NAS 上这个 `snap-archive-app/` 是手机版的**专用目录**，约定只有两样东西：

```
/pool-a/snap-archive-app/
  index.html          ← 部署上去的应用页（唯一入口，必须用完整文件地址打开）
  snap-config.json    ← 运行时自动生成/更新，跟页面同目录
  test/               ← 配套测试语料（源目录、若干目标目录、丢弃目录），非应用运行所需
```

目录名之所以带 `-app` 后缀：同级的 `test/` 只是语料，真正被手机收藏的入口是 `.../snap-archive-app/index.html`。

脚本要点：

- 凭据从 `.nas-cred` 读取（该文件被 `.gitignore` 排除），**不写进脚本、不进 argv**；密码通过临时 `curl` 配置文件传递（`chmod 600` + `trap` 清理）。真实主机名同样来自该文件（`NAS_HOST`），脚本内不留默认值。
- 支持第二个参数直接粘贴完整 URL，脚本会剥掉 `http://host:port` 只保留路径。
- 递归上传目录时，对每层的上级目录先发 `MKCOL`，**`405`（已存在）视为成功**（脚本 106–107 行）。

### 2.2 为什么必须"同源"

`CFG_URL` 用绝对 URL 拼成（373 行）：

```js
const ORIGIN = location.origin;
const DIR = location.pathname.replace(/[^/]*$/, '');  // 本页所在目录（编码）
const CFG_URL = ORIGIN + DIR + 'snap-config.json';
```

原因写在同行的注释里：**页面若从带凭据的 URL 打开（`http://user:pass@host/...`），相对 URL 会让 `fetch` 直接抛错**；用 `ORIGIN + DIR` 拼绝对 URL 可以绕开这一点。
另一层原因是 WebDAV 的鉴权基于 HTTP 基本认证：应用所有 `fetch` 都带 `credentials:'same-origin'`（424、464、536、564、1013、1103 行），媒体元素（`<img>` / `<video>` 的 `src`）也用同源相对/绝对路径，浏览器会自动带上同一份凭据 —— 所以**页面必须与 WebDAV 服务同源**，否则既拿不到凭据、也过不了 CORS。

### 2.3 `snap-config.json` 的位置与作用

- 位置：**本页所在目录**（`DIR` = `location.pathname` 去掉文件名）。
- 作用：把"源目录 / 20 个目标槽位 / 丢弃目录 / 筛选 / 自动播放 / 自动全屏 / 排序 / 撤销栈"持久化到 NAS，**换设备、换浏览器、清缓存都能沿用**（设置面板里的说明，1224–1228 行）。
- 读取：`GET CFG_URL?t=<时间戳>` + `cache:'no-store'`，避免读到代理/内核缓存（536 行）。
- 写入：`PUT`，`Content-Type: application/json; charset=utf-8`，正文是 `JSON.stringify(snapshot(), null, 2)`（564–566 行）。
- 首次使用没有该文件是正常的：`loadConfig()` 把 `404` 当作"没有配置"直接返回 `false`，不报错（543 行）。

### 2.4 浏览器要求

- 需要支持 `fetch` + `DOMParser`（`'application/xml'` 解析 `PROPFIND` 响应，429 行）、`Fullscreen API`、以及 `<video playsinline>`。
- 触摸端需要 `env(safe-area-inset-*)`（刘海屏适配，见 CSS 中的 `calc(... + env(...))`）。
- **不要求 HTTPS**：`requestFullscreen` 不需要安全上下文，所以明文 `http://` 下全屏也能用（733–736 行注释）。
- 但**需要用户能在 URL 里提供 NAS 账号**（HTTP 基本认证），这是明文 `http` 的现实前提。
- 代码未使用任何高阶特性做渐进降级判断（例如没有 `CSS.supports` / 特性探测分支），因此可视为"面向现代 Chromium / Safari 手机浏览器"。

---

## 3. 架构总览

单文件内部分层（自下而上；上层的调用下层，下层从不反向依赖上层）：

```
┌─────────────────────────────────────────────────────────────┐
│ 渲染层     renderHeader / renderStage / renderFilm /         │
│            renderSlots / renderBadge / renderGrid /          │
│            renderSetup / renderPickerList                    │
├─────────────────────────────────────────────────────────────┤
│ 交互动作层 classify / undo / deleteSourceDir / goToDir /     │
│            setSource·setTarget·setDel / doSwapSlots /        │
│            doSwapSourceWithSlot / applyBatch / commitPick    │
├─────────────────────────────────────────────────────────────┤
│ 派生与视图选择 buildFiles / sortRaw / showList / setSort /   │
│            setFilter / openGrid / gridStep / preload         │
├─────────────────────────────────────────────────────────────┤
│ 状态 S（唯一可变全局对象，398–406 行）                        │
├─────────────────────────────────────────────────────────────┤
│ 配置读写   snapshot / applyConfig / loadConfig /             │
│            scheduleSave / saveConfig（NAS + localStorage）   │
├─────────────────────────────────────────────────────────────┤
│ WebDAV 原语 propfind / statOf / listDirs / place             │
├─────────────────────────────────────────────────────────────┤
│ 常量与工具 ORIGIN·DIR·CFG_URL / IMG·VID / SLOT_N·MAX_UNDO·    │
│            GRID_PER_PAGE / dec·enc·extOf·baseOf·parentOf·    │
│            joinEnc·poolOf·esc·labelOf·normPath·human        │
└─────────────────────────────────────────────────────────────┘
```

要点：

- **没有类、没有模块**，全部是顶层函数 + 一个全局 `S`。所有渲染都是"全量重建 DOM"或"原地改文本"，没有虚拟 DOM。
- **`S` 是唯一状态源**；渲染函数是纯读：`render()` 只按 `S` 重画（806 行）。
- **WebDAV 原语是唯一 IO 出口**，业务函数不直接拼 `fetch`，只有三处例外：`loadConfig`/`saveConfig`（配置文件）、`undo`/`deleteSourceDir`（需要检查具体状态码的自定义流程）。
- 关键不变量：**`S.files` 必须始终是 `S.raw` 的子集**（`buildFiles()` 保证），移动文件时两者都要删（973–977 行）。

---

## 4. 数据模型

### 4.1 目录条目（`propfind` 的产物）

`propfind(path, depth)` 返回条目数组，每条字段如下（438–440 行）：

| 字段 | 类型 | 来源 | 说明 |
| --- | --- | --- | --- |
| `href` | string | `DAV:href` 文本 | 服务器返回的资源路径。**目录若没有结尾 `/` 会被补上**，后续所有比较都基于这个形式 |
| `name` | string | `baseOf(href)` | 末段解码后的显示名（`decodeURIComponent`） |
| `dir` | boolean | 有无 `DAV:collection` 元素 | 是否集合（目录） |
| `size` | number | `DAV:getcontentlength` | 缺失时 `0`（目录通常缺失） |
| `mtime` | number | `Date.parse(DAV:getlastmodified)` | 缺失时 `0`；**秒级精度** |

请求的属性只有三个：`getcontentlength` / `getlastmodified` / `resourcetype`（422–423 行）。没有请求 `getcontenttype`、`displayname`、`quota` 等。

### 4.2 `S` 的状态字段

| 字段 | 初值 | 含义 | 写入点 |
| --- | --- | --- | --- |
| `cwd` | `null` | **当前正在浏览的目录**（带尾 `/`，编码形式）。可能不等于源目录（例如刚进了某个子目录） | `openSource`（587） |
| `raw` | `[]` | 当前目录里**全部**媒体条目（图片+视频，已按当前排序排好）。**筛选的唯一事实来源** | `openSource`（589）、`sortRaw`、移动后 splice |
| `files` | `[]` | `raw` 经 `S.filter` 过滤后的**可见列表**；主图、图集、数字键都作用于它 | `buildFiles`（609） |
| `dirs` | `[]` | 当前目录下的子目录（胶卷条上的 📁 按钮、"填充空槽"的来源） | `openSource`（588） |
| `entryCount` | `0` | 当前目录里**所有条目**的数量（含子目录、`txt`、隐藏文件）——**判断能否删目录只认它** | `openSource`（592）、移动后 `-1`（979） |
| `otherNames` | `[]` | 上述"非媒体条目"的名字（最多展示 3 个，用于解释"为什么不能删"） | `openSource`（593）、空态提示（833） |
| `index` | `0` | 当前主图在 `files` 中的下标；所有边界都做 `Math.min/max` 钳制 | `showList`（626）、`classify`、`undo`、图集点击 |
| `filter` | `'all'` | `all` / `image` / `video` | `setFilter`、配置、`localStorage` |
| `sortMode` | `'mtime-desc'` | `mtime-desc`（新→旧）/ `mtime-asc`（旧→新） | `setSort`、配置、`localStorage` |
| `autoplay` | `true` | 主图视频是否自动播放（缩略图永不自动播） | `setAutoplay` |
| `autoFs` | `false` | 是否"下次第一次点按自动进全屏" | `setAutoFs`、`fullscreenchange` |
| `gridPage` | `0` | 图集当前页（0 基），每页 `GRID_PER_PAGE = 20` | `openGrid`/`gridStep` |
| `lastPickDir` | `null` | 目录浏览器"上次落在哪"，优先于按源/目标推导的起点 | `pickerLoad`（1389） |
| `swapMode` | `null` | 设置面板的模式：`null` / `'slot'`（调顺序）/ `'source'`（源目标互换） | `openSetup`（1133）、按钮 |
| `swapFirst` | `-1` | 调顺序模式下"已选中的第一个槽位" | `renderSetup`（1163） |
| `source` | `null` | 待分类目录 `{path,name}`；`path` 已 `normPath`（尾 `/`） | `setSource`、`goToDir`、配置 |
| `targets` | `Array(20).fill(null)` | 20 个目标槽位，每项 `{path,name}` 或 `null`，**顺序即界面顺序** | `setTarget`、批量、互换、配置 |
| `del` | `null` | "丢弃"目录 `{path,name}`；语义上就是一个固定目标，不占槽位 | `setDel`、配置 |
| `undoStack` | `[]` | 撤销栈，元素 `{backDir, name, from, mode}`；**多步、持久化、上限 50** | `classify` push（966）、`dropUndo`；`clearAll` 整体置空（1557） |
| `busy` | `false` | 全局互斥：`openSource`/`classify`/`undo`/`deleteSourceDir` 进出时置位 | 守卫 581（`openSource` 的 `force` 可越过）；置位 582、962、1008、1088；释放 598、1001、1036、1116 |
| `counts` | `{}` | `目标路径 → 非目录条目数`，槽位按钮上的"N 个" | `refreshCounts`（1312） |
| `pick` | `{mode:'source', slot:-1, dir:'/', chosen:new Set()}` | 目录浏览器的一次会话状态：模式、目标槽位、当前目录、批量勾选集合、来源面板（`main`/`setup`） | `openPicker`（1328） |
| `dirty` / `saving` | `false` | 待保存标记 / 保存中（用于避免并发 PUT 与重排） | `scheduleSave` / `saveConfig` |

### 4.3 配置文件 `snap-config.json`

由 `snapshot()`（494–501 行）**逐字**生成，结构如下：

```json
{
  "version": 1,
  "source": { "path": "/pool-a/photos/to-sort/", "name": "to-sort" },
  "targets": [
    { "path": "/pool-a/photos/family/", "name": "family" },
    { "path": "/pool-a/photos/trips/",  "name": "trips" },
    null,
    "…共 20 项，顺序即槽位顺序，空槽位为 null"
  ],
  "del": { "path": "/pool-b/trash/", "name": "trash" },
  "filter": "all",
  "autoplay": true,
  "autoFs": false,
  "sort": "mtime-desc",
  "undo": [
    { "backDir": "/pool-a/photos/to-sort/", "name": "IMG_0001.jpg",
      "from": "/pool-a/photos/family/IMG_0001.jpg", "mode": "move" }
  ],
  "updated": "2026-01-01T00:00:00.000Z"
}
```

读取端 `applyConfig(c)`（502–533 行）的容错规则：

- `c` 不是对象 → 返回 `false`，什么都不改。
- `source` / `del`：**必须有 `path`** 才接受，`name` 缺失时用 `labelOf(path)` 兜底。
- `targets`：先 `slice(0,SLOT_N)`，逐项 `{path,name}` 或 `null`，再 `concat(20 个 null)` 后 `slice(0,20)` —— **保证长度恒为 20**。
- `filter` 必须是 `all|image|video` 之一；`sort` 必须是 `mtime-asc|mtime-desc`；`autoplay`/`autoFs` 必须是布尔。
- `undo`：过滤掉缺字段的记录（要求 `backDir`/`name`/`from` 都是字符串），再 `slice(-MAX_UNDO)`。
- **载入时清理历史重复**（520–531 行）：同一目录不能既当源又占槽位（重复的槽位置 `null`）、丢弃目录若与已见目录重复则清空；发生过清理就置 `configCleaned = true`，`loadConfig` 顺手 `scheduleSave()` 把干净版本写回去（540 行）。
- `version` 与 `updated` **写了但不读**：`applyConfig` 不校验版本、也不用时间戳做合并（多设备并发时是"最后写入者胜"）。

---

## 5. WebDAV 接口契约

| 方法 | 用在哪 | 请求头 / 正文 | 期望响应 | 异常处理 |
| --- | --- | --- | --- | --- |
| `PROPFIND` | 列目录（`Depth: 1`）、`statOf` 单点查询（`Depth: 0`） | `Depth` 头 + `application/xml` 正文，请求三个属性（422–425 行） | `207 Multi-Status` | `401` → 抛"认证失败：重新输入 NAS 账号密码后刷新页面"；`404` → 返回 `null`（调用方各自处理）；其他 → 抛 `列目录失败 HTTP n`（426–428 行） |
| `GET` | 读 `snap-config.json`（`?t=` 防缓存 + `cache:'no-store'`）；图片/视频的字节流由 `<img>`/`<video>` 隐式 `GET` | — | `200` / `404` | 配置 `404` = 首次使用，不报错；其他失败回退 `localStorage` 缓存并提示"配置读取失败（先用本地缓存）" |
| `PUT` | 写 `snap-config.json` | `Content-Type: application/json; charset=utf-8` | 任意 `2xx` | 非 2xx 抛错 → 提示"配置没能保存到 NAS…（下次打开可能丢失）" |
| `MOVE` | 分类、撤销（首选路径） | `Destination: ORIGIN + destHref`、**`Overwrite: F`** | `201`/`204` | `412` → 同名，换名重试；`405`/`500`/`502` → 退化 `COPY`；其他 → 抛错并保留 `status` 供调用方识别 `404` |
| `COPY` | 跨盘兜底（`place` 与 `undo`） | 同上 | `2xx` | 失败 → "跨盘复制失败 HTTP n（原 MOVE 返回 405/500/502）"，**源文件未删**（478 行：文案同时给出 `COPY` 的状态码与先前 `MOVE` 的状态码，便于判断是"这盘真的不支持 rename"还是别的问题） |
| `DELETE` | 删源文件（跨盘兜底第二步）、删空目录 | — | `204`/`200` | 非 2xx → "复制成功但删除源失败：目标已有副本、源仍在，请手动处理" |
| `MKCOL` | **应用不使用**；仅 `tools/deploy-webdav.sh` 递归上传时建目录 | — | `2xx`，`405` 视为已存在 | 见 §2.1 |

### 5.1 `Overwrite: F` 的作用

`MOVE` / `COPY` 都显式带 `Overwrite: F`（465、1014 行）。语义是：**目标已存在时服务器必须拒绝，而不是覆盖**。服务端按 RFC 4918 返回 `412 Precondition Failed`，`place()` 把它当作"这个名字被占了"，于是换下一个候选名重试（467 行）。
重命名规则（458–462 行）：`stem (i)suffix`，`i` 从 1 试到 49（循环上限 50 次），全部失败则抛"同名文件过多（已试 50 个名字）"。
注意 `i===0` 时用的是原名，所以**只有真冲突才会改名**。

### 5.2 `405` 的含义与跨盘降级

同一存储池内的 `MOVE` 是原子 rename，快且不搬字节。但**跨挂载点时服务器不支持 rename，返回 `405`**（文件头注释 + `poolOf` 上方注释 393 行都记录了这条实测结论；`500`/`502` 也一并当作"这次 rename 做不了"处理，476 行）。
降级流程（`place()` 476–487 行）严格按以下顺序，**任何一步不过关都不删源**：

1. `COPY srcHref → Destination`（同样 `Overwrite: F`，同样会为同名重试换名）；
2. `statOf` 目标：不存在或居然是目录 → 抛"复制后目标不存在 —— 已保留源文件，未删除"；
3. **大小校验**：源 `srcSize > 0` 且目标 `size !== srcSize` → 抛"复制后大小不一致（源 x / 目标 y）—— 已保留源文件，未删除"（481–482 行）；`srcSize === 0` 时跳过校验（无法判断，代码中未体现其他校验手段，例如校验和）；
4. 只有前面全过，才 `DELETE` 源；删源失败 → "复制成功但删除源失败：目标已有副本、源仍在，请手动处理"；
5. 成功返回 `{ok, finalName, destHref, mode:'copy'}`，`mode` 会进撤销栈并显示为"（跨盘复制）"提示。

### 5.3 `Range` 与视频

应用**不构造 `Range` 请求**：视频用 `<video src="...">` 直接播，字节范围协商完全交给浏览器原生媒体栈（`preload="metadata"`，855 行）。代码里也没有 `HEAD`、没有 `Content-Length` 探测。
为了让移动端在只拉到元数据时也能画出画面，源码 URL 一律加 `#t=0.1` 片段（673、854、897 行）—— 这是"显示首帧"的经验手段，与 `Range` 无关。
**（代码中未体现）**：服务端是否支持 `Range`、拖动进度条是否顺畅，取决于 NAS 的 WebDAV 实现，应用不做探测也不做兜底。
缩略图与图集格只用 `loading="lazy"` + `#t=0.1`，**不会自动播放**（715 行注释）。

---

## 6. 核心流程

### 6.1 启动引导（`boot()`，1611–1630 行）

1. **先用 `localStorage` 瞬间渲染**：依次读回配置缓存（`snap.config.cache`）、筛选（`snap.filter`）、自动播放（`snap.autoplay`）、自动全屏（`snap.autofs`）、排序（`snap.sort`），目的是"先用浏览器缓存瞬间渲染，再以 NAS 上的配置为准"，避免等网络时白屏。
2. `buildSlots()` **一次性**创建 20 个槽位按钮（1618 行，见 §7.4），再跑各 UI 同步函数与首屏 `renderSlots()` / `renderHeader()`。
3. `await loadConfig()`：失败时 `loadConfig` 自己已回退到本地缓存并 toast 报错；成功后重画一次。
4. 选起始目录：`const start = (S.source && S.source.path) || DIR;` —— 有源就打开源，否则打开**本页所在目录**（1626 行），这样首次部署后从零开始也有东西可看；随后 `await openSource(start)`。
5. `armAutoFs()`：若开了自动全屏，挂"第一次 `pointerdown`/`keydown`"一次性监听（全屏必须由用户手势触发）。
6. `refreshCounts()`：异步扫各目标目录的条目数，槽位上的"N 个"稍后自然出现。

失败分支：`openSource` 内部 catch，只 toast 不中断启动；配置读取失败不阻塞界面（离线也能看缓存里的源目录名）。

### 6.2 浏览目录与"选源"

- **进目录**：底部胶卷条的 📁 按钮（`renderFilm` 886–891 行）或顶栏源按钮 → 目录浏览器。
- **第一层的规则**：`goToDir(dir)`（1064–1075 行）——**在主界面点一个子目录＝把它设为新的待分类目录**。注释说明了理由：早期只改浏览位置不改源，导致"正在分类 A，左上角却写着未选择源"的错乱。
- **冲突保护**：该目录若已经是某个目标槽位或丢弃目录，则**只浏览、不动源**（`conflictWith(p, {selfSource:true})` 非空就不设置）。
- **顶栏如实标注**：`renderHeader` 比较 `normPath(S.source.path)` 与 `normPath(S.cwd)`，不等时路径后加"（仅浏览，非待分类目录）"（813–814 行）。
- 顶栏源按钮 → `openPicker('source', -1)`，在**目录浏览器**里逐层导航后点"选定此目录"（`commitPick` → `setSource`），成功后 `S.index = 0` 并 `openSource(path)`（1473 行）。
- 换目录一律 `showList(true)` → **回到第 1 个**（595 行）。

### 6.3 分类移动（`classify`，958–1002 行）

1. `S.busy` 守卫：忙时直接 return（连点不会叠加）。
2. 取当前项 `S.files[S.index]`；没有就提示"这个目录里没有可分类的图片"。
3. `place(f.href, f.name, f.size, destDir)`（目标路径补尾 `/`）；**这就是全部的文件操作**。
4. 成功：push 撤销记录 `{backDir: S.cwd, name: res.finalName, from: res.destHref, mode: res.mode}`，超过 `MAX_UNDO = 50` 就 `shift()` 掉最老的；`scheduleSave()`（撤销栈也跟着存 NAS）；`S.counts[目标] += 1`（有缓存才加，否则保持"…"等下次 `refreshCounts`）；`navigator.vibrate(12)`；toast 会说明**是否改名**与**是否跨盘复制**。
   - **同时**从 `S.files` 和 `S.raw` 里 splice 掉这一项（973–977 行，理由见 §7.6），`S.entryCount -= 1`（否则处理完最后一张后"删除这个空文件夹"永远不出现，978 行注释）。
   - 钳制 `S.index` → `render()` + `preload()`；**闪光动画放在 render 之后**，因为 `renderSlots()` 会重设 `className`，先加会被冲掉（982 行注释）。
5. 失败分支：
   - `e.status === 404` → "这个文件已不在源目录，已从列表移除"，并**真的从 `S.raw` / `S.files` 里摘掉**，避免用户反复点、反复报错（989–997 行）；
   - 其他错误 → 原文 toast（`place()` 已经给出人话级信息，如"已保留源文件，未删除"）。

### 6.4 撤销（`undo`，1004–1059 行）

- **多步栈**，最多 50 步（`MAX_UNDO`，与桌面版一致）；栈**持久化**到 `snap-config.json` 的 `undo` 字段，刷新/换设备后还能继续撤销（498 行）。
- 流程：
  1. `S.busy` 守卫；取栈顶 `rec`。
  2. `toast('撤销中…')` 先给反馈（这是网络操作，可能慢）。
  3. `MOVE rec.from → joinEnc(rec.backDir, rec.name)`，同样 `Overwrite: F`。
  4. 状态码分派（**这是本流程最关键的设计**）：
     - `412` → **中止**："原位置已有同名文件，撤销中止（没有改动任何文件）"（1016 行）。选择中止而非改回别的名字，因为撤销的语义是"回到原位"，改名回退会让用户看到意料之外的文件名。
     - `404` → 标记 `gone = true`：文件已不在目标位置（可能被别的程序移走）——**这一步永久失效**，所以把它从栈里弹掉再报错（1033 行注释："免得卡住后面几十步"）。
     - `405`/`500`/`502` → 走 `COPY` 回拷，并且**和 `place()` 一样是"先校验后删源"**：回拷前先 `statOf(rec.from)` 记下原大小（1019 行），回拷后 `statOf(back)` 校验——目标不存在、目标居然是目录、或**大小不一致**都直接报错并保留目标位置的文件（1022–1025 行），只有全部通过才 `DELETE` 目标副本（1026–1027 行）。失败文案明确区分"回拷校验失败 —— 原副本仍在目标位置，未删除"/"回拷后大小不一致（原 x / 新 y）—— 目标位置的文件已保留，未删除"/"回拷成功但清理失败，请手动检查"。
  5. `finally` 里**先释放 `S.busy`**（1036 行注释：必须先释放，否则后面的 `openSource` 会被自己的守卫挡掉）。
  6. 成功后：`dropUndo(rec)`（弹栈 + 存档 + 重画槽位）→ `openSource(S.cwd, true)` → **跳回被撤销的那张**：`S.files.findIndex(f => f.name === rec.name)`，命中就设 `S.index` 并平滑滚动胶卷条（1040–1048 行）。注释说明这是对齐桌面版行为，方便立刻重新分类。
  7. 最终 toast：`已撤销：xxx → 第 i / n 张（还可撤 k 步）`。

### 6.5 筛选与排序

- **单一事实来源**：`S.raw` 是目录里的全部媒体，`S.files` 只是它的过滤视图（`buildFiles()`，607–611 行）。任何"列表内容"的变化都必须改 `S.raw`，`S.files` 由 `buildFiles()` 重算。
- **切换筛选**（`setFilter`，705–713 行）：写 `localStorage` → `showList(true)`（**回到第 1 个**，709 行有 ★ 注释）→ `scheduleSave()`（顺手存进 NAS 配置）→ toast 告知本类型有几个。
- **排序**（`sortRaw`，616–620 行）：按 `mtime` 乘方向因子比较；**时间相同时用 `localeCompare(name, 'zh', {numeric:true})` 兜底**。原因是 WebDAV 的 `getlastmodified` 只有秒级精度，同一秒的连拍会打平（613–615 行注释，桌面版规则相同）。
- **切排序**（`setSort`，633–644 行）：与"切换筛选"不同，这里**尽量停在同一张**：先记下当前项的 `href`，重排后重新 `findIndex`，找不到才回第 1 个；图集开着时同步把 `gridPage` 对齐到该下标所在页（641 行）。排序偏好写 `localStorage` 并入配置。
- `showList(resetIndex)` 统一出口：`sortRaw → buildFiles → 钳制 index（或归零）→ updateFilterUI → render → preload`（623–630 行）。
- 预加载 `preload()` 只预取**图片**的 `index+1 / index+2 / index-1`（797–802 行），不做视频预取。

### 6.6 图集（`openGrid` / `renderGrid`，652–693 行）

- 每页 `GRID_PER_PAGE = 20`（4 列 × 5 行，`.ggrid` 的 `repeat(4,1fr)`）；打开时**定位到当前图所在页**（`S.gridPage = Math.floor(S.index / GRID_PER_PAGE)`，655 行），空目录直接 toast 拒绝（654 行）；标题带目录名与总数：`图集 · <目录名>（N）`。
- 每格：图片用 `<img loading="lazy">`，视频用 `<video preload="metadata" muted playsinline src="...#t=0.1">` + ▶ 角标；左上角显示**全局序号**（`gi+1`，不是页内序号），当前项加 `.sel` 高亮。
- 点格子：设 `S.index` → 关面板 → 只重画 `renderStage` / `renderFilm` / `preload`（不整页 `render`）。
- 翻页：`gridStep(d)` 后 `renderGrid()` 并把 `.body` 的 `scrollTop` 归零；页码显示"当前 / 总"，首末页禁用对应按钮；图集内也能切排序（`sortNew` / `sortOld`），`setSort` 会同步重算 `gridPage`。

### 6.7 目录设置（设置面板，1132–1315 行）

- **20 个槽位**（`SLOT_N = 20`，4 列 × 5 行；CSS 用 `--slot-h/--slot-gap` 把可视高度限成"3 行"`max-height:calc(3*var(--slot-h) + 2*var(--slot-gap))`，可上下滑，底部渐隐提示"下面还有"，`updateSlotsFade()`）。面板里的分组标题是 `目标目录（<span id="slotN">20</span> 个槽位）`，其中的数字由 `openSetup()` 用 `$('slotN').textContent = SLOT_N` 写入（1134 行），槽位数不再有第二处写死的文案。
- **每行三个快捷动作**：`浏览`（打开目录浏览器）、`当前`（把 `S.cwd` 直接设为该角色）、`清`（置 `null`）。
- **去重与互斥校验**：`conflictWith(path, {selfSlot|selfSource|selfDel})`（1259–1268 行）扫描全部槽位 + 丢弃 + 源，命中就返回冲突类型，`conflictMsg` 给出人话提示（如"「x」已经在槽位 3 了，不能重复添加"），并且**拒绝写入**（返回 `false`）。
- **批量勾选**（`openPicker('batch', …)` + `applyBatch`，1478–1505 行）：
  - 左侧 42×42 的方框才是"选中"，**点行的其它地方＝进入该目录**（439 行注释 + `row.onclick = () => pickerLoad(d.href)`）；"全选"只作用于**当前这一层**（`pickerCurrentDirs()`）。
  - 提交时先做**三重过滤**（1481–1490 行）：已在槽位里的计入 `dup`；**等于源目录或丢弃目录的计入 `conflict`**（先把两者的 `normPath` 放进 `blocked` 集合，批量和单选走同一套互斥语义）；通过的从前往后塞进**空槽位**，槽位满了的另计 `full`。toast 汇总"已加入 x 个，跳过 y 个（已在槽位里），k 个是源目录或丢弃目录，不能当目标，z 个没地方放（20 个槽位已满）"——**满槽文案里的数字来自 `SLOT_N` 而不是写死**（1501–1502 行）。
  - 勾选数实时显示在提示行（`updateBatchHint`），按钮文案也带 `(N)`。
- **槽位互换**（`doSwapSlots`，1232–1241 行）：先点一个"选它"，再点另一个即交换，**允许和空槽位换**（`tmp` 直接对调）；`a === b` 会拒绝并提示。
- **源与目标互换**（`doSwapSourceWithSlot`，1243–1255 行）：把某槽位目录升为源，原源放进该槽位；槽位为空时拒绝（"这个槽位是空的…"）；互换后立即 `openSource(新源, true)`。
- **填充满槽**（`fillBtn`，1538–1554 行）：用当前目录的子目录（`S.dirs`）依次填满空槽位；已在槽位里的、以及**等于源目录或丢弃目录的**都跳过（后者计入 `skipped`，1543–1545 行），槽位满则停；有跳过时 toast 补一句"（跳过 N 个源/丢弃目录）"。
- **计数**：`refreshCounts()` 对每个已设置槽位发一次 `Depth:1` `PROPFIND`，取**非目录条目数**写入 `S.counts[path]`，然后重画；失败写 `null`（界面显示"…"）。触发时机：打开设置面板、设置目标后、`visibilitychange`（**30 秒节流**，1567–1573 行）、以及启动时。
- **清空**：`清空目标` 只清 20 个槽位 + 丢弃（`clearTargets`，1531–1536 行；确认框里的槽位数同样来自 `${SLOT_N}`，见 1532 行；源与撤销栈保留）；`全部清空` 连源、**撤销栈**、以及当前视图状态（`cwd`/`raw`/`files`/`index`/`entryCount`/`otherNames`）一起清掉并整屏重画（`clearAll`，1555–1561 行）。两者都只改配置与内存，**不动磁盘文件**（确认弹窗里明说）。

### 6.8 目录浏览器（`openPicker` / `pickerLoad`，1318–1395 行）

- **起始目录的优先级**（1322–1326 行）：先按角色推导（源→源的父目录、丢弃→丢弃的父目录、槽位→槽位的父目录），**再被 `S.lastPickDir` 覆盖**；都不为空才退回 `/`。注释解释了动机：早期源为空时直接回根目录，删完文件夹再选新目录就要从根一层层找。
- **面包屑显示存储池**：`poolOf(路径第一段)`，并标注"与源同盘 / 与源不同盘 ⚠"（1372–1373 行）。
- `pickerLoad` 只列**子目录**（`listDirs` = `Depth:1` 后筛 `dir`），不列文件；成功载入就记 `S.lastPickDir = S.pick.dir`。
- **`404` 兜底**：请求的目录已不存在（例如上次浏览的目录刚被删）时，回退到 `fallback`（角色推导出的起点）再试一次；`fallback` 也不行就显示"这个目录已经不存在了，点上面的 ↑ 换个地方"（1381–1387 行）。
- 顶部三个按钮：`↑` 上一层（到 `/` 就停）、`⌂` 回根、`↻` 重载当前层。
- **返回语义**：`S.pick.from` 记住"从哪进来的"——从设置面板进来的，取消/完成/关闭后回设置面板；从主界面点源按钮进来的，完成后直接回主界面（1470–1471、1577–1579 行）。

### 6.9 删除空目录（`deleteSourceDir`，1080–1129 行）

- **判定条件**：`canDeleteSource()` = 有源 **且** `S.cwd === S.source.path` **且** `S.entryCount === 0`（1080–1082 行）——即**正在看的就是源目录，且一个条目都没有**。入口出现两处：主图空态里的大按钮（841–848 行）与设置面板源行下方的按钮（1197–1202 行）。
- **删前复核**：不信任内存里的 `entryCount`，**再发一次 `Depth:1` `PROPFIND` 以磁盘实时状态为准**；只要还有**任何**条目（子目录、`txt`、隐藏文件都算）就抛错并列出前 5 个名字（1093–1101 行）。
- **设计取舍**：桌面版会把"被过滤排除的文件"搬进 `Del` 再删目录（README 有描述），手机版**故意不这么做** —— 注释写得很直白："不自动搬运、不'顺手'处理非图片视频的东西 —— 宁可让人去文件管理器清干净"。宁可不删，也不误伤。
- 二次确认（`confirm`）→ `DELETE` 目录（只有空目录能删，非 2xx 报"删除目录失败 HTTP n（只有空目录能删）"）。
- **撤销栈清理**：所有 `backDir` 指向该目录的撤销记录都失效，过滤掉并统计条数，在成功 toast 里如实告知（"N 步撤销已失效并移除"，1107–1111、1128 行）。
- 收尾：`S.source = null`，清空 `cwd/raw/files/index/entryCount/otherNames`，存配置、重画，然后 `openSource(parentOf(dir), true)` 停在**父目录**，并把 `S.lastPickDir` 设为父目录（注释：下次选新目录就从这里开始）。

### 6.10 全屏（737–795 行）

- 顶栏 `⛶` 按钮 → `toggleFullscreen()`：进用 `document.documentElement.requestFullscreen({navigationUI:'hide'})`，出用 `document.exitFullscreen()`；失败 toast"这个浏览器不允许全屏：…"。
- **自动全屏必须等用户手势**：`armAutoFs()` 挂 `pointerdown`/`keydown` 的**一次性捕获监听**，第一次点按才真正 `requestFullscreen`（768–783 行注释）。这是浏览器安全策略决定的，不是实现偷懒。
- `fullscreenchange` 里有一个**反向联动**：如果不是全屏状态且 `S.autoFs` 为真，就把 `autoFs` 关掉并保存（786–791 行）—— 用户手动退出全屏，表示他不想一直被弹进全屏。
- `visibilitychange` 时重新 `armAutoFs()`（793–795 行）：从别的 App 切回来，重新等一次手势。
- **安全上下文说明**（733–736 行注释）：Fullscreen API **不需要** HTTPS，所以 `http://` 下也能用；但"像 App 一样独立窗口、无地址栏"的 PWA 安装必须要 HTTPS + Service Worker，明文 `http` 下只能建普通书签快捷方式。

### 6.11 配置持久化（552–574 行）

- **防抖保存**：`scheduleSave()` 置 `S.dirty` 并 500ms 后 `saveConfig()`，同时**立刻**把 `snapshot()` 写进 `localStorage`（`snap.config.cache`）作为最后一道保险（558 行）。所有改配置的动作都走它：设源/目标/丢弃、筛选、排序、自动播放、自动全屏、互换、批量、撤销栈变化。
- **写冲突**：`saveConfig()` 若发现 `S.saving` 仍为真，就再 `scheduleSave()` 一次（561 行），即"正在 PUT 时又有新改动 → 排队再存一次"，保证最后一次改动一定落盘。
- **失败提示**：任何异常 → `setSync('err', '配置没能保存到 NAS：<原因>（下次打开可能丢失）')`，`setSync` 只对 `err` 做 toast（414–418 行注释：其他状态一律忽略，出错必须让人知道）。
- **载入时清理历史重复**：见 §4.3 最后一条，清理后立即回存。
- 界面上**没有**"已同步/保存中"的状态显示：原来的顶栏小字被去掉了，只保留错误提示（415 行注释）。

---

## 7. 关键设计决策与理由

> 每条按"决策 → 理由 → 代价"写。理由优先引用代码里已经写下的注释，其余是从调用关系推出的结论。

### 7.1 一切写操作都用 `Overwrite: F`，不用默认覆盖

- **决策**：`MOVE` / `COPY` 一律带 `Overwrite: F`，靠 `412` 触发"换名重试"。
- **理由**：文件分类是**不可逆**的破坏性操作，两个不同来源的照片经常同名（`IMG_0001.jpg`）。默认覆盖会静默销毁一张照片，而且事后无法发现。`Overwrite: F` 把这件事变成服务端的强制拒绝，客户端只能选择"改名"，从机制上排除覆盖路径（466–470 行）。
- **代价**：同名多时要多发几次请求（上限 50 次）；并且**依赖服务端正确实现 `412`** —— 若某个 WebDAV 实现忽略 `Overwrite` 而直接覆盖，应用层没有第二道防线（代码中未体现"先 HEAD 探测目标是否存在"的预检）。

### 7.2 跨盘"先校验后删源"，而不是 `COPY` 完就删

- **决策**：`COPY` 成功后必须 `statOf` 目标并且**大小一致**才 `DELETE` 源（477–485 行）。撤销的跨盘回拷走同一套规则（1019–1027 行）：回拷前记下原大小、回拷后比对，不一致就保留目标位置的文件并报错——两条跨盘路径现在是对称的。
- **理由**：跨存储池的复制是"两个独立 IO"，中途可能断流、可能被服务端静默截断。一旦先删源，坏掉的就是"唯一的一份"。校验失败时刻意保留源文件并把原因写进错误文案（"已保留源文件，未删除"），把决策权还给用户。
- **代价**：多一次 `PROPFIND` 往返；大小相同并不能证明内容相同（**代码中未体现**校验和/摘要比对）；`srcSize === 0`（服务端没给长度）时只能跳过校验。

### 7.3 配置文件用绝对 URL（`ORIGIN + DIR`）

- **决策**：`CFG_URL = ORIGIN + DIR + 'snap-config.json'`，不用相对路径。
- **理由**：代码注释写明——页面从**带凭据的 URL**（`http://user:pass@host/...`）打开时，相对 URL 会让 `fetch` 直接抛错。这在"手机浏览器输 NAS 账号"的真实用法里是常态。
- **代价**：页面一旦被换目录部署，**旧目录的 `snap-config.json` 不会被继承**（配置跟着页面文件走，这是刻意的：配置与本页同目录，便于整目录搬迁与清理）。

### 7.4 槽位按钮只创建一次，之后原地更新

- **决策**：`buildSlots()` 只在启动时跑一次（1618 行），之后 `renderSlots()` **只改 `className` 和三个子元素的 `textContent`**，从不 `innerHTML=''`。
- **理由**：910–912 行的注释把机制说透了——如果每次移动都重建 DOM，**清空的瞬间内容高度归零，浏览器会把滚动位置钳回顶部**；用户滑到第 4、5 行点一下就页面弹回顶部，20 个槽位变得不可用。
- **代价**：槽位的"内容"与 DOM 结构强耦合（`.n` / `.c` / `.k` 三个 span 必须存在）；新增槽位态（例如"只读""禁用"）必须走 `className` 约定。另外闪光动画必须排在 `render()` **之后**加类，否则被 `className` 重设冲掉（982 行）。

### 7.5 `openSource` 必须有 `force` 参数

- **决策**：`async function openSource(dir, force)`，`force` 为真时无视 `S.busy` 守卫（577–581 行）。
- **理由**：`undo()`、`deleteSourceDir()` 这类操作**自己就处在 `busy` 作用域内**，它们完成动作后需要立刻刷新目录列表。如果没有这个口子，`openSource` 会被自己刚设上的 `busy` 挡掉，用户看到的现象是**"操作成功了但界面没动"**（两处 `finally` 里都有"先释放 busy"的 ★ 注释，1036、1116 行）。两种写法（内部强制刷新 vs 先释放 busy 再调用）代码里都用了，属于同一问题的双重保险。
- **代价**：`force` 绕过了互斥保护，如果将来有"后台并发刷新"的场景，可能出现两次 `openSource` 交错写 `S.raw`/`S.cwd`（当前代码里所有 `force` 调用都是串行的，未体现竞态防护）。

### 7.6 `S.raw` 是筛选的唯一事实来源

- **决策**：`S.raw` = 目录全部媒体，`S.files` = 过滤视图；**移动文件时必须从 `S.raw` 和 `S.files` 里各删一次**（973–977 行）。
- **理由**：`S.files` 是派生的，`buildFiles()` 每次都会从 `S.raw` 重算。如果只删 `S.files`，切换一次筛选（`setFilter` → `showList` → `buildFiles`）就会把**已经移走的照片重新算回来**，界面上出现"复活"的幽灵条目，再点它必然 404（603–606 行注释记录了这次踩坑）。同样地，`classify` 遇到 404 也要从 `S.raw` 摘掉（992–995 行）。
- **代价**：改写列表的每处都要记得"删两份"，是易错点（属于约定而非类型保证）；`S.raw` 与磁盘真实状态之间只靠 `openSource` 重新拉取来对齐。

### 7.7 "丢弃"只做移动，应用内不真删文件

- **决策**：`丢弃` 槽位（`S.del`）语义等于一个固定目标，`$('discard').onclick` 最终就是 `classify(S.del, null)`（1515–1519 行）；应用内**唯一**的 `DELETE` 是"空目录"和跨盘复制的源清理。
- **理由**：手机上一屏 20 个按钮，误触概率远高于桌面；把"删除"降级为"移到一个你指定的目录"，等于给所有破坏性操作加了一层可回收缓冲（`Del` 目录清空与否由用户自己在文件管理器决定）。文件头第 ③ 条规则就是这句话。
- **代价**：磁盘空间不会立刻释放，用户需要自己去清"丢弃"目录；真删能力不在应用内（要退出到文件管理器）。

### 7.8 配置存 NAS 上的 JSON，而不是浏览器本地存储

- **决策**：以 `snap-config.json` 为准，`localStorage` 只做**启动瞬间的缓存**与**保存失败时的兜底**。
- **理由**：本地存储绑定"这台设备 + 这个浏览器 + 这个源"三者，清一次缓存或换台手机就要重新配 20 个槽位；而配置的本质是"NAS 上的目录结构"，放在 NAS 上天然跟着数据走（1226 行说明："换设备/换浏览器/清缓存都能沿用"）。撤销栈一起放进去，则"刷网页/换手机还能继续撤销"。
- **代价**：
  - 配置是**明文 JSON**，会暴露目录结构（未加密、也无签名）；
  - **多设备并发写没有互斥**，最后写入者胜（代码中未体现锁或版本合并）；
  - 每次改动都要一次网络 `PUT`，离线时只能靠 `localStorage` 兜底并提示"下次打开可能丢失"。

### 7.9 其他几条较小的取舍

| 决策 | 理由（出处） | 代价 |
| --- | --- | --- |
| 删目录条件收紧为 `entryCount === 0`（一个条目都不能有） | 注释：不去"顺手"搬运非图片视频的东西，宁可让人去文件管理器清干净（1091–1092 行） | 用户要多一步手工清理；比桌面版能力弱 |
| `setFilter` 回到第 1 个，`setSort` 尽量停在同一张 | 换类型等于换了一批文件，"保持下标"会指到无关的图（709 行 ★）；换排序只是换顺序，"丢位置"会让人找不到刚才那张（632 行） | 两个入口行为不一致，需要记 |
| 主图视频加一层大 ▶ 按钮（`.playbtn`） | 注释：移动端 `preload=metadata` 常常只显示黑框，需要明确的点击目标（63 行） | 多一层 DOM 与显隐状态（play/pause/ended 三处同步） |
| 缩略图用 `#t=0.1` 而不是抽帧 | 让移动端也能画出首帧，成本为零 | 依赖浏览器对 media fragment 的支持（代码中未体现降级） |
| 计数懒加载 + 30 秒节流 | 20 个槽位串行 `PROPFIND` 会明显拖慢面板打开（1309–1315、1567–1573 行） | 计数可能不是实时值，外部改动要切回前台才刷新 |
| 只列单层目录、不递归 | 分类场景就是"一个待分类目录 → 若干目标"，递归既无必要也放大了误操作面 | 深层整理要一层层进（见 §8） |
| 「全部清空」连撤销栈与当前视图一起清（1555–1561 行） | 撤销记录指向的正是刚被清掉的目录，留着只会在下次撤销时报错；一并清掉比留一堆必然失败的记录更诚实 | 一次误点会丢掉全部可撤销历史，除了 `confirm()` 里的文字说明没有别的保护 |

---

## 8. 已知限制与未实现项

**从代码可以确认的边界**

1. **不递归**：`openSource` 与 `listDirs` 都只发 `Depth: 1`；子目录只在胶卷条上以 📁 出现，需要点进去。没有任何"递归扫描/递归移动"的实现。
2. **时间精度只有秒**：`DAV:getlastmodified` 是 HTTP 日期格式，秒级；同秒文件靠文件名 `localeCompare(..., {numeric:true})` 稳定兜底（613–619 行）。因此"最新拍的"排序在同秒连拍时不是真正的拍摄顺序。
3. **媒体类型是白名单**：`IMG = {jpg,jpeg,png,gif,webp,avif,bmp}`、`VID = {mp4,webm}`（380–381 行）。HEIC/RAW/MOV 等一律被当作"非媒体条目"，会显示在"还有 N 个其它条目"里，并**阻止删除空目录**。
4. **明文 HTTP 的连带后果**（733–736 行注释 + 全文件无 `serviceWorker`/`register` 调用）：无 Service Worker、无离线缓存、无 PWA 安装（`<meta name="apple-mobile-web-app-capable">` 存在，但缺 manifest 与 SW，在 `http` 下基本不生效）；**无屏幕常亮**（没有任何 `navigator.wakeLock` 调用）；账号密码只能靠 URL / 浏览器密码框以基本认证方式提供。
5. **配置明文且无版本校验**：`snap-config.json` 里是完整目录路径与撤销记录，无加密、无签名；`version` 字段写了但 `applyConfig` 不读。
6. **无并发保护**：多设备同时改配置会互相覆盖；应用内靠 `S.busy` 做单端互斥，但没有跨端锁。
7. **批量能力有限**：只有"批量添加槽位"（`applyBatch`）与"用子目录填充空槽位"。**没有**批量移动、批量删除、多选后一次分类。
8. **键盘**：只绑定了 `←` / `→` / `空格` / `1`–`9` / `Ctrl`+`Z`（`⌘`+`Z` 亦可）/ `Esc`（1586–1608 行）。桌面版的 **`Del`（移入固定丢弃目录）与数字 `0` 在手机版没有绑定**，且键位映射不同：手机版数字 `1` 对应**第 1 个**槽位，桌面版是 `0` 对应第 1 个、`1`–`9` 对应第 2–10 个（`SORT_KEYS = ['0'…'9']`）。第 10–20 个槽位在两端都没有快捷键。面板打开时只响应 `Esc`（依次关闭目录浏览器 → 图集 → 设置面板；从设置面板打开的浏览器会退回设置面板），其余按键一律不响应——1588–1589 行注释记录了原因：**早期漏判 `gridSheet`，图集开着时按 `1`–`9` 会真的把文件移走**。
9. **没有目标目录图集、飞入动画与三联预览**：桌面版可对目标目录做只读图集（`openTargetGrid`）、移动时 `flyToSlot` 把当前图缩小飞入槽位、主图两侧显示相邻图；手机版图集只浏览当前（源）目录，移动反馈退化为"槽位闪光 + 12ms 震动"（970、983–986 行），预览是单张主图 + 底部横向胶卷条（`renderFilm`）。
10. **撤销不可重做**，删目录只会静默移除相关撤销步（在 toast 里报告数量），「全部清空」也会把撤销栈一起清掉；**计数不是实时值**，依赖 `refreshCounts` 的触发时机与 30 秒节流，外部程序改动目标目录后数字会滞后；**无搜索、无按日期/相册分组**，图集每页固定 20 张；**预加载只针对图片**的 `index+1/+2/-1`（797–802 行），视频只有 `preload="metadata"`。
11. **没有正向保存提示**：`setSync('on'|'ok', …)` 是空实现（只处理 `'err'`），用户只能通过"没有报错"推断已存到 NAS；`snap-config.json` 的 `updated` 字段只写不读，没有"冲突时选新"的逻辑。

> 本文上一版列出的三项偏差——面板文案写死"12 个槽位"、批量/填充绕过互斥校验、撤销的跨盘回拷不校验大小——**均已在当前版本修复**（分别见 `openSetup` 1134 行、`applyBatch` 1481–1490 行 / `fillBtn` 1543–1545 行、`undo` 1019–1025 行）。

**（不确定 / 代码中未体现）**

- NAS 的 WebDAV 是否支持 `Range`、`PROPFIND` 对深层路径的性能、`412` 是否严格符合 RFC —— 全部依赖服务端实现，应用不做探测。
- 未体现任何"服务端能力探测/降级"（例如先试 `MOVE` 缓存结果），每次跨盘都要重新吃一次 `405`/`500` 再降级。
- 未体现上传能力（应用不写 NAS 上的媒体文件，只发配置 `PUT`）。

---

## 9. 与桌面版的关系

两者是**同一交互模型的两次实现**：一个待分类目录 + 若干目标槽位（+ 一个丢弃槽位），一次处理一张，纯人工分类。差异都来自运行环境的约束。

两套实现**在仓库里各占一个目录**：桌面版是 `webapp/`（多文件），手机版是 `mobile/index.html`（单文件），两者**不共享任何代码**，也不需要一起部署。

| 维度 | 桌面版（`webapp/`：`index.html` + `style.css` + `app.js` + `server.js`） | 手机版（`mobile/index.html` 单文件） |
| --- | --- | --- |
| 文件访问 | File System Access API（`showDirectoryPicker` / 拖放句柄） | 同源 WebDAV（`PROPFIND` / `MOVE` / `COPY` / `DELETE`） |
| 是否需要后端 | 需要 `webapp/server.js` 仅为提供 `localhost` 安全上下文 | **不需要**，部署脚本直接把文件 `PUT` 到 NAS |
| 运行条件 | Chrome/Edge + `http://localhost` | 任意现代手机浏览器 + 能访问 NAS 的 WebDAV |
| 配置持久化 | IndexedDB 存 `FileSystemDirectoryHandle`（句柄无法字符串化） | NAS 上的 `snap-config.json`（+ `localStorage` 缓存） |
| 启动行为 | 显示"恢复上次文件夹"横幅，用户点确认才恢复 | 直接用缓存渲染，再以 NAS 配置为准 |
| 槽位数量与快捷键 | 20 个槽位；`0`–`9` 对应前 10 个，`Del` 移入丢弃槽 | 20 个槽位；`1`–`9` 对应前 9 个，**无 `Del` 键** |
| 预览形态 | 三联对比（中主图 + 左右邻图，点击邻图只切换） | 单张主图 + 底部横向胶卷条（📁 + 缩略图） |
| 目录浏览器 | 无（靠系统目录选择器/拖放） | **有**内置浏览器：面包屑、存储池标注、批量勾选、`lastPickDir` 记忆 |
| 批量添加槽位 | 一次拖入多个目录依次填空槽 | **批量勾选子目录** / 用当前目录子目录填充空槽 |
| 槽位排序 | 拖动卡牌互换 + `⇄` 与源互换 | **设置面板里的"调整顺序 / 源与目标互换"两步点选** |
| 删除空目录 | 满条件更宽：可先把剩余内容搬进 `Del` 再删 | 收紧为"一个条目都不能有"，**不做搬运** |
| 目标目录图集 | 有（只读预览） | **无** |
| 飞入动画 | 有（`flyToSlot`） | **无**（改为槽位闪光 + 震动） |
| 面板关闭键 | `Esc` | `Esc`（1586 行起：任何面板打开时都监听 `Esc`，并顺带堵住"面板开着还能按数字键分类"的误操作） |
| 跨盘处理 | 不适用（本机文件系统） | `405` → `COPY` → 校验大小 → `DELETE` 源，并在 UI 上标 ⚠ 跨盘 |
| 撤销 | 多步（`MAX_UNDO = 50`），存内存/IndexedDB | 多步（同样 50），**持久化到 NAS 配置**，撤销后跳回被撤销那张 |

**手机版有而桌面版没有的**：内置目录浏览器（含存储池/跨盘标注与 `lastPickDir`）、配置跨设备漫游、批量勾选子目录、源与目标互换、跨盘复制降级与校验、空目录严格判定、`snap-config.json` 这一"配置即数据"的形态。

**桌面版有而手机版尚未迁移的**：目标目录只读图集、飞入动画、三联对比预览、`Del`/`0` 快捷键、拖放式槽位互换、"先搬运再删目录"的宽松收尾。

---

## 10. 术语表

| 术语 | 含义 | 出处 |
| --- | --- | --- |
| 源 / 待分类目录 | `S.source`，当前正在分流的目录 | §4.2 |
| 槽位（slot） | 底部 20 个目标按钮之一，顺序即 `S.targets` 下标 | `SLOT_N = 20` |
| 丢弃（del） | 一个固定的"垃圾桶目录"，语义上只是一个特殊目标，不占槽位 | `S.del` |
| 挂载点 / 存储池 | `poolOf(path)` = WebDAV 路径的第一段；代码注释记录"每个存储池是一个挂载点，实测跨挂载点 `MOVE` 会 405" | `poolOf`（393 行） |
| 跨盘 | 源与目标不在同一挂载点，需要退化为 `COPY` + 校验 + `DELETE`；UI 用 ⚠ 与 `xdisk` 样式标注 | `renderSlots`（935 行） |
| 胶卷条（film） | 主图下方的横向缩略图条，含子目录入口 | `renderFilm` |
| 图集（grid） | 4 列 × 5 行、每页 20 张的分页网格 | `GRID_PER_PAGE = 20` |
| 撤销记录 | `{backDir, name, from, mode}`，栈上限 `MAX_UNDO = 50` | `undoStack` / `snapshot()` |
| `busy` | 应用内全局互斥标志；`openSource` 的 `force` 参数可越过它 | §4.2 / §7.5 |
