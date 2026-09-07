# OpenCode + Apexnova AI Hub 使用指南

> 适用版本：apexnova-connect v0.2.0 · OpenCode ≥1.18.29 <2.0.0
> 平台：Windows、Linux

> [!NOTE]
> v0.2 起支持四个 Agent：OpenCode、Codex、Claude Code、Hermes Agent。`apexnova agents` 列出本次构建支持哪些，`apexnova run <agent>` 是通用的一行启动命令。本文是 OpenCode 专属指南；其他 Agent 的受管理字段、已知限制和恢复方式见各自的
> [Integration README](../integrations/agents/)。本文中的 `apexnova opencode` 是 `apexnova run opencode` 的别名，继续可用。

## 简介

`apexnova-connect` 是一个 CLI 工具，把 OpenCode 的模型请求路由到 Apexnova AI Hub。**登录一次，一行命令启动 OpenCode**——自动创建永久 API Key、写入 Provider 配置、注入凭证、启动会话。

核心流程：

```
apexnova login        # 网页授权，一次性
apexnova opencode     # 自动选模型 + 创建 key + 写配置 + 启动
apexnova models       # 上下键切换模型
apexnova usage        # 按模型/按 key 看用量
apexnova balance      # 看余额
```

## 前置条件

1. **Node.js ≥ 20**（一行安装脚本在缺失时会自动装）
2. **OpenCode** 已安装并在 PATH 中可用（`opencode --version`）
3. **Apexnova AI Hub 账号**，有可用余额
4. **操作系统凭证后端**：
   - Windows：Credential Manager（内置，无需配置）
   - Linux：`libsecret-tools` + `gnome-keyring` + D-Bus session（见下方）

## 安装

### 一行安装（推荐）

下载预构建的单文件 CLI，不需要 git、pnpm 或本机编译：

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.ps1 | iex
```

脚本会校验产物 sha256，装到 `~/.apexnova-connect`，并在 `~/.local/bin` 生成 `apexnova` 启动器。若该目录不在 PATH 中，脚本会打印需要追加的一行。

钉定版本用 `APEXNOVA_VERSION=v0.2.0`；其他可覆盖变量：`APEXNOVA_HOME`、`APEXNOVA_BIN`、`APEXNOVA_ASSET_URL`、`NODE_MAJOR`。

### 从源码构建

```bash
git clone <repo> && cd Apexnova-connect
pnpm install
pnpm --filter @apexnova-connect/cli... build
```

CLI 入口在 `apps/cli/dist/main.js`。加一个 alias：

```bash
# Linux/macOS — 加到 ~/.bashrc 或 ~/.zshrc
alias apexnova='node /path/to/Apexnova-connect/apps/cli/dist/main.js'

# Windows PowerShell — 加到 $PROFILE
Set-Alias apexnova "node C:\path\to\Apexnova-connect\apps\cli\dist\main.js"
```

源码构建**不含**内置 Hub 地址（避免开发版本误连生产），必须先 `apexnova init` 或设置环境变量，见下方「配置 Hub 地址」。

### Linux 凭证后端（仅 Linux 需要）

```bash
sudo apt-get install -y libsecret-1-0 libsecret-tools gnome-keyring
```

在无桌面环境（headless WSL/SSH）中，需要启动 D-Bus 和 gnome-keyring：

```bash
eval "$(dbus-launch --sh-syntax)"
gnome-keyring-daemon --start --components=secrets
echo -n "" | gnome-keyring-daemon --unlock
```

`apexnova doctor` 的 `credential-backend` 检查会真实写入一个探针值再读回删除，所以它报 `PASS` 就是后端确实可用，不只是「这个平台理论上支持」。

后端不可用时最常见的两种情况：

- **没有任何 keyring 在跑**：`secret-tool` 会等到超时后非零退出，CLI 报 `BACKEND_UNAVAILABLE` 并提示启动命令。按上面三行启动即可。
- **keyring 在跑，但挂在另一条会话总线上**：这时 `org.freedesktop.secrets` 在你当前的总线上无人应答，表现同样是超时。先确认 daemon 实际用的是哪条总线，再让命令指向它：

  ```bash
  pgrep -af gnome-keyring
  tr '\0' '\n' < /proc/<pid>/environ | grep DBUS_SESSION_BUS_ADDRESS
  export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-XXXXXX   # 用上一行的输出
  ```

  这条总线跟着那个 daemon 进程存活，机器重启后要重新确认，或干脆在当前总线上重起一个 daemon。

Apexnova-connect 不会在凭证后端不可用时把密钥降级写进明文文件，因此这一步没通过之前 `login` 无法完成。

## 配置 Hub 地址

发布产物（`install.sh` / `install.ps1` 安装的版本）已内置生产 Hub 地址，可以跳过本节直接 `apexnova login`。

要指向其他环境，用 `apexnova init` 持久化到配置文件（推荐，只需一次）：

```bash
apexnova init --hub-url https://api.apexnova-consulting.com --client-id apexnova-connect
```

或用环境变量临时覆盖（优先级高于配置文件）：

```bash
export APEXNOVA_HUB_BASE_URL=https://api.apexnova-consulting.com
export APEXNOVA_OAUTH_CLIENT_ID=apexnova-connect
```

从源码构建的 CLI 不含内置默认值，必须先 `init` 或设置环境变量。

## 快速开始

### 1. 登录

```bash
apexnova login
```

CLI 显示设备码和 URL：

```
Open https://console.apexnova-consulting.com/device
Enter code: ABCD-EFGH
Expires: 2026-09-06T12:00:00Z
```

在浏览器中打开 URL，输入代码，批准授权。CLI 自动完成 token exchange 并安全存储到操作系统凭证后端。

> **scope 一次性定死**：登录时申请的 scope 包括 `api-keys:read/write/revoke`。如果之前用旧版 CLI 登录过，旧 token 没有这些 scope，调用 `apexnova opencode` 会收到 `INSUFFICIENT_SCOPE` 错误——重新 `apexnova login` 即可。

### 2. 启动 OpenCode

```bash
apexnova opencode
```

这一行命令会：
1. 检测 OpenCode 安装
2. 获取 Hub 模型目录，自动选择第一个可用模型（交互模式下弹出上下键选择器）
3. 向 Hub 创建一个**永久 API Key**（`sk-`，永不过期）
4. 写入 OpenCode 配置文件（`~/.config/opencode/opencode.jsonc`），Provider 的 `apiKey` 字段写 `{env:APEXNOVA_API_KEY}` 占位符——**secret 不落盘**
5. 通过环境变量 `APEXNOVA_API_KEY` 注入 key，启动 OpenCode 子进程

也可以指定模型或传参：

```bash
# 指定模型（deployment ID 从 apexnova models 输出中获取）
apexnova opencode --deployment deployment.apexnova.xxx

# 传参给 OpenCode
apexnova opencode -- --model apexnova/glm-5.2
```

### 3. 切换模型

交互模式下直接用上下键选择：

```bash
apexnova models
```

列出所有可用模型，上下键选中目标，回车即切换（自动创建新 key + 更新配置）。按 Esc 取消。

非交互模式用 `switch`：

```bash
apexnova switch opencode --deployment deployment.apexnova.xxx --yes
```

> **非交互首次运行必须指定模型**：没有已绑定的 deployment 且终端不可交互（`--json`、`--non-interactive`、CI）时，`apexnova opencode` 不会替你挑一个，而是返回 `DEPLOYMENT_REQUIRED`（退出码 2）。先用 `apexnova models --json` 列出候选，再传 `--deployment`。

### 4. 查看用量和余额

```bash
apexnova balance                          # 余额
apexnova usage --granularity day          # 按天聚合全部用量
apexnova usage --key <keyId> --granularity day  # 按特定 key 聚合
```

用量输出包含：时间桶、key 名称、模型、请求次数、token 用量、费用。

## Key 模式

### 默认：永久 key（`sk-`）

`apexnova opencode` 默认创建永久 key。特点：
- 永不过期（除非组织策略限制了最大 TTL）
- 不绑定设备，可在任何机器使用
- 占用账号 API Key 数量配额
- 可在 Hub 控制台查看和撤销

### 短期轮换（`--rotating`）

```bash
apexnova opencode --rotating
```

使用 24h 短期 runtime credential（`anrt_`），每次启动时自动续期。特点：
- 24 小时过期，自动轮换
- 绑定当前设备
- 不占 key 配额
- 撤销设备即级联失效

### 绑定已有 key（`--key`）

```bash
apexnova opencode --key <keyId>
```

跳过创建新 key，使用指定的已有 key。用于按工具追踪用量——多个工具共用一把 key 时，可以在 Hub 控制台看到这把 key 的总用量。

CLI 会验证 key 存在，然后提示输入 key secret（交互模式）或从 `APEXNOVA_API_KEY` 环境变量读取（非交互模式）。

## 高级命令

### 预览连接计划

```bash
apexnova connect opencode --deployment deployment.apexnova.xxx --dry-run
```

### 验证连接

```bash
apexnova verify opencode              # 配置级验证（不产生费用）
apexnova verify opencode --live --yes # 真实推理验证（产生少量费用）
```

### �(恢复

```bash
apexnova restore --list    # 列出可恢复的事务
apexnova restore --yes     # 恢复最近一次事务
```

### 退出登录

```bash
apexnova logout
```

删除本地会话并撤销服务端 token。关联的 API key 和 runtime credential 也会被撤销。

### 诊断

```bash
apexnova doctor
```

检查 OpenCode 安装、配置、凭证后端、状态目录、Hub 会话，以及当前生效的 Hub 地址及其来源：

```
pass  hub-endpoint    https://api.apexnova-consulting.com (built-in)
warn  hub-session     SESSION_NOT_FOUND
```

`hub-endpoint` 的来源标注为 `environment`、`config-file` 或 `built-in`；显示 `not configured` 时运行 `apexnova init`。

## 超时

`--timeout <秒>` 是**整条命令**的期限（默认 120 秒），不是单次 HTTP 请求的期限——`opencode`、`connect` 这类命令会串行发多个 Hub 请求，它们共享同一个期限。失败后撤销刚签发凭据的补偿操作使用独立期限，不会因为主操作已超时而被跳过。

## 环境变量参考

Hub 地址解析顺序：环境变量 > `apexnova init` 写入的配置文件 > 发布产物内置默认值。

| 变量 | 必需 | 说明 |
|---|---|---|
| `APEXNOVA_HUB_BASE_URL` | 否 | Hub API 地址，如 `https://api.apexnova-consulting.com`；覆盖配置文件与内置默认值 |
| `APEXNOVA_OAUTH_CLIENT_ID` | 否 | OAuth client ID，固定为 `apexnova-connect`；覆盖配置文件与内置默认值 |
| `APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK` | 否 | 设为 `1` 时允许 localhost HTTP（仅开发用） |
| `APEXNOVA_HUB_PATH_PREFIX` | 否 | API 路径前缀，如 dev 环境设为 `/api`（仅开发用） |
| `APEXNOVA_ACCESS_TOKEN` | 否 | 直接传入 access token，跳过 credential store（仅测试用） |

## 安全说明

- **API Key 不落盘**：key secret 只存在操作系统凭证后端，不写入 OpenCode 配置文件、日志或命令行参数
- **永久 key**：默认创建永不过期的 `sk-` key，可在 Hub 控制台随时撤销
- **短期 key**：`--rotating` 模式使用 24h `anrt_` credential，启动时自动续期
- **OAuth token 自动刷新**：access token 过期后用 refresh token 自动续期
- **撤销语义**：`logout` 撤销整族 token；撤销 key 后推理返回 401；重复撤销返回 404
- **组织 TTL 策略**：组织若配了 `defaultKeyTtlDays`，`expiresIn: null` 建出的 key 仍会带上策略过期时间。CLI 遇到 `key_ttl_policy` 错误时会提示用 `--rotating` 或指定更短过期时间
- **费用事实来源是 Hub**：以 Hub 的 `X-Apexnova-Request-Id` 对账结果为准
- **限流退避**：Hub 返回 429 + `Retry-After` 时 CLI 自动退避重试

## 完整流程示例

```bash
# 1. 配置 Hub（发布产物已内置生产地址，可跳过）
apexnova init --hub-url https://api.apexnova-consulting.com --client-id apexnova-connect

# 2. 登录（一次性）
apexnova login

# 3. 启动 OpenCode（自动选模型 + 创建永久 key + 写配置 + 启动）
apexnova opencode

# 4. 切换模型（上下键选择）
apexnova models

# 5. 查看用量
apexnova usage --granularity day

# 6. 用完退出
apexnova logout
```

## dev 环境联调

连接本机 dev Hub（Next.js dev server + nginx）：

```bash
export APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK=1
apexnova init --hub-url http://localhost:3000 --client-id apexnova-connect --path-prefix /api --force

apexnova login      # 浏览器打开 http://console.localhost/device 授权
apexnova opencode   # 永久 key 路径
```

dev 环境注意事项：
- `*.localhost` 只有浏览器会自动解析，curl/Node 不会——需要加 `/etc/hosts` 条目
- 设备批准页只能走 `console` 子域（`console.localhost/device`）
- dev 按需编译，每个端点首次请求慢 1–10 秒
- 不改 hosts 时推理用 `http://127.0.0.1:3000/api/v1`，但 OAuth 授权仍需 `console.localhost`
