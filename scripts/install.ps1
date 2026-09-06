# apexnova-connect source installer (Windows PowerShell)
#
# One-liner:
#   irm https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.ps1 | iex
#
# Pin a release tag:
#   $env:APEXNOVA_REF='v0.1.0'; irm https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.ps1 | iex
#
# Env overrides:
#   APEXNOVA_REF    git ref to install            (default: main)
#   APEXNOVA_HOME   source install dir            (default: ~/.apexnova-connect)
#   APEXNOVA_BIN    bin dir for `apexnova`         (default: ~/.local/bin)
#   NODE_MAJOR      Node major version            (default: 24)
#   PNPM_VERSION    pnpm version                  (default: 9.15.9)

$ErrorActionPreference = 'Stop'

$Repo        = 'Jason869905/Apexnova-connect'
$Ref         = if ($env:APEXNOVA_REF)  { $env:APEXNOVA_REF }  else { 'main' }
$InstallDir  = if ($env:APEXNOVA_HOME) { $env:APEXNOVA_HOME } else { Join-Path $HOME '.apexnova-connect' }
$BinDir      = if ($env:APEXNOVA_BIN)  { $env:APEXNOVA_BIN }  else { Join-Path $HOME '.local\bin' }
$NodeMajor   = if ($env:NODE_MAJOR)    { $env:NODE_MAJOR }    else { '24' }
$PnpmVersion = if ($env:PNPM_VERSION)  { $env:PNPM_VERSION }  else { '9.15.9' }

function Info($m) { Write-Host "==>" -ForegroundColor Blue -NoNewline; Write-Host " $m" }
function Ok($m)   { Write-Host "[ok]" -ForegroundColor Green -NoNewline; Write-Host " $m" }
function Warn($m) { Write-Host "[warn]" -ForegroundColor Yellow -NoNewline; Write-Host " $m" }
function Die($m)  { Write-Host "[error] $m" -ForegroundColor Red; throw $m }

try {
  # --------------------------------------------------------------------------
  # 1. Ensure Node $NodeMajor via fnm
  # --------------------------------------------------------------------------
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $cur = (& node -v).TrimStart('v')
    $curMajor = ($cur -split '\.')[0]
    if ([int]$curMajor -ge [int]$NodeMajor) {
      Ok "Node $cur 已满足 (>= $NodeMajor)"
    } else {
      Info "Node $cur 不足 $NodeMajor，通过 fnm 安装..."
      $needFnm = $true
    }
  } else {
    Info "未检测到 Node，通过 fnm 安装 Node $NodeMajor..."
    $needFnm = $true
  }

  if ($needFnm) {
    $FnmDir = Join-Path $HOME '.fnm'
    if (-not (Test-Path $FnmDir)) { New-Item -ItemType Directory -Path $FnmDir | Out-Null }
    $fnmExe = Join-Path $FnmDir 'fnm.exe'
    if (-not (Test-Path $fnmExe)) {
      Info "下载 fnm..."
      $url = 'https://github.com/Schniz/fnm/releases/latest/download/fnm-windows.zip'
      $tmp = [System.IO.Path]::GetTempFileName()
      Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
      Expand-Archive -Path $tmp -DestinationPath $FnmDir -Force
      Remove-Item $tmp
    }
    $env:PATH = "$FnmDir;$env:PATH"
    # set up fnm multishell env, then install + use
    $envOut = & $fnmExe env --shell powershell
    $envOut | ForEach-Object { if ($_ -and $_.Trim()) { Invoke-Expression $_ } }
    & $fnmExe install $NodeMajor | Out-Null
    & $fnmExe use $NodeMajor | Out-Null
    Ok "Node $((& node -v)) via fnm"
  }

  # --------------------------------------------------------------------------
  # 2. Ensure pnpm via corepack
  # --------------------------------------------------------------------------
  Info "启用 pnpm $PnpmVersion (corepack)..."
  & corepack enable | Out-Null
  & corepack prepare "pnpm@$PnpmVersion" --activate | Out-Null
  Ok "pnpm $(& pnpm -v)"

  # --------------------------------------------------------------------------
  # 3. Download source
  # --------------------------------------------------------------------------
  Info "下载 $Repo @ $Ref ..."
  if (Test-Path (Join-Path $InstallDir '.git')) {
    Info "已存在 $InstallDir，拉取更新..."
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "需要 git 但未找到。" }
    & git -C $InstallDir fetch --depth 1 origin $Ref 2>$null
    if ($LASTEXITCODE -ne 0) { Die "git fetch 失败 (ref=$Ref)" }
    & git -C $InstallDir checkout -f $Ref 2>$null
    if ($LASTEXITCODE -ne 0) { Die "git checkout $Ref 失败" }
  } else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "需要 git 但未找到。" }
    & git clone --depth 1 --branch $Ref "https://github.com/$Repo.git" $InstallDir 2>$null
    if ($LASTEXITCODE -ne 0) { Die "git clone 失败 (ref=$Ref)。请确认该 ref 存在。" }
  }
  Ok "源码就绪: $InstallDir"

  # --------------------------------------------------------------------------
  # 4. Install dependencies + build
  # --------------------------------------------------------------------------
  Info "安装依赖 (pnpm install)..."
  Push-Location $InstallDir
  try {
    & pnpm install --frozen-lockfile 2>$null
    if ($LASTEXITCODE -ne 0) {
      Warn "frozen-lockfile 失败，回退到普通 install..."
      & pnpm install
      if ($LASTEXITCODE -ne 0) { Die "pnpm install 失败" }
    }
    Ok "依赖安装完成"

    Info "构建 (pnpm build)..."
    & pnpm build
    if ($LASTEXITCODE -ne 0) { Die "pnpm build 失败" }
    Ok "构建完成"
  } finally { Pop-Location }

  # --------------------------------------------------------------------------
  # 5. Link `apexnova` binary
  # --------------------------------------------------------------------------
  $Entry = Join-Path $InstallDir 'apps\cli\dist\main.js'
  if (-not (Test-Path $Entry)) { Die "未找到 CLI 产物: $Entry" }
  if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }
  $wrapper = Join-Path $BinDir 'apexnova.cmd'
  @"
@echo off
node "$Entry" %*
"@ | Set-Content -Path $wrapper -Encoding ASCII
  Ok "已安装 apexnova -> $wrapper"

  # --------------------------------------------------------------------------
  # 6. PATH hint
  # --------------------------------------------------------------------------
  if ($env:PATH -notlike "*$BinDir*") {
    Write-Host ""
    Write-Host "[提示] 请把 bin 目录加入用户 PATH 以持久化:" -ForegroundColor Yellow
    Write-Host "  [Environment]::SetEnvironmentVariable('PATH', `"$BinDir;`$([Environment]::GetEnvironmentVariable('PATH','User'))`", 'User')"
    Write-Host "然后重开终端。"
  }

  Write-Host ""
  Write-Host "完成！运行 apexnova --help 开始使用。" -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host "安装失败: $_" -ForegroundColor Red
}
