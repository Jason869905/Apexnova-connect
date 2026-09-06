#!/usr/bin/env bash
# apexnova-connect source installer (Linux / macOS)
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.sh | bash
#
# Pin a release tag:
#   APEXNOVA_REF=v0.1.0 curl -fsSL https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.sh | bash
#
# Env overrides:
#   APEXNOVA_REF    git ref to install            (default: main)
#   APEXNOVA_HOME   source install dir            (default: ~/.apexnova-connect)
#   APEXNOVA_BIN    bin dir for `apexnova`         (default: ~/.local/bin)
#   NODE_MAJOR      Node major version            (default: 24)
#   PNPM_VERSION    pnpm version                  (default: 9.15.9)
set -euo pipefail

REPO="Jason869905/Apexnova-connect"
REF="${APEXNOVA_REF:-main}"
INSTALL_DIR="${APEXNOVA_HOME:-$HOME/.apexnova-connect}"
BIN_DIR="${APEXNOVA_BIN:-$HOME/.local/bin}"
NODE_MAJOR="${NODE_MAJOR:-24}"
PNPM_VERSION="${PNPM_VERSION:-9.15.9}"

if [ -t 1 ]; then
  C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_RED=$'\033[1;31m'; C_YELLOW=$'\033[1;33m'; C_RESET=$'\033[0m'
else
  C_BLUE=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_RESET=''
fi
info() { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '%s[error]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "需要 curl 但未找到，请先安装。"
command -v tar >/dev/null 2>&1 || die "需要 tar 但未找到，请先安装。"

# ----------------------------------------------------------------------------
# 1. Ensure Node $NODE_MAJOR via fnm
# ----------------------------------------------------------------------------
ensure_node() {
  if command -v node >/dev/null 2>&1; then
    cur="$(node -v | tr -d 'v')"
    cur_major="${cur%%.*}"
    if [ "${cur_major:-0}" -ge "$NODE_MAJOR" ]; then
      ok "Node $cur 已满足 (>= $NODE_MAJOR)"
      return 0
    fi
    info "Node $cur 不足 $NODE_MAJOR，通过 fnm 安装..."
  else
    info "未检测到 Node，通过 fnm 安装 Node $NODE_MAJOR..."
  fi

  FNM_DIR="$HOME/.fnm"
  mkdir -p "$FNM_DIR"
  if [ ! -x "$FNM_DIR/fnm" ]; then
    info "下载 fnm..."
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch="$(uname -m)"
    case "$arch" in
      x86_64|amd64) asset_arch="x64" ;;
      aarch64|arm64) asset_arch="arm64" ;;
      *) die "不支持的 CPU 架构: $arch" ;;
    esac
    if [ "$os" = "darwin" ]; then
      if [ "$asset_arch" = "arm64" ]; then
        url="https://github.com/Schniz/fnm/releases/latest/download/fnm-arm64-macos.zip"
      else
        url="https://github.com/Schniz/fnm/releases/latest/download/fnm-macos.zip"
      fi
    else
      if [ "$asset_arch" = "arm64" ]; then
        url="https://github.com/Schniz/fnm/releases/latest/download/fnm-linux-arm64.zip"
      else
        url="https://github.com/Schniz/fnm/releases/latest/download/fnm-linux.zip"
      fi
    fi
    tmp="$(mktemp -d)"
    curl -fsSL "$url" -o "$tmp/fnm.zip" || die "下载 fnm 失败: $url"
    if command -v unzip >/dev/null 2>&1; then
      unzip -o "$tmp/fnm.zip" -d "$FNM_DIR" >/dev/null
    elif command -v python3 >/dev/null 2>&1; then
      python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$tmp/fnm.zip" "$FNM_DIR"
    else
      die "需要 unzip 或 python3 来解压 fnm，但都未找到。"
    fi
    chmod +x "$FNM_DIR/fnm" 2>/dev/null || true
    rm -rf "$tmp"
  fi

  export PATH="$FNM_DIR:$PATH"
  eval "$(fnm env --shell bash)" || die "fnm env 初始化失败"
  fnm install "$NODE_MAJOR" >/dev/null 2>&1 || die "fnm 安装 Node $NODE_MAJOR 失败"
  fnm use "$NODE_MAJOR" >/dev/null 2>&1 || die "fnm 切换 Node $NODE_MAJOR 失败"
  ok "Node $(node -v) via fnm"
}
ensure_node

# ----------------------------------------------------------------------------
# 2. Ensure pnpm via corepack
# ----------------------------------------------------------------------------
info "启用 pnpm $PNPM_VERSION (corepack)..."
corepack enable >/dev/null 2>&1 || die "corepack enable 失败"
corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null 2>&1 || die "corepack prepare pnpm 失败"
ok "pnpm $(pnpm -v)"

# ----------------------------------------------------------------------------
# 3. Download source
# ----------------------------------------------------------------------------
info "下载 $REPO @ $REF ..."
if [ -d "$INSTALL_DIR/.git" ]; then
  info "已存在 $INSTALL_DIR，拉取更新..."
  command -v git >/dev/null 2>&1 || die "需要 git 但未找到。"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF" >/dev/null 2>&1 || die "git fetch 失败 (ref=$REF)"
  git -C "$INSTALL_DIR" checkout -f "$REF" >/dev/null 2>&1 || die "git checkout $REF 失败"
else
  command -v git >/dev/null 2>&1 || die "需要 git 但未找到。"
  git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$INSTALL_DIR" >/dev/null 2>&1 \
    || die "git clone 失败 (ref=$REF)。请确认该 ref 存在。"
fi
ok "源码就绪: $INSTALL_DIR"

# ----------------------------------------------------------------------------
# 4. Install dependencies + build
# ----------------------------------------------------------------------------
info "安装依赖 (pnpm install)..."
if ( cd "$INSTALL_DIR" && pnpm install --frozen-lockfile ) >/dev/null 2>&1; then
  :
else
  warn "frozen-lockfile 失败，回退到普通 install..."
  ( cd "$INSTALL_DIR" && pnpm install ) >/dev/null 2>&1 || die "pnpm install 失败"
fi
ok "依赖安装完成"

info "构建 (pnpm build)..."
( cd "$INSTALL_DIR" && pnpm build ) >/dev/null 2>&1 || die "pnpm build 失败"
ok "构建完成"

# ----------------------------------------------------------------------------
# 5. Link `apexnova` binary
# ----------------------------------------------------------------------------
ENTRY="$INSTALL_DIR/apps/cli/dist/main.js"
[ -f "$ENTRY" ] || die "未找到 CLI 产物: $ENTRY"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/apexnova" <<EOF
#!/usr/bin/env bash
exec node "$ENTRY" "\$@"
EOF
chmod +x "$BIN_DIR/apexnova"
ok "已安装 apexnova -> $BIN_DIR/apexnova"

# ----------------------------------------------------------------------------
# 6. PATH hint
# ----------------------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\n%s[提示]%s 请把 bin 目录加入 PATH（写入 shell 配置以持久化）:\n' "$C_YELLOW" "$C_RESET"
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

printf '\n%s完成！%s 运行 %sapexnova --help%s 开始使用。\n' "$C_GREEN" "$C_RESET" "$C_BLUE" "$C_RESET"
