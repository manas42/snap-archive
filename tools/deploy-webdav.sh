#!/usr/bin/env bash
# Snap Archive · 零服务端版（路线 B）部署脚本
#
# 作用：把本地文件 PUT 到极空间 WebDAV 上的目标目录。改前端 = 跑一次这个脚本。
#
# 用法：
#   bash tools/deploy-webdav.sh public/index.html /pool-a/snap-test/index.html
#   bash tools/deploy-webdav.sh public/ /pool-a/snap-app/          # 目录 → 递归上传
#   DAV_ROOT=/pool-a/snap-app bash tools/deploy-webdav.sh public/
#   第二个参数也可以直接粘贴完整 URL（脚本会自动剥掉 http://host:port）
#
# 凭据读 .nas-cred（支持 NAS_USER=xxx 或 username: xxx 两种写法；不 source、不进 argv）。

set -uo pipefail
cd "$(dirname "$0")/.."

NAS_HOST="${NAS_HOST:-192.0.2.10}"
WEBDAV_PORT="${WEBDAV_PORT:-5005}"
CRED_FILE=".nas-cred"

if [[ $# -lt 1 ]]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
SRC="$1"
DEST="${2:-${DAV_ROOT:-}}"

[[ -f "$CRED_FILE" ]] || { echo "❌ 找不到 $CRED_FILE"; exit 1; }
[[ -e "$SRC" ]] || { echo "❌ 本地路径不存在：$SRC"; exit 1; }
[[ -n "$DEST" ]] || { echo "❌ 没给目标路径（第二个参数或 DAV_ROOT）"; exit 1; }

# 容忍直接粘贴完整 URL：把 http(s)://host[:port] 剥掉，只留路径
if [[ "$DEST" =~ ^https?:// ]]; then
  DEST="$(printf '%s' "$DEST" | sed -E 's#^https?://[^/]+##')"
  [[ -n "$DEST" ]] || { echo "❌ 目标 URL 里没有路径部分"; exit 1; }
fi

# ---- 读凭据（安全解析）----
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
  if   [[ "$line" == *=* ]]; then key="${line%%=*}"; val="${line#*=}"
  elif [[ "$line" == *:* ]]; then key="${line%%:*}"; val="${line#*:}"
  else continue; fi
  key="$(echo "$key" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
  if [[ "$val" != \"* && "$val" != \'* ]]; then val="${val%%[[:space:]]#*}"; fi
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"
  case "$key" in
    nas_user|username|user)  NAS_USER="$val" ;;
    nas_pass|password|pass)  NAS_PASS="$val" ;;
    nas_host|host|ip)        NAS_HOST="$val" ;;
    webdav_port|port)        WEBDAV_PORT="$val" ;;
  esac
done < "$CRED_FILE"
: "${NAS_USER:?缺少 NAS_USER}"; : "${NAS_PASS:?缺少 NAS_PASS}"

CURLRC="$(mktemp)"; chmod 600 "$CURLRC"
printf 'user = "%s:%s"\n' "$NAS_USER" "$NAS_PASS" > "$CURLRC"
trap 'rm -f "$CURLRC"' EXIT

BASE="http://${NAS_HOST}:${WEBDAV_PORT}"
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }

upload_one() {           # $1=本地文件  $2=远端完整路径（未编码）
  local f="$1" remote="$2"
  local url="$BASE$(enc "$remote")"
  local code
  code=$(curl -s -K "$CURLRC" -o /dev/null -w '%{http_code}' -T "$f" --max-time 120 "$url")
  if [[ "$code" =~ ^2 ]]; then
    printf '  \033[32m✅\033[0m %-58s → %s\n' "$remote" "$code"
  else
    printf '  \033[31m❌\033[0m %-58s → %s\n' "$remote" "$code"
    return 1
  fi
}

DEST="${DEST%/}"
fail=0
FINAL_PATH=""
if [[ -f "$SRC" ]]; then
  # 第二参数以 / 结尾（或未给）→ 视为目录，沿用本地文件名；否则视为完整远端文件路径
  if [[ "${2:-}" == */ || -z "${2:-}" ]]; then
    FINAL_PATH="$DEST/$(basename "$SRC")"
  else
    FINAL_PATH="$DEST"
  fi
  upload_one "$SRC" "$FINAL_PATH" || fail=1
else
  echo "· 递归上传目录 $SRC → $DEST/"
  FINAL_PATH="$DEST/"
  while IFS= read -r -d '' f; do
    rel="${f#$SRC/}"
    dir="$(dirname "$rel")"
    if [[ "$dir" != "." ]]; then
      dcode=$(curl -s -K "$CURLRC" -o /dev/null -w '%{http_code}' -X MKCOL --max-time 30 "$BASE$(enc "$DEST/$dir")")
      [[ "$dcode" =~ ^2 || "$dcode" == "405" ]] || { printf '  \033[31m❌\033[0m 建目录 %s → %s\n' "$DEST/$dir" "$dcode"; fail=1; }
    fi
    upload_one "$f" "$DEST/$rel" || fail=1
  done < <(find "$SRC" -type f -print0)
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "✅ 部署完成。手机打开（必须是完整文件地址；目录地址只会显示 WebDAV 的文件列表）："
  echo "   $BASE$(enc "$FINAL_PATH")"
else
  echo "⚠️ 有文件上传失败，请检查上面的输出。" >&2
  exit 1
fi
