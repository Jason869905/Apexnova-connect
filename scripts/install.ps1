# apexnova-connect installer (Windows PowerShell)
#
# Downloads the prebuilt single-file CLI from a GitHub release. No git clone, no
# package manager, no build step.
#
# One-liner:
#   irm https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.ps1 | iex
#
# Pin a release:
#   $env:APEXNOVA_VERSION='v0.1.1'; irm .../scripts/install.ps1 | iex
#
# Env overrides:
#   APEXNOVA_VERSION    release tag, or "latest"     (default: latest)
#   APEXNOVA_HOME       install dir                  (default: ~/.apexnova-connect)
#   APEXNOVA_BIN        bin dir for `apexnova`       (default: ~/.local/bin)
#   APEXNOVA_ASSET_URL  full URL to apexnova.mjs     (default: derived from version)
#   NODE_MAJOR          minimum Node major version   (default: 20)

$ErrorActionPreference = 'Stop'

$Repo       = 'Jason869905/Apexnova-connect'
$Version    = if ($env:APEXNOVA_VERSION) { $env:APEXNOVA_VERSION } else { 'latest' }
$InstallDir = if ($env:APEXNOVA_HOME)    { $env:APEXNOVA_HOME }    else { Join-Path $HOME '.apexnova-connect' }
$BinDir     = if ($env:APEXNOVA_BIN)     { $env:APEXNOVA_BIN }     else { Join-Path $HOME '.local\bin' }
$NodeMajor  = if ($env:NODE_MAJOR)       { [int]$env:NODE_MAJOR }  else { 20 }
$FnmDir     = if ($env:FNM_DIR)          { $env:FNM_DIR }          else { Join-Path $HOME '.fnm' }

function Info($m) { Write-Host "==>" -ForegroundColor Blue -NoNewline; Write-Host " $m" }
function Ok($m)   { Write-Host "[ok]" -ForegroundColor Green -NoNewline; Write-Host " $m" }
function Warn($m) { Write-Host "[warn]" -ForegroundColor Yellow -NoNewline; Write-Host " $m" }
function Die($m)  { throw $m }

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("apexnova-" + [System.Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

  # --------------------------------------------------------------------------
  # 1. Locate a Node runtime, installing one via fnm only if necessary.
  #
  # $NodeExe must be an absolute path that survives this script: the wrapper we
  # write in step 4 runs in the user's future shells, where an fnm multishell
  # PATH entry no longer exists.
  # --------------------------------------------------------------------------
  $NodeExe = $null
  $needFnm = $false

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $cur = (& node -v).TrimStart('v')
    $curMajor = [int](($cur -split '\.')[0])
    if ($curMajor -ge $NodeMajor) {
      $NodeExe = $nodeCmd.Source
      Ok "Node $cur ($NodeExe)"
    } else {
      Info "Node $cur 低于所需的 $NodeMajor，通过 fnm 安装..."
      $needFnm = $true
    }
  } else {
    Info "未检测到 Node，通过 fnm 安装 Node $NodeMajor..."
    $needFnm = $true
  }

  if ($needFnm) {
    if (-not (Test-Path $FnmDir)) { New-Item -ItemType Directory -Path $FnmDir -Force | Out-Null }
    $fnmExe = Join-Path $FnmDir 'fnm.exe'
    if (-not (Test-Path $fnmExe)) {
      Info "下载 fnm..."
      $zip = Join-Path $TmpDir 'fnm.zip'
      Invoke-WebRequest -Uri 'https://github.com/Schniz/fnm/releases/latest/download/fnm-windows.zip' -OutFile $zip -UseBasicParsing
      Expand-Archive -Path $zip -DestinationPath $FnmDir -Force
    }
    if (-not (Test-Path $fnmExe)) { Die "fnm 解压后未找到 $fnmExe" }

    $env:FNM_DIR = $FnmDir
    $env:PATH = "$FnmDir;$env:PATH"
    & $fnmExe env --shell powershell | ForEach-Object { if ($_ -and $_.Trim()) { Invoke-Expression $_ } }
    & $fnmExe install $NodeMajor | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "fnm 安装 Node $NodeMajor 失败" }
    & $fnmExe use $NodeMajor | Out-Null

    # Prefer the version directory over the ephemeral multishell symlink.
    $candidate = Get-ChildItem -Path (Join-Path $FnmDir 'node-versions') -Filter "v$NodeMajor.*" -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name |
      Select-Object -Last 1
    if ($candidate) {
      $probe = Join-Path $candidate.FullName 'installation\node.exe'
      if (Test-Path $probe) { $NodeExe = $probe }
    }
    if (-not $NodeExe) {
      $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
      if ($nodeCmd) { $NodeExe = $nodeCmd.Source }
    }
    if (-not $NodeExe) { Die "fnm 安装后仍无法定位 node.exe" }
    Ok "Node $(& $NodeExe -v) via fnm ($NodeExe)"
  }

  # --------------------------------------------------------------------------
  # 2. Download the release artifact and verify its checksum.
  # --------------------------------------------------------------------------
  if ($env:APEXNOVA_ASSET_URL) {
    $AssetUrl = $env:APEXNOVA_ASSET_URL
  } elseif ($Version -eq 'latest') {
    $AssetUrl = "https://github.com/$Repo/releases/latest/download/apexnova.mjs"
  } else {
    $AssetUrl = "https://github.com/$Repo/releases/download/$Version/apexnova.mjs"
  }

  Info "下载 apexnova ($Version)..."
  $downloaded = Join-Path $TmpDir 'apexnova.mjs'
  try {
    Invoke-WebRequest -Uri $AssetUrl -OutFile $downloaded -UseBasicParsing
  } catch {
    Die "下载失败: $AssetUrl（请确认该 release 存在且已附带 apexnova.mjs）"
  }
  if ((Get-Item $downloaded).Length -eq 0) { Die "下载到的文件为空: $AssetUrl" }

  $sums = Join-Path $TmpDir 'apexnova.mjs.sha256'
  $haveSums = $true
  try {
    Invoke-WebRequest -Uri "$AssetUrl.sha256" -OutFile $sums -UseBasicParsing
  } catch {
    $haveSums = $false
    Warn "未找到 $AssetUrl.sha256，跳过校验。"
  }
  if ($haveSums) {
    $expected = ((Get-Content $sums -First 1) -split '\s+')[0]
    $actual = (Get-FileHash -Path $downloaded -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected.ToLowerInvariant()) { Die "校验失败：期望 $expected，实际 $actual。" }
    Ok "sha256 校验通过"
  }

  # --------------------------------------------------------------------------
  # 3. Install the artifact.
  # --------------------------------------------------------------------------
  if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
  $Entry = Join-Path $InstallDir 'apexnova.mjs'
  Copy-Item -Path $downloaded -Destination $Entry -Force
  Ok "已安装 $Entry"

  # --------------------------------------------------------------------------
  # 4. Write the launcher.
  # --------------------------------------------------------------------------
  if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }
  $wrapper = Join-Path $BinDir 'apexnova.cmd'
  @"
@echo off
REM Generated by the apexnova-connect installer. Do not edit.
if defined APEXNOVA_NODE (
  "%APEXNOVA_NODE%" "$Entry" %*
) else (
  "$NodeExe" "$Entry" %*
)
exit /b %errorlevel%
"@ | Set-Content -Path $wrapper -Encoding ASCII
  Ok "已安装 apexnova -> $wrapper"

  $installedVersion = & $NodeExe $Entry --version
  if ($LASTEXITCODE -ne 0 -or -not $installedVersion) { Die "安装后自检失败：apexnova --version 没有输出。" }
  Ok $installedVersion

  # --------------------------------------------------------------------------
  # 5. PATH hint.
  # --------------------------------------------------------------------------
  if ($env:PATH -notlike "*$BinDir*") {
    Write-Host ""
    Write-Host "[提示] 请把 bin 目录加入用户 PATH 以持久化:" -ForegroundColor Yellow
    Write-Host "  [Environment]::SetEnvironmentVariable('PATH', `"$BinDir;`$([Environment]::GetEnvironmentVariable('PATH','User'))`", 'User')"
    Write-Host "然后重开终端。"
  }

  Write-Host ""
  Write-Host "完成！运行 apexnova login 登录，然后 apexnova opencode 开始使用。" -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host "安装失败: $_" -ForegroundColor Red
  exit 1
} finally {
  if (Test-Path $TmpDir) { Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue }
}
