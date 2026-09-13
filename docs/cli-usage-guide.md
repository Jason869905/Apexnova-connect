# Apexnova-connect CLI 使用指南（通用部分）

> 适用版本：apexnova-connect v0.6.1
> 平台：Windows、Linux。**macOS 不在支持范围内**——Keychain 后端有实现但从未在真实 macOS 上验收过，按 [ADR 0024](decisions/0024-narrow-platform-claims.md) 不再声称支持

本文是所有 Agent 共用的部分：安装、登录、Hub 地址、Key 模式、通用命令、环境变量和安全说明。**某个 Agent 特有的配置字段、限制和恢复方式在各自的指南里**：

- [OpenCode](opencode-usage-guide.md)
- [Codex](codex-usage-guide.md)
- [Claude Code](claude-code-usage-guide.md)
- [Hermes Agent](hermes-usage-guide.md)

`apexnova agents` 列出本次构建支持哪些 Agent 及其状态、平台和可消费协议。

## 前置条件

- `curl`（Windows 用 PowerShell 自带的 `irm`）
- Node.js 20+ —— **没有也不用管**，一行安装脚本缺了会通过 fnm 装一份，只供本 CLI 使用
- 一个 Apexnova AI Hub 账号
- **不需要 keyring**：Linux 上凭证默认存进一个 0600 文件（见[凭证存在哪](#凭证存在哪仅-linux-可选)）
- **目标 Agent 自己装好**：本 CLI 不安装 OpenCode / Codex / Claude Code / Hermes，只发现、配置和启动它们

## 初始化安装流程

从零到跑起来一共三步，全部照抄即可——**不需要装 keyring，不需要 sudo，不需要 D-Bus**。

| # | 命令 | 做了什么 |
|---|---|---|
| 1 | `curl -fsSL .../install.sh \| bash` | 定位或安装 Node、校验 sha256、装单文件 CLI、写 `apexnova` 启动器 |
| 2 | `apexnova login` | 设备码授权，token 存进凭证后端（Linux 默认是 0600 文件，Windows 是 Credential Manager） |
| 3 | `apexnova run <agent>` | 选模型 + 建 key + 写 Agent 配置 + 启动 |

两件可选的事：**源码构建**没有内置 Hub 地址，`login` 之前要先 `apexnova init --hub-url ...`（[可选：配置 Hub 地址](#可选配置-hub-地址)）；**想让操作系统保管秘密**的机器可以改用 keyring（[凭证存在哪](#凭证存在哪仅-linux-可选)）。

下面各节按同样顺序展开，最后的「[自检：doctor 怎么读](#自检doctor-怎么读)」把 `apexnova doctor` 的每一行对回到对应步骤——它随时可以回答「现在卡在哪一步」。

### 安装后落在哪些路径

| 路径 | 内容 | 谁写的 |
|---|---|---|
| `~/.apexnova-connect/apexnova.mjs` | 单文件 CLI（约 1 MB） | 安装脚本 |
| `~/.local/bin/apexnova` | 启动器，内含 node 绝对路径（Windows 为 `apexnova.cmd`） | 安装脚本 |
| `~/.fnm/` | 仅当机器上没有 Node 20+ 时才出现 | 安装脚本 |
| `~/.config/apexnova-connect/config.json` | Hub 地址、client ID、凭证后端选择（Windows 为 `%APPDATA%\Apexnova\connect\config.json`） | `apexnova init` |
| `~/.local/share/apexnova-connect/credentials.json`（Linux 默认），或系统 keyring / Windows Credential Manager | token、runtime 凭据、key 引用 | `apexnova login` / `run` |
| `~/.local/state/apexnova-connect/` | 审计日志、事务记录、可恢复备份 | `connect` / `switch` / `run` |
| 各 Agent 自己的配置文件 | 只有 `provider.apexnova` 这类受管理字段 | `connect` / `switch` / `run` |

卸载顺序：先 `apexnova logout`（撤销服务端 token），需要的话在 Hub 控制台撤销还在用的 `sk-` key，再删掉上面这些路径。Agent 自己的配置可以先用 `apexnova restore --list` 查事务、`apexnova restore <id> --yes` 还原成接入之前的样子。

### Agent 要你自己装

`run` 要求 `detect` 结果是 `installed`，找不到可执行文件时返回 `AGENT_NOT_FOUND`，**不会替你安装**。各 Agent 的安装方式见它们自己的文档（[OpenCode](https://opencode.ai/docs/)、[Codex](https://learn.chatgpt.com/docs/config-file/config-reference)、[Claude Code](https://code.claude.com/docs/en/llm-gateway-connect)、[Hermes](https://hermes-agent.nousresearch.com/docs/)），装完用 `apexnova detect` 确认。

> **WSL 里要装 Linux 原生的那一份**。WSL 的 `$PATH` 带着 Windows 的 npm 目录，`opencode`/`codex` 很容易解析到 `/mnt/c/.../AppData/Roaming/npm` 下的 Windows 安装——那份读的是 Windows 用户的配置文件。发现到这种情况时启动器会**拒绝启动**并说明原因，而不是配置一份、启动另一份。

## 第 1 步：安装 CLI

### 一行安装（推荐）

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.ps1 | iex
```

钉定版本：`APEXNOVA_VERSION=v0.6.1`。其他可覆盖变量：`APEXNOVA_HOME`、`APEXNOVA_BIN`、`APEXNOVA_ASSET_URL`、`NODE_MAJOR`。

脚本按顺序做六件事，任何一件失败都会停下并说明原因：

1. **找 Node**：`node -v` ≥ 20 就用它（记下绝对路径）；否则下载 fnm 到 `~/.fnm` 并装一份 Node 20。
2. **下载**：从 GitHub release 取 `apexnova.mjs`（默认 `latest`）。
3. **校验**：比对同名 `.sha256`；机器上没有 `sha256sum`/`shasum` 时跳过并**告警**（不会假装校验过）。
4. **安装**：放到 `~/.apexnova-connect/apexnova.mjs`。
5. **写启动器**：`~/.local/bin/apexnova`，里面钉死第 1 步那个 node 的绝对路径——所以新开的终端、没有 fnm 环境的 shell 也能直接跑；`APEXNOVA_NODE` 可覆盖。随后跑一次 `apexnova --version` 自检。
6. **提示**：`~/.local/bin` 不在 `PATH` 时打印 `export PATH=...`。

脚本不装 keyring、不动系统包、不需要 sudo——凭证默认走文件后端，本来就不需要这些。

### 从源码构建

```bash
pnpm install && pnpm --filter @apexnova-connect/cli... build
node apps/cli/dist/main.js --version
```

源码构建**不含**内置 Hub 地址（避免开发版本误连生产），必须先 `apexnova init` 或设置环境变量。

## 可选：配置 Hub 地址

发布产物已内置生产 Hub 地址，可以跳过本节直接 `apexnova login`；源码构建**不含**内置地址，必须先做这一步。

`apexnova init` 写的是 `~/.config/apexnova-connect/config.json`。[凭证后端](#凭证存在哪仅-linux-可选)也记在同一个文件里（`credentialStore` 字段），所以要改的话可以一条命令做完：

```bash
apexnova init --hub-url https://api.apexnova-consulting.com --client-id apexnova-connect --credential-store system
```

只改地址：

```bash
apexnova init --hub-url https://api.apexnova-consulting.com --client-id apexnova-connect
```

或用环境变量临时覆盖（优先级高于配置文件）：

```bash
export APEXNOVA_HUB_BASE_URL=https://api.apexnova-consulting.com
export APEXNOVA_OAUTH_CLIENT_ID=apexnova-connect
```

改已有配置只传要改的那个 flag 即可；一个 flag 都不传又是非交互（`--json`、`--non-interactive`、CI）时会报 `CONFIG_EXISTS`，此时用 `--force` 表示确实要整份覆盖。

## 第 2 步：登录

```bash
apexnova login
```

CLI 显示一条已经带上验证码的 URL：

```
Open https://console.apexnova-consulting.com/device?user_code=ABCD-EFGH
Code: ABCD-EFGH (already in the link; type it if the page asks)
Expires: 2026-09-06T12:00:00Z
```

在浏览器打开这条 URL，页面会预填验证码，确认无误后批准授权——不需要回到终端复制代码。代码仍然印在下一行，用于核对页面显示的是否是同一个，以及终端把 URL 截断时手工输入。token 存进当前凭证后端（Linux 默认是 `~/.local/share/apexnova-connect/credentials.json`，Windows 是 Credential Manager），不写进任何 Agent 的配置文件。

> **scope 一次性定死**：登录申请的 scope 包括 `api-keys:read/write/revoke`。用旧版 CLI 登录过的 token 没有这些 scope，连接时会收到 `INSUFFICIENT_SCOPE`——重新 `apexnova login` 即可。

## 第 3 步：一行启动 Agent

```bash
apexnova run <agent>            # 选模型 + 创建 key + 写配置 + 启动
apexnova run <agent> -- <args>  # -- 之后的参数透传给 Agent
```

首次运行会选模型并写配置；之后直接启动。

**一次可以选多个模型。**交互模式下首次运行弹出的是多选框：空格勾选、回车确认，勾了不止一个再问一次「先用哪个」。勾中的模型全部写进 Agent 的配置，共用**同一枚永久 key**，于是之后在 Agent 自己的界面里换模型不用回到 Connect，也不会多花一次授权：

```bash
apexnova run opencode           # 勾 nova + glm，默认 nova
                                # 之后在 OpenCode 里直接切到 glm，key 不变
```

非交互环境（`--json`、`--non-interactive`、CI）没有已绑定的 model 时**不会**替你挑一个，而是返回 `MODEL_REQUIRED`（退出码 2）——先用 `apexnova models --json` 列出候选，再传 `--model`；`--model` 可以重复，第一个就是默认模型：

```bash
apexnova run opencode --model glm-5.2 --model deepseek-v4 --json
```

一个 Agent 只配置一个 endpoint，所以一组模型必须在同一个协议和同一个 base URL 上。做不到时报 `PROTOCOL_NOT_SHARED` 并列出分歧的 model——少配一个会让你拿到一个选得中、用不了的模型。

启动器要求 `detect` 结果为 `installed`：只有配置文件、没有可执行文件时返回 `AGENT_NOT_FOUND`。

## 第 4 步：换模型

`apexnova switch <agent>`。不带参数就从列表里挑：

```bash
apexnova switch opencode        # 上下键选，回车确认，Esc 取消
```

**切换是「加上并置顶」**：选中的模型不在配置里就加进去，已经在就只把默认改成它，其余已配置的模型全部保留。**key 不变**——不新建、不撤销，所以换模型不花钱、不影响你在别处引用的那枚 key，也不需要重新授权。列表里已经配好的模型标着 `configured`，选中它就是「把默认改回这个」。

直接指定目标时会先把要做的事打出来再问一遍，默认 N：

```bash
$ apexnova switch opencode --model glm-5.2
Add GLM 5.2 (glm-5.2) as the default model for OpenCode?
  Model:    deployment.apexnova.cmq4770nr0000edzis38w378a
  Protocol: openai-responses
  Models after the switch: deployment.apexnova.cmq4770nr0000edzis38w378a, deployment.apexnova.cmt0bub5d0042139w2xobpghn
  Key key_1 is widened, not replaced.

? Apply this switch? (y/N)
```

`--model` 接受目录 ID，也接受别名（`glm-5.2` 这种），歧义时报 `MODEL_AMBIGUOUS` 并列出候选。**打印出来的是目录 ID**：别名可以改名，而计费和审计认的是 ID。

`--model` 本身说不出「哪些模型会留下」和「key 会不会被换掉」，所以在问之前就摆出来。回答 N 不写任何东西。

从列表里挑不会再问——那一次选择本身就是确认。`--yes` 是这个问题的非交互答案：

```bash
apexnova switch opencode --model glm-5.2 --yes
apexnova switch opencode --best --yes                 # 换到推荐第一名
apexnova switch opencode --model glm-5.2 --dry-run    # 只看计划，不写盘
```

非交互环境（`--json`、`--non-interactive`、CI）必须给 `--model` 或 `--best`，否则返回 `MODEL_REQUIRED`（退出码 2）——先 `apexnova models --json` 列候选；没给 `--yes` 则返回 `APPROVAL_REQUIRED`（退出码 3），不会替你答。

`apexnova models` 只列目录，不改任何东西。列表顺序跟 Hub 的模型广场一致，`switch` 的选择器读的是同一份顺序。

> **`switch` 和 `connect` 不是一回事**：`connect` 建立绑定并签发一枚 24 小时 runtime credential，替换当前绑定，用于按次追踪；`switch` 在已有的永久 key 上换默认模型。v0.6 及之前 `switch` 是 `connect` 的别名，而选择器在 `models` 里——需要旧的 `switch` 行为，用 `connect`（[ADR 0038](decisions/0038-models-reads-switch-writes.md)）。

## 凭证存在哪（仅 Linux 可选）

> 自 v0.6.0 起。v0.5.2 及更早版本在 Linux 上强制要求 keyring。

Linux 上**默认就绪，不用做任何事**：token、runtime 凭据和 key 引用写进 `~/.local/share/apexnova-connect/credentials.json`，目录 0700、文件 0600。不需要 `secret-tool`、不需要 D-Bus、不需要 sudo。Windows 默认用 Credential Manager，同样不用准备。

代价必须说清楚：**这个文件只靠文件权限保护**。任何能以你的身份读到它的东西都能用你的会话。headless 机器上没有可派生密钥的操作系统秘密，所以这里不提供加密的假象——`apexnova doctor` 每次都会为此输出一条 `credential-protection` 警告，那是常驻提醒，不是故障。

为什么默认不是 keyring：Secret Service 在这个工具真正运行的环境里（容器、CI、headless SSH、WSL）基本不存在，强制要求它没换来任何保护，只换来五条命令的绕行，而且失败发生在**用户已经批准设备授权之后**（[ADR 0036](decisions/0036-file-backend-becomes-the-linux-default.md)）。

### 想让操作系统保管秘密

```bash
sudo apt-get install -y libsecret-1-0 libsecret-tools gnome-keyring
apexnova init --credential-store system
apexnova login                                  # 两个后端不共享已存凭证，要重新登录一次
```

无桌面环境（headless WSL/SSH）还需要先把 D-Bus 和 keyring 起起来：

```bash
eval "$(dbus-launch --sh-syntax)"
gnome-keyring-daemon --start --components=secrets
echo -n "" | gnome-keyring-daemon --unlock
```

选了 `system` 之后后端不可用最常见的两种情况：

- **没有任何 keyring 在跑**：`secret-tool` 等到超时后非零退出，CLI 报 `BACKEND_UNAVAILABLE`。
- **keyring 在跑，但挂在另一条会话总线上**：`org.freedesktop.secrets` 在当前总线上无人应答，表现同样是超时。先确认 daemon 实际用的是哪条总线，再让命令指向它：

  ```bash
  pgrep -af gnome-keyring
  tr '\0' '\n' < /proc/<pid>/environ | grep DBUS_SESSION_BUS_ADDRESS
  export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-XXXXXX   # 用上一行的输出
  ```

  这条总线跟着那个 daemon 进程存活，机器重启后要重新确认。

### 临时切换与切换规则

```bash
APEXNOVA_CREDENTIAL_STORE=system apexnova whoami   # 只对这条命令/这个 shell 生效，优先级最高
apexnova init --credential-store file              # 写回配置文件，改成默认的文件后端
```

**永远不会自动切换后端**：选了 `system` 而 keyring 不应答时，命令报 `BACKEND_UNAVAILABLE` 并停下，不会把秘密改写到文件里——秘密悄悄换了个地方，等于这台机器一半凭证在这边、一半在那边，比一个说明白的错误更难收拾。

> **从 v0.5.2 升上来的 Linux 用户**：旧版本的凭证在 keyring 里，新默认读的是文件，所以升级后会表现为"没登录"。重新 `apexnova login` 即可；想继续用 keyring 就 `apexnova init --credential-store system`。keyring 里的旧条目不会被自动删除，`apexnova logout`（切回 system 后执行）可以清掉。

## 自检：doctor 怎么读

```bash
apexnova doctor
```

```
PASS     claude-code.discovery: Claude Code: installed 2.1.261
FAIL     opencode.discovery: OpenCode: not-found
PASS     credential-backend: credential file (permissions only, no OS keyring) (~/.local/share/apexnova-connect/credentials.json)
WARNING  credential-protection: credentials are protected by file permissions alone (the default on this platform)
PASS     state-root: ~/.local/state/apexnova-connect
PASS     hub-endpoint: https://api.apexnova-consulting.com (config-file)
PASS     hub-session: acct_...
```

对着上面的五步读这份输出：

| 检查 | 对应的事 | FAIL 时怎么办 |
|---|---|---|
| `<agent>.discovery` | 第 3 步 | 那个 Agent 没装或不在 PATH 上；CLI 不会替你装 |
| `credential-backend` | 凭证后端 | 默认的文件后端几乎不会失败（除非目录不可写或权限被改坏）；选了 `system` 又没有 keyring 应答时报这条 |
| `credential-protection` | 凭证后端 | 这是常驻警告，不是故障：文件后端只有文件权限保护 |
| `hub-endpoint` | 可选 init | 跑 `apexnova init`，或设 `APEXNOVA_HUB_BASE_URL` |
| `hub-session` | 第 2 步 | 跑 `apexnova login`；`INSUFFICIENT_SCOPE` 也重新登录一次 |

非 `--json` 模式下，命令的 warnings 会打到 **stderr**（`Warning: ...`），stdout 只留结果，方便 `apexnova ... | jq` 之类的管道。

`credential-backend` 是**真跑**出来的：写入一个探针值、读回、删除。报 `PASS` 就是这台机器上的后端确实能用，不是「这个平台理论上支持」。

## 通用命令

```bash
apexnova agents                                  # 支持哪些 Agent
apexnova whoami                                  # 当前账号与套餐
apexnova detect [agent]                          # 装没装、版本、配置在哪
apexnova inspect <agent>                         # 当前 Provider、协议、受管理字段
apexnova models [--agent <id>]                   # 模型目录，只读
apexnova recommend <agent>                       # 按证据排名，说明为什么
apexnova usage --granularity day                 # 用量
apexnova balance                                 # 余额
apexnova connect <agent> --model <id> --dry-run   # 预览计划，不写盘不签发凭据
apexnova connect <agent> --model <id> --yes       # 应用
apexnova connect <agent> --best --yes            # 连到推荐第一名，并把依据写进审计
apexnova switch <agent>                          # 换模型：上下键选，回车确认（新模型自动加入配置，key 不变）
apexnova switch <agent> --model <id> --yes  # 换模型：直接指定
apexnova switch <agent> --best --yes             # 换到推荐第一名，并把依据写进审计
apexnova verify <agent>                          # 配置级验证（不产生费用）
apexnova verify <agent> --live --yes             # 真实推理验证（产生少量费用）
apexnova audit [agent]                           # 读路由审计：选了谁、依据是什么、谁付的账
apexnova restore --list                          # 列出可恢复事务及其写过的文件
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

24h runtime credential（`anrt_`），绑定当前设备、不占 key 配额、撤销设备即级联失效。

> `apexnova connect` **总是**签发短期 runtime credential；`--rotating` 只影响 `apexnova run` 这条一行启动路径。`--gateway` 也蕴含它（见下）。

### 自定义有效期（`--credential-ttl <秒>`）

120～86400 秒，默认 86400，蕴含 `--rotating`。一次十分钟的运行不需要一枚一整天的凭据——万一进程没走到收回那一步，留下的东西越短越好。

**续期窗口随寿命缩放**：最后一小时，或寿命的后一半，取较短者（对 24 小时凭据就是原来的一小时）。续期发生在请求到来时，复制原有寿命而不是退回 24 小时。

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

`--list` 会在每个事务下方列出它**写过的文件路径**。用 `--config` 建的事务，恢复时要带同样的 `--config`，否则目标不在允许的根目录内，会以 `PATH_OUTSIDE_ALLOWED_ROOT` 拒绝。

目标文件在事务之后被改动或删除时，恢复会以 `CONFLICT` 拒绝。确实要丢弃那些改动时用 `--discard-local-changes`——它不是直接覆盖，而是先把当前内容另存到备份目录的 `discarded/` 下再恢复。

**必须逆序恢复**：跳过较新的事务会返回 `RESTORE_ORDER_CONFLICT`（`--list` 里标了 `restorable` 的那条才可恢复，`--dry-run` 的判断与实际执行一致）。恢复只撤销 Connect 写入的字段，之后你自己加的配置不受影响；恢复一次 `connect` 时会为上一个目标重新签发凭据。文件在应用之后被改过时，恢复会以 `CONFLICT` 拒绝而不是覆盖你的改动。

## 本地 Gateway（`run --gateway`，默认关闭）

不开时，Agent 直接把请求发给 Hub，凭据必须写进 Agent 能读到的地方。开启后，Connect 在回环地址上起一个转发服务：

```
Agent ──(本地令牌)──> 127.0.0.1:随机端口 ──(Hub 凭据)──> Apexnova AI Hub
                          └─ 留在 Connect 进程内
```

两个好处：

- **凭据不再交给 Agent。** Agent 只拿到一枚随进程生死的本地令牌，Hub 凭据从头到尾不离开 Connect 进程。这也是运行期能换凭据的前提——换的是 Gateway 手里那枚，Agent 无感知；
- **归属从"猜"变成"记"。** 直连时只能对比计费台账的前后差值（按小时分桶，别人的请求混在里面）；经 Gateway 时每个请求都被逐条记下：方法、路径、Hub 的 `requestId`、状态码、耗时、用的哪枚凭据。

```bash
apexnova run opencode --gateway --model deployment.apexnova.xxx
apexnova audit --limit 1      # 看逐请求归属
```

它**只转发，不做选择**：不替你换模型、不重试（一个可能已经执行过工具调用的请求不能由我们替 Agent 重放）、不缓冲流式响应、只换 origin 而保留路径。正确性标准是「Agent 察觉不到它在那里」。

**为什么默认关闭**：转为默认的三条门槛还差最后一条——一次真实的长交互会话。前两条（跨过凭据到期的实跑、Claude Code 端到端）在被真正执行时各揪出了缺陷，所以这条不打算跳过。见 [ADR 0020](decisions/0020-gateway-batch-closure.md)。

## 路由审计

每次「连接目标的确定」都写一条不可变记录，回答三句话：**选了哪个 Model、依据是什么、实际由谁计费**。

```bash
apexnova audit                 # 最近的记录
apexnova audit opencode        # 只看某个 Agent
apexnova audit --limit 20
```

一条典型输出：

```
2026-09-13T12:07:39.781Z  hermes  deployment.apexnova.cmq4770nr0000edzis38w378a
  chosen: explicit by run
  protocol: openai-chat, catalog cat_c3d1d0a8a33c
  credential: cmtzrrtsa00xk5i91eodow8yz
  billed (run): confirmed via ledger-window — 1 on cmtzrrtsa00xk5i91eodow8yz
```

`chosen` 的依据可能是 `explicit`（你指定的）、`recommendation`（`--best`，并引用具体的 Recommendation id）、`existing`、`interactive` 或 `restore`。计费一行的 `method` 是 `gateway`（逐请求，精确）还是 `ledger-window`（台账前后差值，受并发影响）。

**这里只记真实发生过的事**：台账还没结算时记 `unconfirmed`，而不是记成「零次、已确认」。

## 兼容性

采集证据（**会真实计费**）：

```bash
apexnova compatibility run opencode --model glm-5.2          # 只看估价，不发请求
apexnova compatibility run opencode --model glm-5.2 --yes    # 批准后真跑
```

一次运行发八个请求、其中六个计费，跑完按 requestId 与 Hub 用量对账。估价超过本地上限（默认 `0.05`）会直接拒绝，确实要跑更贵的模型时用 `--budget` 显式抬高。测试用的 runtime credential 只作用于被测 Model，跑完立即撤销。

采集时可以顺便录一份，之后离线回放：

```bash
apexnova compatibility run opencode --model glm-5.2 --yes --record run.json
apexnova compatibility replay run.json      # 不花钱、不需要凭据、不写证据
```

回放说明的是套件对那批响应的判定，不是模型现在的行为，所以它不会生成证据。录制里不含凭据，请求头一概不记录。

查看本地已采集的兼容性证据说明了什么：

```bash
apexnova compatibility explain                 # 所有 Agent
apexnova compatibility explain opencode        # 单个 Agent
apexnova compatibility explain opencode --model <id>
```

这条命令完全离线：只读本地证据，不调用 Hub，不花钱。结果按「Agent 版本 + Integration 版本 + Model + 协议 + 平台」分组，任一项不同都算另一个问题——升级 Agent 之后旧证据不会顺延，命令会直接告诉你它不适用于当前安装的版本。

过期的证据不会被删除，而是标记为 stale 并继续显示，因为它正是某项能力显示为 `unknown` 的原因。短时效的能力（流式、Tool Call）30 天过期，协议静态字段 90 天。

到期要重跑时：

```bash
apexnova compatibility refresh --within 30        # 只看计划和总估价，不发请求
apexnova compatibility refresh --within 30 --yes  # 批准后逐个重采
```

它会列出哪些 subject 到期、各自估价多少，以及哪些重采不了（Agent 没装、Model 下架了）。重采不会覆盖旧记录——新证据按时间序胜出，旧的留在库里。

还没跑过 `compatibility run` 时，这条命令会直接告诉你尚未采集。

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
| `APEXNOVA_CREDENTIAL_STORE` | 否 | `file`（0600 凭证文件，Linux 默认）或 `system`（操作系统凭证服务，Windows 默认）；优先级高于配置文件里的 `credentialStore` |

## 安全说明

- **密钥不进 Agent 配置**：secret 只存在凭证后端，不写入任何 Agent 的配置文件、日志或命令行参数。Linux 默认的后端是 0600 凭证文件，**只受文件权限保护**（`doctor` 会一直提醒）；要让操作系统保管就 `--credential-store system`
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
| 2 | 参数错误（如 `MODEL_REQUIRED`） |
| 3 | 未认证或凭据缺失 |
| 4 | 需要确认或权限不足 |
| 5 | Agent/Integration 未发现或不支持（含 `PROTOCOL_NOT_SUPPORTED`） |
| 6 | 配置冲突、版本不支持或并发修改 |
| 7 | 验证失败 |
| 8 | 网络或 Hub 暂时不可用 |
| 9 | 余额或限流阻止 |
| 10 | 恢复需要人工处理 |

完整规范见 [CLI 命令与输出规范](cli-spec.md)。
