#!/usr/bin/env bash
# Snap Archive 改造 · NAS 能力实测脚本（M0 假设验证 · V2）
#
# 用法：
#   1) 在工作区根目录创建 .nas-cred（已被 .gitignore 忽略），内容形如：
#        NAS_USER=你的账号
#        NAS_PASS=你的密码
#      可选：NAS_HOST / WEBDAV_PORT / DAV_ROOT / PROBE_DIR / SMB_SHARE
#   2) bash tools/nas-probe.sh
#
# 行为：只读探测 + 在一个临时目录里做 写入/建目录/移动/删除 的往返测试，结束自动清理。
#      **不会碰你的任何图片。**
#
# 设计要点（都是吃过亏的地方）：
#   · curl 在 HTTP 401/404/500 时退出码仍可能是 0 → 一律显式比对状态码，绝不看退出码
#   · 不用 HEAD 判 Content-Type（WebDAV 常不支持 HEAD）→ 看 GET 的响应头
#   · MOVE 的 Destination 必须是绝对 URI，并带 Overwrite 头，移动后还要校验源/目标
#   · 凭据不写进命令行（否则 `ps` 里可见）→ 用 0600 的 curl 配置文件 + smbclient 认证文件
#   · MKCOL 在共享根目录可能被拒 → 可用 PROBE_DIR 指定一个你自己确认可写的目录

set -uo pipefail
cd "$(dirname "$0")/.."

NAS_HOST="${NAS_HOST:-192.0.2.10}"
WEBDAV_PORT="${WEBDAV_PORT:-5005}"
DAV_ROOT="${DAV_ROOT:-}"          # WebDAV 根下的路径前缀；极空间惯例是 /<挂载点名称>
PROBE_DIR="${PROBE_DIR:-}"        # 可选：一个你确认可写的目录（相对挂载点），临时文件放这里
SMB_SHARE="${SMB_SHARE:-}"
CRED_FILE=".nas-cred"

if [[ ! -f "$CRED_FILE" ]]; then
  cat <<'EOF'
❌ 找不到 .nas-cred。请在工作区根目录创建它，两种写法都支持：

     NAS_USER=你的极空间账号          # 或   username: 你的账号
     NAS_PASS=你的密码                # 或   password: 你的密码

   可选的补充信息（强烈建议给，能少跑一趟）：
     DAV_ROOT=/你的挂载点名称
     PROBE_DIR=/你的挂载点名称/某个可写子目录
     SMB_SHARE=你的共享名

（该文件已在 .gitignore 中，不会被提交。）
EOF
  exit 1
fi

# ---------- 读取凭据（安全解析，不 source 用户文件） ----------
# 两种写法、键名大小写与别名都兼容：
#   NAS_USER=xxx    或    username: xxx    或    user: xxx
#   NAS_PASS=yyy    或    password: yyy    或    pass: yyy
# 另可给 NAS_HOST / WEBDAV_PORT / DAV_ROOT / PROBE_DIR / SMB_SHARE
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  if   [[ "$line" == *=* ]]; then key="${line%%=*}"; val="${line#*=}"
  elif [[ "$line" == *:* ]]; then key="${line%%:*}"; val="${line#*:}"
  else echo "⚠️  .nas-cred 有无法解析的行，已跳过"; continue
  fi
  key="$(echo "$key" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
  # 行尾注释：仅当值未加引号时剥离 " #..."（密码里若真有 " #" 请用引号包起来）
  if [[ "$val" != \"* && "$val" != \'* ]]; then val="${val%%[[:space:]]#*}"; fi
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"   # 去首尾空白
  case "$key" in
    nas_user|username|user)  NAS_USER="$val" ;;
    nas_pass|password|pass)  NAS_PASS="$val" ;;
    nas_host|host|ip|server) NAS_HOST="$val" ;;
    webdav_port|port)        WEBDAV_PORT="$val" ;;
    dav_root|root|path|dav)  DAV_ROOT="$val" ;;
    probe_dir|probe)         PROBE_DIR="$val" ;;
    smb_share|share)         SMB_SHARE="$val" ;;
    *) echo "⚠️  .nas-cred 里无法识别的键，已忽略：$key" ;;
  esac
done < "$CRED_FILE"

: "${NAS_USER:?缺少 NAS_USER}"; : "${NAS_PASS:?缺少 NAS_PASS}"

# ---------- 凭据不外泄到 ps ----------
CURLRC="$(mktemp)"; SMBRC="$(mktemp)"
chmod 600 "$CURLRC" "$SMBRC"
printf 'user = "%s:%s"\n' "$NAS_USER" "$NAS_PASS" > "$CURLRC"
printf 'username = %s\npassword = %s\n' "$NAS_USER" "$NAS_PASS" > "$SMBRC"
cleanup() { rm -f "$CURLRC" "$SMBRC" /tmp/__snap_a.txt /tmp/__snap_probe.html /tmp/__snap_options.txt; }
trap cleanup EXIT

BASE="http://${NAS_HOST}:${WEBDAV_PORT}${DAV_ROOT}"

ok()   { printf '  \033[32m✅ %s\033[0m\n' "$1"; }
no()   { printf '  \033[31m❌ %s\033[0m\n' "$1"; }
warn() { printf '  \033[33m⚠️  %s\033[0m\n' "$1"; }
info() { printf '  \033[36m·  %s\033[0m\n' "$1"; }
hr()   { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# HTTP 状态码（000=连不上）；绝不依赖 curl 退出码
code() {
  local method="$1" url="$2"; shift 2
  curl -s -K "$CURLRC" -o /dev/null -w '%{http_code}' -X "$method" --max-time 15 "$@" "$url" 2>/dev/null
}
status() {
  local desc="$1" c="$2"
  if [[ -z "$c" || "$c" == "000" ]]; then no "$desc → 连接失败"; return 1; fi
  if [[ "$c" =~ ^2 ]]; then ok "$desc → HTTP $c"; return 0; fi
  if [[ "$c" == "401" ]]; then no "$desc → HTTP 401（账号或密码不对）"; return 1; fi
  warn "$desc → HTTP $c"
  return 1
}

hr "0. 连通性与认证"
C=$(code PROPFIND "$BASE/" -H "Depth: 0")
[[ -z "$C" || "$C" == "000" ]] && { no "连不上 $BASE（检查 IP / 端口 / 防火墙 / DAV_ROOT）"; exit 1; }
[[ "$C" == "401" ]] && { no "认证失败：检查 .nas-cred 里的账号密码"; exit 1; }
ok "可认证访问 $BASE（HTTP $C）"

hr "1. DAV 能力（OPTIONS）"
OPTFILE="/tmp/__snap_options.txt"
curl -s -i -K "$CURLRC" -X OPTIONS --max-time 15 "$BASE/" > "$OPTFILE" 2>&1   # 只请求一次，下面复用
sed -n '1,25p' "$OPTFILE" | sed 's/^/  /'
echo
if grep -qi '^DAV:' "$OPTFILE"; then ok "$(grep -i '^DAV:' "$OPTFILE" | head -1)"; else warn "没有 DAV: 头"; fi
ALLOW=$(grep -i '^Allow:' "$OPTFILE" | head -1 || true)
if [[ -n "$ALLOW" ]]; then
  info "$ALLOW"
  for m in PROPFIND MOVE PUT DELETE MKCOL COPY; do
    if echo "$ALLOW" | grep -qi "$m"; then ok "Allow 含 $m"; else warn "Allow 未列出 $m（仍需逐方法实测）"; fi
  done
else
  info "没有 Allow 头 → 以逐方法实测为准"
fi

hr "2. 列目录（PROPFIND Depth:1）"
C=$(code PROPFIND "$BASE/" -H "Depth: 1")
if [[ "$C" == "207" ]]; then
  ok "PROPFIND 可用（207 Multi-Status）"
  curl -s -K "$CURLRC" -X PROPFIND -H "Depth: 1" --max-time 20 "$BASE/" 2>/dev/null \
    | grep -oE '<[A-Za-z]*:?href>[^<]*</[A-Za-z]*:?href>' | sed 's/<[^>]*>//g' | head -20 | sed 's/^/     /'
  echo "     ...（以上为根目录前 20 条）"
else
  no "PROPFIND 返回 $C —— 若为 404 多半是 DAV_ROOT 写错了（惯例：/<挂载点名称>）"
fi

hr "3. 读写/移动/删除 往返（分类操作的核心）"
if [[ -n "$PROBE_DIR" ]]; then
  T="${BASE%/}${PROBE_DIR}"
  if [[ "$PROBE_DIR" != /* ]]; then T="${BASE%/}/${PROBE_DIR}"; fi
  info "使用 PROBE_DIR=$PROBE_DIR → $T"
  C=$(code PROPFIND "$T" -H "Depth: 0"); status "PROBE_DIR 是否存在" "$C"
else
  T="${BASE%/}/__snap_probe__"
  C=$(code MKCOL "$T")
  if ! [[ "$C" =~ ^2 ]]; then
    warn "在共享根目录下建临时目录失败（HTTP $C）——很可能是根只读"
    warn "请在 .nas-cred 里设置 PROBE_DIR=/你的挂载点/一个可写子目录，然后重跑"
    T=""
  else
    ok "MKCOL 建临时目录 → HTTP $C"
  fi
fi

if [[ -n "$T" ]]; then
  echo hello > /tmp/__snap_a.txt
  C=$(code PUT "$T/a.txt" -T /tmp/__snap_a.txt); status "PUT 上传 a.txt" "$C"
  C=$(code MKCOL "$T/sub"); status "MKCOL 建子目录 sub" "$C"
  # MOVE：Destination 必须是绝对 URI，带 Overwrite 头
  C=$(code MOVE "$T/a.txt" -H "Destination: ${T}/sub/a.txt" -H "Overwrite: F")
  if [[ "$C" =~ ^2 ]]; then ok "MOVE a.txt → sub/a.txt（HTTP $C）← **分类操作可行**"; else no "MOVE 失败（HTTP $C）← 路线 B 的核心动作不可用"; fi
  C=$(code GET "$T/sub/a.txt"); status "移动后目标存在（校验 MOVE 真的生效）" "$C"
  C=$(code GET "$T/a.txt")
  if [[ "$C" == "404" ]]; then ok "移动后源已不存在（是真的移动，不是复制）"; else warn "移动后源返回 HTTP $C（语义可疑）"; fi
  C=$(code DELETE "$T/sub/a.txt"); status "DELETE 文件" "$C"
  C=$(code DELETE "$T/sub");        status "DELETE 空目录" "$C"
  C=$(code DELETE "$T");            status "DELETE 临时目录（清理）" "$C"
fi

hr "4. HTML 能否被当网页托管（路线 B 的前提）"
printf '<!doctype html><title>probe</title>ok\n' > /tmp/__snap_probe.html
C=$(code PUT "$BASE/__snap_probe.html" -T /tmp/__snap_probe.html); status "PUT __snap_probe.html" "$C"
# 用 GET 的响应头判 Content-Type（HEAD 在 WebDAV 上常不可用）
CT=$(curl -s -D - -o /dev/null -K "$CURLRC" --max-time 15 "$BASE/__snap_probe.html" 2>/dev/null | grep -i '^content-type' || true)
if [[ -n "$CT" ]]; then
  info "GET 的 $CT"
  if echo "$CT" | grep -qi 'text/html'; then ok "以 text/html 返回 → 路线 B（同源单页）可行"; else no "不是 text/html → 浏览器会下载而非渲染，路线 B 出局"; fi
else
  warn "连 GET 都没给 Content-Type → 无法判定路线 B"
fi
C=$(code DELETE "$BASE/__snap_probe.html"); status "清理 __snap_probe.html" "$C"

hr "5. SMB 侧（可选）"
if command -v smbclient >/dev/null 2>&1; then
  info "共享列表："
  smbclient -L "//${NAS_HOST}" -A "$SMBRC" 2>&1 | head -25 | sed 's/^/     /'
  if [[ -n "$SMB_SHARE" ]]; then
    echo "  --- 共享 $SMB_SHARE 顶层 ---"
    smbclient "//${NAS_HOST}/${SMB_SHARE}" -A "$SMBRC" -c 'ls' 2>&1 | head -25 | sed 's/^/     /'
  else
    info "未设置 SMB_SHARE，跳过目录列举"
  fi
else
  warn "本机没有 smbclient，跳过。装法：sudo apt install smbclient；或用 Windows 资源管理器看共享结构"
fi

hr "完成"
cat <<'EOF'
  把以上输出回传即可。
  最关键两项：③「MOVE 是否 2xx 且源已消失」、④「Content-Type 是否 text/html」。
EOF
