#!/usr/bin/env bash
# apexnova-connect installer (Linux / macOS)
#
# Downloads the prebuilt single-file CLI from a GitHub release. No git clone, no
# package manager, no build step.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.sh | bash
#
# Pin a release:
#   APEXNOVA_VERSION=v0.1.1 curl -fsSL .../scripts/install.sh | bash
#
# Env overrides:
#   APEXNOVA_VERSION    release tag, or "latest"     (default: latest)
#   APEXNOVA_HOME       install dir                  (default: ~/.apexnova-connect)
#   APEXNOVA_BIN        bin dir for `apexnova`       (default: ~/.local/bin)
#   APEXNOVA_ASSET_URL  full URL to apexnova.mjs     (default: derived from version)
#   NODE_MAJOR          minimum Node major version   (default: 20)
set -euo pipefail

REPO="Jason869905/Apexnova-connect"
VERSION="${APEXNOVA_VERSION:-latest}"
INSTALL_DIR="${APEXNOVA_HOME:-$HOME/.apexnova-connect}"
BIN_DIR="${APEXNOVA_BIN:-$HOME/.local/bin}"
NODE_MAJOR="${NODE_MAJOR:-20}"
FNM_DIR="${FNM_DIR:-$HOME/.fnm}"

if [ -t 1 ]; then
  C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_RED=$'\033[1;31m'; C_YELLOW=$'\033[1;33m'; C_RESET=$'\033[0m'
else
  C_BLUE=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_RESET=''
fi
info() { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s[error]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "需要 curl 但未找到，请先安装。"

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ----------------------------------------------------------------------------
# 1. Locate a Node runtime, installing one via fnm only if necessary.
#
# NODE_BIN must be an absolute path that survives this script: the wrapper we
# write in step 4 runs in the user's future shells, where an fnm multishell PATH
# entry no longer exists.
# ----------------------------------------------------------------------------
NODE_BIN=""

resolve_node_path() {
  local candidate resolved
  candidate="$(command -v node 2>/dev/null || true)"
  [ -n "$candidate" ] || return 1
  resolved="$(readlink -f "$candidate" 2>/dev/null || true)"
  [ -n "$resolved" ] && candidate="$resolved"
  printf '%s' "$candidate"
}

fnm_node_path() {
  local match
  match="$(ls -d "$FNM_DIR"/node-versions/v"$NODE_MAJOR".*/installation/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
  [ -n "$match" ] && [ -x "$match" ] && printf '%s' "$match"
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local cur cur_major
    cur="$(node -v | tr -d 'v')"
    cur_major="${cur%%.*}"
    if [ "${cur_major:-0}" -ge "$NODE_MAJOR" ]; then
      NODE_BIN="$(resolve_node_path)" || die "无法解析 node 的绝对路径。"
      ok "Node $cur ($NODE_BIN)"
      return 0
    fi
    info "Node $cur 低于所需的 $NODE_MAJOR，通过 fnm 安装..."
  else
    info "未检测到 Node，通过 fnm 安装 Node $NODE_MAJOR..."
  fi

  mkdir -p "$FNM_DIR"
  if [ ! -x "$FNM_DIR/fnm" ]; then
    info "下载 fnm..."
    local os arch asset_arch url
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch="$(uname -m)"
    case "$arch" in
      x86_64|amd64) asset_arch="x64" ;;
      aarch64|arm64) asset_arch="arm64" ;;
      *) die "不支持的 CPU 架构: $arch" ;;
    esac
    if [ "$os" = "darwin" ]; then
      if [ "$asset_arch" = "arm64" ]; then url="https://github.com/Schniz/fnm/releases/latest/download/fnm-arm64-macos.zip"
      else url="https://github.com/Schniz/fnm/releases/latest/download/fnm-macos.zip"; fi
    else
      if [ "$asset_arch" = "arm64" ]; then url="https://github.com/Schniz/fnm/releases/latest/download/fnm-linux-arm64.zip"
      else url="https://github.com/Schniz/fnm/releases/latest/download/fnm-linux.zip"; fi
    fi
    curl -fsSL "$url" -o "$TMP_DIR/fnm.zip" || die "下载 fnm 失败: $url"
    if command -v unzip >/dev/null 2>&1; then
      unzip -o "$TMP_DIR/fnm.zip" -d "$FNM_DIR" >/dev/null
    elif command -v python3 >/dev/null 2>&1; then
      python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP_DIR/fnm.zip" "$FNM_DIR"
    else
      die "需要 unzip 或 python3 来解压 fnm，但都未找到。"
    fi
    chmod +x "$FNM_DIR/fnm" 2>/dev/null || true
  fi

  export FNM_DIR
  export PATH="$FNM_DIR:$PATH"
  eval "$("$FNM_DIR/fnm" env --shell bash)" || die "fnm env 初始化失败"
  "$FNM_DIR/fnm" install "$NODE_MAJOR" >/dev/null 2>&1 || die "fnm 安装 Node $NODE_MAJOR 失败"
  "$FNM_DIR/fnm" use "$NODE_MAJOR" >/dev/null 2>&1 || die "fnm 切换 Node $NODE_MAJOR 失败"

  # Prefer the version directory over the ephemeral multishell symlink.
  NODE_BIN="$(fnm_node_path || true)"
  [ -n "$NODE_BIN" ] || NODE_BIN="$(resolve_node_path)" || die "fnm 安装后仍无法定位 node。"
  ok "Node $("$NODE_BIN" -v) via fnm ($NODE_BIN)"
}
ensure_node

# ----------------------------------------------------------------------------
# 2. Download the release artifact and verify its checksum.
# ----------------------------------------------------------------------------
if [ -n "${APEXNOVA_ASSET_URL:-}" ]; then
  ASSET_URL="$APEXNOVA_ASSET_URL"
elif [ "$VERSION" = "latest" ]; then
  ASSET_URL="https://github.com/$REPO/releases/latest/download/apexnova.mjs"
else
  ASSET_URL="https://github.com/$REPO/releases/download/$VERSION/apexnova.mjs"
fi

info "下载 apexnova ($VERSION)..."
curl -fsSL "$ASSET_URL" -o "$TMP_DIR/apexnova.mjs" \
  || die "下载失败: $ASSET_URL（请确认该 release 存在且已附带 apexnova.mjs）"
[ -s "$TMP_DIR/apexnova.mjs" ] || die "下载到的文件为空: $ASSET_URL"

if curl -fsSL "$ASSET_URL.sha256" -o "$TMP_DIR/apexnova.mjs.sha256" 2>/dev/null; then
  expected="$(awk '{print $1}' "$TMP_DIR/apexnova.mjs.sha256" | head -n 1)"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$TMP_DIR/apexnova.mjs" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$TMP_DIR/apexnova.mjs" | awk '{print $1}')"
  else
    actual=""
    warn "未找到 sha256sum/shasum，跳过校验。"
  fi
  if [ -n "$actual" ]; then
    [ "$actual" = "$expected" ] || die "校验失败：期望 $expected，实际 $actual。"
    ok "sha256 校验通过"
  fi
else
  warn "未找到 $ASSET_URL.sha256，跳过校验。"
fi

# ----------------------------------------------------------------------------
# 3. Install the artifact.
# ----------------------------------------------------------------------------
ENTRY="$INSTALL_DIR/apexnova.mjs"
mkdir -p "$INSTALL_DIR"
install -m 0644 "$TMP_DIR/apexnova.mjs" "$ENTRY" 2>/dev/null \
  || { cp "$TMP_DIR/apexnova.mjs" "$ENTRY" && chmod 0644 "$ENTRY"; }
ok "已安装 $ENTRY"

# ----------------------------------------------------------------------------
# 4. Write the launcher.
# ----------------------------------------------------------------------------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/apexnova" <<EOF
#!/usr/bin/env bash
# Generated by the apexnova-connect installer. Do not edit.
APEXNOVA_NODE="\${APEXNOVA_NODE:-$NODE_BIN}"
if [ ! -x "\$APEXNOVA_NODE" ]; then
  APEXNOVA_NODE="\$(command -v node 2>/dev/null || true)"
fi
if [ -z "\$APEXNOVA_NODE" ]; then
  echo "apexnova: 未找到 Node.js（>= $NODE_MAJOR）。设置 APEXNOVA_NODE 指向 node 可执行文件后重试。" >&2
  exit 1
fi
exec "\$APEXNOVA_NODE" "$ENTRY" "\$@"
EOF
chmod +x "$BIN_DIR/apexnova"
ok "已安装 apexnova -> $BIN_DIR/apexnova"

installed_version="$("$BIN_DIR/apexnova" --version 2>/dev/null || true)"
[ -n "$installed_version" ] || die "安装后自检失败：$BIN_DIR/apexnova --version 没有输出。"
ok "$installed_version"

# ----------------------------------------------------------------------------
# 5. PATH hint.
# ----------------------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\n%s[提示]%s 请把 bin 目录加入 PATH（写入 shell 配置以持久化）:\n' "$C_YELLOW" "$C_RESET"
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

printf '\n%s完成！%s 运行 %sapexnova login%s 登录，然后 %sapexnova opencode%s 开始使用。\n' \
  "$C_GREEN" "$C_RESET" "$C_BLUE" "$C_RESET" "$C_BLUE" "$C_RESET"
