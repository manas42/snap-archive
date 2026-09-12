# `tests/` · Snap Archive 手机版测试用例集使用说明

这个目录只有两份文档，**不含任何可执行测试代码**：

| 文件 | 内容 |
| --- | --- |
| `TEST-CASES.md` | 从 `public/index.html` 反推出来的 **122 条手工测试用例**（按模块分组，含步骤与可观察预期） |
| `README.md`（本文件） | 怎么准备环境、怎么执行、怎么收尾、以及想做自动化时的思路 |

被测对象只有 **`public/index.html`**（手机版，单文件零依赖，通过同源 WebDAV 直接操作 NAS 文件）。
仓库根目录的 `index.html` / `app.js` / `server.js` 是**桌面版**，不在本测试集范围内。

---

## 1. 这份用例怎么用

- **纯手工执行**：用例里的「步骤」是给人（或给手机）做的操作，「预期结果」分「用户可见现象」和「WebDAV 侧可验证状态」两部分——后者可以用文件管理器、NAS 自带界面或 `curl` 直接核对。
- **按阶段执行**：先跑冒烟（`SMK-*`），再跑非破坏性模块，最后跑破坏性与异常用例。`TEST-CASES.md` 第 21 节给了完整顺序。
- **先看第 1 节与第 4 节**：前者记了被测版本（`public/index.html`，1633 行）与**槽位数量文案**的现状（设置面板标题、批量满槽提示、「清空目标」确认框都已跟随 `SLOT_N`，无硬编码残留）；后者是**测试数据准备与清理原则**，破坏性用例之前必读。
- **追溯方式**：用例按**函数名**（`place()` / `undo()` / `applyBatch()` / `keydown` 处理器）与 **DOM id**（`#slotN`、`#gridSheet`、`#undo`、`#browseSheet`）对应代码；行数只用来说明快照，不要依赖行号。
- **标注「（需人工确认）」的条目**：这些依赖具体机型/浏览器/NAS 实现细节，或需要人为制造故障，执行时请把实际观察到的现象记下来，而不是套用文档里的猜测。
- **一次改动一次回归**：改完 `public/index.html` 至少重跑 `TEST-CASES.md` 第 21 节「阶段 D」列出的那几条。

### 建议的执行记录

每条用例记四样东西：结论（通过/失败/跳过/阻塞）、实际现象（截图或录屏）、Network 请求序列（分类/撤销/跨盘用例尤其重要）、以及当时的配置内容（`snap-config.json`）。

---

## 2. 环境准备

### 2.1 NAS 侧

| 要求 | 说明 |
| --- | --- |
| WebDAV 已开启 | 应用只用 `PROPFIND` / `GET` / `MOVE` / `COPY` / `DELETE` / `MKCOL` / `PUT`。 |
| 至少两个存储池 | 跨盘用例（`XDS-*`）必须在**两个不同存储池/挂载点**之间做；只有一个盘时可以跳过并在记录里写明。 |
| 测试目录可写 | 需要能 `MOVE`、`COPY`、`DELETE`、`MKCOL`，以及 `PUT`（写 `snap-config.json`）。 |
| NAS 与手机同一局域网 | 应用的图片/视频是实时从 WebDAV 拉的。 |

### 2.2 准备可丢弃的测试目录

**不要用真实的工作目录做破坏性测试。** 建议在 NAS 上建一组一次性目录（名字随意，下面沿用 `TEST-CASES.md` 里的命名）：

```
/pool-a/snap-test/      ← 应用的部署目录（index.html + 自动生成的 snap-config.json）
/pool-a/to-sort/        ← 「待分类」源目录（也可以叫 photos/，只要全篇一致）
/pool-a/target-a/       ← 目标目录（同盘）
/pool-a/target-b/       ← 目标目录（同盘）
/pool-a/target-c/       ← 目标目录（批量勾选用）
/pool-a/discard/        ← 「丢弃」目录
/pool-b/target-x/       ← 另一块盘上的目标目录（跨盘用例）
```

建目录可以用 NAS 的文件管理器，或直接发 WebDAV 请求（`ACCOUNT` 是占位账号，密码由 `curl` 交互式询问，不会写进任何文件）：

```bash
curl -u ACCOUNT -X MKCOL http://192.0.2.10:5005/pool-a/snap-test/
curl -u ACCOUNT -X MKCOL http://192.0.2.10:5005/pool-a/to-sort/
curl -u ACCOUNT -X MKCOL http://192.0.2.10:5005/pool-a/target-a/
curl -u ACCOUNT -X MKCOL http://192.0.2.10:5005/pool-a/target-b/
curl -u ACCOUNT -X MKCOL http://192.0.2.10:5005/pool-a/discard/
```

需要核对磁盘状态（「WebDAV 侧可验证状态」）时：

```bash
# 列一个目录（含文件大小与修改时间）
curl -u ACCOUNT -X PROPFIND -H 'Depth: 1' http://192.0.2.10:5005/pool-a/to-sort/

# 看配置内容
curl -u ACCOUNT http://192.0.2.10:5005/pool-a/snap-test/snap-config.json

# 备份 / 恢复配置
curl -u ACCOUNT -o snap-config.backup.json http://192.0.2.10:5005/pool-a/snap-test/snap-config.json
curl -u ACCOUNT -T snap-config.backup.json http://192.0.2.10:5005/pool-a/snap-test/snap-config.json
```

### 2.3 部署应用到测试目录

部署脚本是 `tools/deploy-webdav.sh`。它**只做上传（HTTP PUT）**，把本地文件推到 WebDAV 上的目标路径：

```bash
# 单文件 → 完整远端文件路径
bash tools/deploy-webdav.sh public/index.html /pool-a/snap-test/index.html

# 整个 public/ 目录 → 递归上传（脚本会对子目录发 MKCOL）
bash tools/deploy-webdav.sh public/ /pool-a/snap-test/

# 目标根目录用环境变量给（适合反复部署）
DAV_ROOT=/pool-a/snap-test bash tools/deploy-webdav.sh public/
```

脚本的真实用法与限制（读自脚本头部注释与实现，未作推测）：

- **凭据来自仓库根目录的 `.nas-cred`**：支持 `NAS_USER=xxx` 或 `username: xxx` 两种写法，也识别 `NAS_PASS` / `NAS_HOST` / `WEBDAV_PORT`。凭据**不走命令行参数**，脚本里也不写真实地址（注释明确「真实地址不入库」）。
- **必须提供 `NAS_HOST`**（写在 `.nas-cred` 里）；`WEBDAV_PORT` 默认 `5005`。缺 `NAS_HOST` 时脚本会直接报错并给出填写示例。
- **第二个参数（或 `DAV_ROOT`）必须以 `/` 结尾，或指向完整远端文件路径**：以 `/` 结尾 → 视为目录，沿用本地文件名；否则视为**完整远端文件路径**。
- 第二个参数**可以直接粘贴 `http(s)://host:port/...` 的完整 URL**，脚本会自动剥掉 `http(s)://host[:port]` 只留路径。
- **目标目录不会被自动创建**：先把 `/pool-a/snap-test/` 建好，再跑脚本（单文件上传时脚本也不会替你建父目录）。
- 依赖 `curl` 与 `python3`（`python3` 用来做 URL 编码）。
- 若本地路径不存在、`.nas-cred` 缺失、或目标为空，脚本会给出明确报错。
- 执行成功后会打印**可直接在手机打开的完整文件地址**；有文件上传失败时退出码非 0。

第一次部署后记得：改一次前端就**重跑一次这个脚本**（没有构建步骤，也没有 Service Worker 缓存）。

### 2.4 浏览器侧

- 用**完整文件地址**打开，例如 `http://192.0.2.10:5005/pool-a/snap-test/index.html`。
  打开目录地址（`.../snap-test/`）只会看到 WebDAV 自带的文件列表，那一页不是应用。
- 应用**自己没有登录界面**：所有请求都带 `credentials:'same-origin'`，认证依赖浏览器为该 origin 缓存的基本认证（Basic）凭据。
  第一次访问由浏览器原生弹窗输入 `ACCOUNT` 与密码；测 `ERR-01`（401）时需要能清掉这份缓存凭据。
- 建议不要用 `http://ACCOUNT:密码@192.0.2.10:5005/...` 这种带凭据的 URL 打开：代码里配置地址刻意用**绝对 URL** 拼装，注释说明了「页面若从带凭据的 URL 打开，相对 URL 会让 fetch 直接抛错」，这种打开方式也容易把密码留在地址栏/历史里。
- 手机端主力用 Android Chrome/Edge；iOS Safari 能力受限（见 `FS-05`）。桌面浏览器用于 `KBD-*` 与快速回归。

### 2.5 测试数据

需要哪些文件（几张图、几个视频、txt、同秒文件、中文/emoji 目录、超长文件名等）见 `TEST-CASES.md` 第 4.3 节的表。要点：

- 排序相关用例（`FLT-04`/`FLT-05`）依赖**修改时间**：`getlastmodified` 只有秒级精度，跨设备复制会刷新 mtime；需要可预期的顺序时，尽量在 NAS 上直接建文件或使用保留时间戳的方式上传。
- 造「目标已有同名文件」的情形时，注意两份文件**内容要不同**，否则无法验证「没有被覆盖」（应比对大小/哈希）。
- 每个用例开始前对照 `TEST-CASES.md` 第 4.4 节的「干净起点清单」检查一遍。

---

## 3. 测试期间的注意事项

1. **配置是「共享的单份」**
   - 应用把所有设置写在 `snap-config.json`，位置固定为**应用页面所在目录**。同一目录下，所有设备、所有浏览器、清缓存前后都会读到同一份。
   - 配置里除了源/20 个目标/丢弃/筛选/排序/开关，还包含**撤销栈（最多 50 条）**。也就是说：移动文件、切换筛选、切排序、改开关，都会在 500ms 防抖后 `PUT` 覆盖这份文件。
   - **测试前先备份**（见 2.2 里的 `curl -o`），**测试后原样恢复**；中途需要干净状态时也是「恢复 + 刷新页面」。
   - 好消息是配置**跟着页面目录走**：把应用部署到 `/pool-a/snap-test/`，就等于自带一份独立配置（`/pool-a/snap-test/snap-config.json`），不会污染日常在用的那个部署目录。这是最省事的隔离方式。
2. **删除类用例只在临时目录里做**
   - `DEL-*` 会真的 `DELETE` 掉一个目录，`MOV-*`/`UND-*`/`XDS-*` 会真的移动 NAS 上的文件。
   - 执行前确认「源目录 / 目标目录 / 丢弃目录」全部是**一次性测试目录**；用完就整个删掉，不要留在 NAS 上。
3. **`XDS-*` 会留下副本**
   - 跨盘用例走的是 `COPY` → 校验 → `DELETE`；校验失败或删源失败时会**故意保留双方文件**（这是设计上的安全兜底）。跑完记得手工清理重复文件。
4. **`ERR-*` 需要人为制造故障**
   - 断网、改错凭据、从外部删目录/删文件、把目录设为只读等。建议放在最后执行，并准备好恢复步骤（尤其是凭据和权限）。
5. **改回默认开关**
   - 「视频自动播放」默认 `开`、「自动全屏」默认 `关`；`FS-*`/`VID-*` 之后记得改回，否则会影响后续用例的预期。
6. **测试后清理**
   - 完整步骤见 `TEST-CASES.md` 第 22 节：先关标签页 → 恢复/删除配置 → 清 `localStorage` → 回收测试文件 → 删一次性目录 → 删测试部署 → 复核真实工作目录没被动过。
   - 最后 `git status` 应该只看到 `tests/` 目录下的新增文档；凭据文件（`.nas-cred`）等本来就在 `.gitignore` 里。

---

## 4. 想做自动化时的思路（仅描述，不含实现）

手工跑 122 条太累，其中大部分（DOM 状态、文案、请求序列）是可以自动化的。仓库里既有的探针手法是
「**无头 Chromium + CDP**」，建议沿用同一套思路：

1. **启动浏览器并开调试端口**

   ```bash
   chromium --headless=new --remote-debugging-port=9222 --no-first-run \
            --user-data-dir=/tmp/snap-test-profile about:blank
   ```

2. **拿到页面目标并建立 CDP 连接**
   - `GET http://127.0.0.1:9222/json` 列出 target，取 `webSocketDebuggerUrl`，用 WebSocket 发 CDP 命令（Node 里手写 JSON-RPC 即可，不必引第三方库）。

3. **注入 Basic 认证**（关键的一步，避免把密码写进 URL）
   - `Network.enable` 之后用 `Network.setExtraHTTPHeaders` 给该 origin 的所有请求加上
     `Authorization: Basic <base64(ACCOUNT:密码)>`。这样页面里的 `fetch(..., {credentials:'same-origin'})`
     也能带上凭据，与「浏览器已缓存凭据」的真实场景等价。
   - 密码从环境变量或本地未入库文件读取，**不要写进仓库或 CI 日志**。
   - 若目标端需要显式挑战流程，也可以配合 `Fetch.enable` + `Fetch.continueWithAuth`（`AuthChallengeResponse`）来应答 401。

4. **导航与断言**
   - `Page.navigate` 到 `http://192.0.2.10:5005/pool-a/snap-test/index.html`，等 `Page.loadEventFired`。
   - 用 `Runtime.evaluate` 直接读界面状态做断言，例如：
     - `document.getElementById('srcPath').textContent` → 验证「（仅浏览，非待分类目录）」后缀
     - `document.getElementById('badge').textContent` → 验证 `第 N / M 张`、`剩余 X`
     - `document.getElementById('undo').innerHTML` → 验证撤销栈上标数字
     - `document.querySelectorAll('#slots .slot')[i].className` / `.c` 文本 → 验证空槽、`⚠ 跨盘`、计数
     - `document.getElementById('toast').className` 与 `textContent` → 验证 toast 类型（`ok`/`warn`/`err`）与文案
     - `document.getElementById('gridPage').textContent`、`#gridPrev.disabled` → 验证图集分页边界
   - 需要「点击」时用 `Runtime.evaluate` 调 `el.click()`，或 `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent`（`KBD-*` 用例必须走真实输入事件）。
   - 需要截图留证时用 `Page.captureScreenshot`。

5. **处理原生弹窗**
   - `DELETE`/清空类操作会弹 `confirm()`：监听 `Page.javascriptDialogOpening`，再用 `Page.handleJavaScriptDialog`
     选择 `accept: true/false`，正好覆盖「二次确认取消」这类用例。

6. **核对 WebDAV 侧状态**
   - 自动化脚本在用例前后各发一次 `PROPFIND -H 'Depth: 1'`（`curl` 或直接 `fetch`），比对文件集合与大小；
     准备/清理测试数据也用 `MKCOL` / `PUT` / `MOVE` / `DELETE` 完成。
   - 建议把「页面目录 / 源目录 / 目标目录 / 丢弃目录」做成脚本参数，并且**每次运行都用全新的可丢弃目录**，这样即使中途失败也不会污染别处。

7. **前置与顺序**
   - 每个自动化用例前恢复一份已知的 `snap-config.json`（或用干净的测试部署目录），否则用例之间会通过共享配置互相影响（见第 3 节第 1 条）。
   - 破坏性用例集中放在最后；跨盘用例在只有单个存储池的环境里直接标记为跳过。

> 以上只是思路说明，本仓库目前**没有**测试代码、也没有 CI 配置；如果要做，建议先自动化冒烟（`SMK-01`~`SMK-03`）与阶段 D 回归清单，再逐步扩展到全量。

---

## 5. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 打开地址看到的是一串文件列表 | 打开的是**目录地址**；请用完整文件地址（部署脚本会打印它）。 |
| 页面一直提示认证失败 | 浏览器没有该 origin 的有效凭据，或密码错了；重新登录后**刷新页面**（提示语就是这么说的）。 |
| 改了 `public/index.html` 但手机上看不到变化 | 没有重新部署；跑一次 `tools/deploy-webdav.sh`，然后在手机上强刷。 |
| 设置莫名其妙变了 | `snap-config.json` 是共享的单份配置，别的设备/标签页写入过；按第 3 节备份恢复。 |
| 跨盘用例做不了 | 环境只有一个存储池；在记录里标为「跳过（无第二存储池）」，不要在同盘硬凑。 |
| 「删除这个空文件夹」按钮一直不出现 | 目录里还有**任何**条目（含子目录、`txt`、隐藏文件）都不会出现；用 `PROPFIND` 复核磁盘真实状态。 |
| 撤销按钮点不动 | 撤销栈为空（无上标数字即置灰）。撤销栈会随配置持久化，刷新后应仍在；注意「全部清空」也会清掉撤销栈（`SLT-10`）。 |
| 面板里按键盘没反应 / 手机上关不掉面板 | 三种抽屉（图集、设置、目录浏览器）打开时**所有**快捷键都被屏蔽（包括 `Ctrl/Cmd+Z` 与 `1-9`），这是刻意的安全设计；带键盘的设备按 `Esc` 关闭（目录浏览器若是从设置面板打开的，`Esc` 会退回设置面板），手机上点右上角 `✕` 或标题栏的 `取消`。 |
| 图集开着时误按了数字键 | 该问题已修复：图集打开期间数字键不再触发分类（`KBD-06` 是回归用例）。若仍能移走文件，说明部署的不是当前版本。 |
