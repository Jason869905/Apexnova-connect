# Apexnova-connect CLI 使用指南（通用部分）

> 适用版本：apexnova-connect v0.2.1
> 平台：Windows、Linux、macOS（macOS 尚未完成真实环境验收）

本文是所有 Agent 共用的部分：安装、登录、Hub 地址、Key 模式、通用命令、环境变量和安全说明。**某个 Agent 特有的配置字段、限制和恢复方式在各自的指南里**：

- [OpenCode](opencode-usage-guide.md)
- [Codex](codex-usage-guide.md)
- [Claude Code](claude-code-usage-guide.md)
- [Hermes Agent](hermes-usage-guide.md)

`apexnova agents` 列出本次构建支持哪些 Agent 及其状态、平台和可消费协议。

## 前置条件

- Node.js 20+（一行安装脚本会在缺失时通过 fnm 自动安装）
- 目标 Agent 已安装（`apexnova detect` 会告诉你哪些被识别到了）
- 一个 Apexnova AI Hub 账号
- 可用的操作系统凭证后端（见下方 Linux 一节）

## 安装

### 一行安装（推荐）

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.ps1 | iex
```

钉定版本：`APEXNOVA_VERSION=v0.2.1`。其他可覆盖变量：`APEXNOVA_HOME`、`APEXNOVA_BIN`、`APEXNOVA_ASSET_URL`、`NODE_MAJOR`。

### 从源码构建

```bash
pnpm install && pnpm --filter @apexnova-connect/cli... build
node apps/cli/dist/main.js --version
```

源码构建**不含**内置 Hub 地址（避免开发版本误连生产），必须先 `apexnova init` 或设置环境变量。

### Linux 凭证后端（仅 Linux 需要）

```bash
sudo apt-get install -y libsecret-1-0 libsecret-tools gnome-keyring
```

无桌面环境（headless WSL/SSH）需要启动 D-Bus 和 gnome-keyring：

```bash
eval "$(dbus-launch --sh-syntax)"
gnome-keyring-daemon --start --components=secrets
echo -n "" | gnome-keyring-daemon --unlock
```

`apexnova doctor` 的 `credential-backend` 检查会真实写入探针值再读回删除，所以它报 `PASS` 就是后端确实可用，不只是「这个平台理论上支持」。

后端不可用最常见的两种情况：

- **没有任何 keyring 在跑**：`secret-tool` 等到超时后非零退出，CLI 报 `BACKEND_UNAVAILABLE` 并提示启动命令。
- **keyring 在跑，但挂在另一条会话总线上**：`org.freedesktop.secrets` 在当前总线上无人应答，表现同样是超时。先确认 daemon 实际用的是哪条总线，再让命令指向它：

  ```bash
  pgrep -af gnome-keyring
  tr '\0' '\n' < /proc/<pid>/environ | grep DBUS_SESSION_BUS_ADDRESS
  export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-XXXXXX   # 用上一行的输出
  ```

  这条总线跟着那个 daemon 进程存活，机器重启后要重新确认。

Apexnova-connect **不会**在凭证后端不可用时把密钥降级写进明文文件，因此这一步没通过之前 `login` 无法完成。

## 配置 Hub 地址

发布产物已内置生产 Hub 地址，可以跳过本节直接 `apexnova login`。

```bash
apexnova init --hub-url https://api.apexnova-consulting.com --client-id apexnova-connect
```

或用环境变量临时覆盖（优先级高于配置文件）：

```bash
export APEXNOVA_HUB_BASE_URL=https://api.apexnova-consulting.com
export APEXNOVA_OAUTH_CLIENT_ID=apexnova-connect
```

## 登录

```bash
apexnova login
```

CLI 显示设备码和 URL：

```
Open https://console.apexnova-consulting.com/device
Enter code: ABCD-EFGH
Expires: 2026-09-06T12:00:00Z
```

在浏览器打开 URL、输入代码、批准授权。token 存进操作系统凭证后端。

> **scope 一次性定死**：登录申请的 scope 包括 `api-keys:read/write/revoke`。用旧版 CLI 登录过的 token 没有这些 scope，连接时会收到 `INSUFFICIENT_SCOPE`——重新 `apexnova login` 即可。

## 一行启动

```bash
apexnova run <agent>            # 自动选模型 + 创建 key + 写配置 + 启动
apexnova run <agent> -- <args>  # -- 之后的参数透传给 Agent
```

首次运行会选模型并写配置；之后直接启动。非交互环境（`--json`、`--non-interactive`、CI）没有已绑定的 deployment 时**不会**替你挑一个，而是返回 `DEPLOYMENT_REQUIRED`（退出码 2）——先用 `apexnova models --json` 列出候选，再传 `--deployment`。

启动器要求 `detect` 结果为 `installed`：只有配置文件、没有可执行文件时返回 `AGENT_NOT_FOUND`。

## 通用命令

```bash
apexnova agents                                  # 支持哪些 Agent
apexnova detect [agent]                          # 装没装、版本、配置在哪
apexnova inspect <agent>                         # 当前 Provider、协议、受管理字段
apexnova models [--agent <id>]                   # 模型目录，交互模式可上下键切换
apexnova usage --granularity day                 # 用量
apexnova balance                                 # 余额
apexnova connect <agent> --deployment <id> --dry-run   # 预览计划，不写盘不签发凭据
apexnova connect <agent> --deployment <id> --yes       # 应用
apexnova switch <agent> --deployment <id> --yes        # 换模型
apexnova verify <agent>                          # 配置级验证（不产生费用）
apexnova verify <agent> --live --yes             # 真实推理验证（产生少量费用）
apexnova restore --list                          # 列出可恢复事务
apexnova restore <transaction-id> --yes          # 恢复
apexnova doctor [agent]                          # 只读诊断
apexnova logout                                  # 退出并撤销服务端 token
```

`detect` 和 `doctor` 省略 agent 时只覆盖**当前平台支持**的 Agent；manifest 排除了本平台的 Agent 不会出现。

## Key 模式

### 默认：永久 key（`sk-`）

- 永不过期（除非组织策略限制了最大 TTL）
- 不绑定设备，可在任何机器使用
- 占用账号 API Key 配额
- 可在 Hub 控制台查看和撤销

### 短期轮换（`--rotating`）

24h runtime credential（`anrt_`），启动时剩余不足一小时自动续期。绑定当前设备、不占 key 配额、撤销设备即级联失效。

> `apexnova connect` **总是**签发 24h runtime credential；`--rotating` 只影响 `apexnova run` 这条一行启动路径。

### 绑定已有 key（`--key <keyId>`）

跳过创建，复用指定 key，用于按工具追踪用量。CLI 验证 key 存在后提示输入 secret（交互模式）或从 `APEXNOVA_API_KEY` 读取（非交互模式）。

## 凭据怎么到达 Agent

配置文件里**永远不写密钥**，只写变量引用；密钥由 `apexnova run <agent>` 注入子进程环境。各 Agent 的引用方式不同（`{env:VAR}`、`env_key`、`${VAR}`），见各自指南。

Claude Code 额外支持 `--api-key-helper`：写一个指回本 CLI 的 `apiKeyHelper`，让它自己取凭据，这样不经 `apexnova run` 直接启动也能用。配套命令：

```bash
apexnova credential print <agent>   # 只输出凭据本身，供 helper 使用
```

它不接受 `--json`，短期 credential 快过期时会先续期。输出不应被重定向进文件或日志。

## 恢复

每次 `connect` / `switch` 都会留下一个可恢复事务：

```bash
apexnova restore --list
apexnova restore <transaction-id> --dry-run
apexnova restore <transaction-id> --yes
```

**必须逆序恢复**：跳过较新的事务会返回 `RESTORE_ORDER_CONFLICT`。恢复只撤销 Connect 写入的字段，之后你自己加的配置不受影响；恢复 `switch` 时会为上一个目标重新签发凭据。文件在应用之后被改过时，恢复会以 `CONFLICT` 拒绝而不是覆盖你的改动。

## 超时

`--timeout <秒>` 是**整条命令**的期限（默认 120 秒），不是单次 HTTP 请求的期限——一条命令会串行发多个 Hub 请求，共享同一期限。失败后撤销刚签发凭据的补偿操作使用独立期限，不会因为主操作超时而被跳过。

## 环境变量参考

Hub 地址解析顺序：环境变量 > `apexnova init` 写入的配置文件 > 发布产物内置默认值。

| 变量 | 必需 | 说明 |
|---|---|---|
| `APEXNOVA_HUB_BASE_URL` | 否 | Hub API 地址；覆盖配置文件与内置默认值 |
| `APEXNOVA_OAUTH_CLIENT_ID` | 否 | OAuth client ID，固定为 `apexnova-connect` |
| `APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK` | 否 | 设为 `1` 时允许 localhost HTTP（仅开发用） |
| `APEXNOVA_HUB_PATH_PREFIX` | 否 | API 路径前缀，如 dev 环境设为 `/api`（仅开发用） |
| `APEXNOVA_ACCESS_TOKEN` | 否 | 直接传入 access token，跳过 credential store（仅测试用） |

## 安全说明

- **密钥不落盘**：secret 只存在操作系统凭证后端，不写入任何 Agent 的配置文件、日志或命令行参数
- **OAuth token 自动刷新**：access token 过期后用 refresh token 自动续期
- **撤销语义**：`logout` 撤销整族 token；撤销 key 后推理返回 401；重复撤销返回 404
- **组织 TTL 策略**：组织配了 `defaultKeyTtlDays` 时，`expiresIn: null` 建出的 key 仍会带策略过期时间。遇到 `key_ttl_policy` 时改用 `--rotating` 或更短过期时间
- **费用事实来源是 Hub**：以 `X-Apexnova-Request-Id` 的对账结果为准；`verify --live` 展示的估价不是消费上限
- **限流退避**：Hub 返回 429 + `Retry-After` 时自动退避重试
- **不猜测配置**：无法解析的配置会被报成 `invalid` 并拒绝改写，不会被猜着改
- **版本漂移拒绝**：产品版本超出 manifest 声明的范围时返回 `PRODUCT_VERSION_UNSUPPORTED`，不会对没测过的配置格式动手

## 退出码

| Code | 含义 |
| ---: | --- |
| 0 | 成功，包括明确的 no-op |
| 2 | 参数错误（如 `DEPLOYMENT_REQUIRED`） |
| 3 | 未认证或凭据缺失 |
| 4 | 需要确认或权限不足 |
| 5 | Agent/Integration 未发现或不支持（含 `PROTOCOL_NOT_SUPPORTED`） |
| 6 | 配置冲突、版本不支持或并发修改 |
| 7 | 验证失败 |
| 8 | 网络或 Hub 暂时不可用 |
| 9 | 余额或限流阻止 |
| 10 | 恢复需要人工处理 |

完整规范见 [CLI 命令与输出规范](cli-spec.md)。
