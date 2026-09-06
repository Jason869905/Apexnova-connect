# OpenCode + Apexnova AI Hub 使用指南

> 适用版本：apexnova-connect v0.1.0 · OpenCode ≥1.18.29 <2.0.0
> 平台：Windows、Linux

## 简介

`apexnova-connect` 是一个 CLI 工具，把 OpenCode 的模型请求路由到 Apexnova AI Hub。它通过 OAuth 设备流登录 Hub，签发短期 runtime credential，自动写入 OpenCode 的 Provider 配置，并在启动 OpenCode 时注入凭证——**API Key 不落盘**，不写进 OpenCode 配置文件。

## 前置条件

1. **Node.js ≥ 22**（推荐 24+）和 npm/pnpm
2. **OpenCode** 已安装并在 PATH 中可用（`opencode --version`）
3. **Apexnova AI Hub 账号**，有可用余额
4. **操作系统凭证后端**：
   - Windows：Credential Manager（内置，无需配置）
   - Linux：`libsecret-tools` + `gnome-keyring` + D-Bus session（见下方 Linux 安装说明）

## 安装

### 安装 apexnova-connect CLI

```bash
# 从源码构建（当前）
git clone <repo> && cd Apexnova-connect
pnpm install
pnpm --filter @apexnova-connect/cli... build
```

CLI 入口在 `apps/cli/dist/main.js`。可以加一个 alias：

```bash
# Linux/macOS — 加到 ~/.bashrc 或 ~/.zshrc
alias apexnova='node /path/to/Apexnova-connect/apps/cli/dist/main.js'

# Windows PowerShell — 加到 $PROFILE
Set-Alias apexnova "node C:\path\to\Apexnova-connect\apps\cli\dist\main.js"
```

### Linux 凭证后端（仅 Linux 需要）

```bash
sudo apt-get install -y libsecret-1-0 libsecret-tools gnome-keyring
```

在无桌面环境（headless WSL/SSH）中，需要启动 D-Bus 和 gnome-keyring：

```bash
eval "$(dbus-launch --sh-syntax)"
gnome-keyring-daemon --start --components=secrets
echo -n "" | gnome-keyring-daemon --unlock  # 用空密码解锁默认 keyring
```

## 配置 Hub 地址

设置两个环境变量（加到 shell profile 中持久化）：

```bash
export APEXNOVA_HUB_BASE_URL=https://api.apexnova-consulting.com
export APEXNOVA_OAUTH_CLIENT_ID=apexnova-connect
```

## 首次连接

### 第 1 步：登录

```bash
apexnova login
```

CLI 会显示一个设备码和 URL：

```
Open https://console.apexnova-consulting.com/device
Enter code: ABCD-EFGH
Expires: 2026-09-06T12:00:00Z
```

在浏览器中打开 URL，输入代码，批准授权。CLI 自动完成 token exchange 并将 OAuth token 安全存储到操作系统凭证后端。

### 第 2 步：查看账号和余额

```bash
apexnova whoami    # 当前账号、计划、设备
apexnova balance   # 余额、币种、信用额度
```

### 第 3 步：浏览可用模型

```bash
apexnova models --agent opencode
```

输出包含所有可见 Deployment 的 `id`、`inferenceAlias`、支持的协议和可用性状态。选一个要连接的 deployment，记下它的 `id`（形如 `deployment.apexnova.xxx`）。

加 `--compatible-only` 隐藏不可用项：

```bash
apexnova models --agent opencode --compatible-only
```

### 第 4 步：预览连接计划

```bash
apexnova connect opencode --deployment deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw --dry-run
```

`--dry-run` 不做任何修改，只展示将要写入的配置文件内容和操作计划。

### 第 5 步：执行连接

```bash
apexnova connect opencode --deployment deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw --yes
```

这一步会：
1. 向 Hub 签发一个 24 小时有效的 runtime credential
2. 写入 OpenCode 配置文件（`~/.config/opencode/opencode.jsonc`）
3. 验证配置正确性

**API Key 不会写入配置文件**——它只存在操作系统凭证后端中，在启动 OpenCode 时通过环境变量注入。

### 第 6 步：验证连接

先做配置级验证（不产生费用）：

```bash
apexnova verify opencode
```

再做真实推理验证（会产生少量费用）：

```bash
apexnova verify opencode --live --yes
```

输出示例：

```
OpenCode live verification passed for glm-5.2.
Deployment: deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw
Resolved model: glm-5.2
Request: 1984d5b9-83fe-44da-859c-9222c6d6daff
Billed: 0.000166 USD (17 input + 70 output tokens)
Non-binding estimate: 0.000608 USD (64 input + 256 output tokens assumed)
```

- **Billed** 是 Hub 实际扣费，通过 requestId 精确对账，是费用事实来源
- **Non-binding estimate** 是推理前的估价，不是消费上限

## 日常使用

### 启动 OpenCode

```bash
apexnova run opencode
```

这会：
1. 检查 runtime credential 是否有效（剩余不足 1 小时则自动续期）
2. 通过环境变量 `APEXNOVA_API_KEY` 注入 credential
3. 启动 OpenCode 子进程

也可以直接把参数传给 OpenCode：

```bash
apexnova run opencode -- --model apexnova/glm-5.2
```

在 OpenCode 中，Apexnova 模型以 `apexnova/<inferenceAlias>` 的形式出现，例如 `apexnova/glm-5.2`。

### 切换模型

```bash
# 预览
apexnova switch opencode --deployment deployment.apexnova.xxx --dry-run

# 执行
apexnova switch opencode --deployment deployment.apexnova.xxx --yes
```

`switch` 会保留当前配置作为 restore 目标，写入新模型配置，签发新 runtime credential。

### 查看余额

```bash
apexnova balance
```

## 恢复和清理

### 恢复之前的配置

每次 `connect` 和 `switch` 都会创建一个配置事务备份：

```bash
# 列出可恢复的事务
apexnova restore --list

# 恢复最近一次事务（撤销配置变更，撤销当前 credential，恢复上一个）
apexnova restore --yes
```

### 退出登录

```bash
apexnova logout
```

删除本地会话并撤销服务端 token。runtime credential 也会被撤销。

### 检查环境

```bash
apexnova doctor
```

检查 OpenCode 安装、配置、凭证后端、Hub 会话和 runtime credential 状态。

## 环境变量参考

| 变量 | 必需 | 说明 |
|---|---|---|
| `APEXNOVA_HUB_BASE_URL` | 是 | Hub API 地址，如 `https://api.apexnova-consulting.com` |
| `APEXNOVA_OAUTH_CLIENT_ID` | 是 | OAuth client ID，固定为 `apexnova-connect` |
| `APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK` | 否 | 设为 `1` 时允许 localhost HTTP（仅开发用） |
| `APEXNOVA_HUB_LOOPBACK_HOST_ALIAS` | 否 | loopback 测试中覆盖 DNS 解析 |

## 安全说明

- **API Key 不落盘**：runtime credential 只存在操作系统凭证后端（Windows Credential Manager / Linux Secret Service），不写入 OpenCode 配置文件、日志或命令行参数
- **runtime credential 24 小时过期**：`run opencode` 在剩余不足 1 小时时自动续期
- **OAuth token 自动刷新**：access token 过期后用 refresh token 自动续期
- **撤销语义**：`logout` 撤销整族 token（access + refresh）；撤销 runtime credential 会级联撤销同族 access token
- **费用事实来源是 Hub**：OpenCode 自身对自定义 Provider 报告的 `cost: 0` 不准确，以 Hub 的 `X-Apexnova-Request-Id` 对账结果为准
- **限流退避**：Hub 返回 429 + `Retry-After` 时 CLI 自动退避重试（最多 3 次，上限 30 秒）；预算耗尽（429 不带 `Retry-After`）不重试，提示用户充值

## 完整流程示例

```bash
# 1. 配置 Hub
export APEXNOVA_HUB_BASE_URL=https://api.apexnova-consulting.com
export APEXNOVA_OAUTH_CLIENT_ID=apexnova-connect

# 2. 登录
apexnova login

# 3. 查看可用模型
apexnova models --agent opencode

# 4. 连接 GLM-5.2
apexnova connect opencode --deployment deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw --yes

# 5. 验证
apexnova verify opencode --live --yes

# 6. 使用 OpenCode
apexnova run opencode

# 7. 用完恢复并退出
apexnova restore --yes
apexnova logout
```
