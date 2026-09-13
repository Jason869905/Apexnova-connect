# Apexnova-connect CLI 使用指南（通用部分）

> 适用版本：apexnova-connect v0.5.2
> 平台：Windows、Linux。**macOS 不在支持范围内**——Keychain 后端有实现但从未在真实 macOS 上验收过，按 [ADR 0024](decisions/0024-narrow-platform-claims.md) 不再声称支持

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

钉定版本：`APEXNOVA_VERSION=v0.5.2`。其他可覆盖变量：`APEXNOVA_HOME`、`APEXNOVA_BIN`、`APEXNOVA_ASSET_URL`、`NODE_MAJOR`。

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
apexnova whoami                                  # 当前账号与套餐
apexnova detect [agent]                          # 装没装、版本、配置在哪
apexnova inspect <agent>                         # 当前 Provider、协议、受管理字段
apexnova models [--agent <id>]                   # 模型目录，交互模式可上下键切换
apexnova recommend <agent>                       # 按证据排名，说明为什么
apexnova usage --granularity day                 # 用量
apexnova balance                                 # 余额
apexnova connect <agent> --deployment <id> --dry-run   # 预览计划，不写盘不签发凭据
apexnova connect <agent> --deployment <id> --yes       # 应用
apexnova connect <agent> --best --yes            # 连到推荐第一名，并把依据写进审计
apexnova switch <agent> --deployment <id> --yes        # 换模型
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

**必须逆序恢复**：跳过较新的事务会返回 `RESTORE_ORDER_CONFLICT`（`--list` 里标了 `restorable` 的那条才可恢复，`--dry-run` 的判断与实际执行一致）。恢复只撤销 Connect 写入的字段，之后你自己加的配置不受影响；恢复 `switch` 时会为上一个目标重新签发凭据。文件在应用之后被改过时，恢复会以 `CONFLICT` 拒绝而不是覆盖你的改动。

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
apexnova run opencode --gateway --deployment deployment.apexnova.xxx
apexnova audit --limit 1      # 看逐请求归属
```

它**只转发，不做选择**：不替你换模型、不重试（一个可能已经执行过工具调用的请求不能由我们替 Agent 重放）、不缓冲流式响应、只换 origin 而保留路径。正确性标准是「Agent 察觉不到它在那里」。

**为什么默认关闭**：转为默认的三条门槛还差最后一条——一次真实的长交互会话。前两条（跨过凭据到期的实跑、Claude Code 端到端）在被真正执行时各揪出了缺陷，所以这条不打算跳过。见 [ADR 0020](decisions/0020-gateway-batch-closure.md)。

## 路由审计

每次「连接目标的确定」都写一条不可变记录，回答三句话：**选了哪个 Deployment、依据是什么、实际由谁计费**。

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
apexnova compatibility run opencode --deployment glm-5.2          # 只看估价，不发请求
apexnova compatibility run opencode --deployment glm-5.2 --yes    # 批准后真跑
```

一次运行发八个请求、其中六个计费，跑完按 requestId 与 Hub 用量对账。估价超过本地上限（默认 `0.05`）会直接拒绝，确实要跑更贵的模型时用 `--budget` 显式抬高。测试用的 runtime credential 只作用于被测 Deployment，跑完立即撤销。

采集时可以顺便录一份，之后离线回放：

```bash
apexnova compatibility run opencode --deployment glm-5.2 --yes --record run.json
apexnova compatibility replay run.json      # 不花钱、不需要凭据、不写证据
```

回放说明的是套件对那批响应的判定，不是模型现在的行为，所以它不会生成证据。录制里不含凭据，请求头一概不记录。

查看本地已采集的兼容性证据说明了什么：

```bash
apexnova compatibility explain                 # 所有 Agent
apexnova compatibility explain opencode        # 单个 Agent
apexnova compatibility explain opencode --deployment <id>
```

这条命令完全离线：只读本地证据，不调用 Hub，不花钱。结果按「Agent 版本 + Integration 版本 + Deployment + 协议 + 平台」分组，任一项不同都算另一个问题——升级 Agent 之后旧证据不会顺延，命令会直接告诉你它不适用于当前安装的版本。

过期的证据不会被删除，而是标记为 stale 并继续显示，因为它正是某项能力显示为 `unknown` 的原因。短时效的能力（流式、Tool Call）30 天过期，协议静态字段 90 天。

到期要重跑时：

```bash
apexnova compatibility refresh --within 30        # 只看计划和总估价，不发请求
apexnova compatibility refresh --within 30 --yes  # 批准后逐个重采
```

它会列出哪些 subject 到期、各自估价多少，以及哪些重采不了（Agent 没装、Deployment 下架了）。重采不会覆盖旧记录——新证据按时间序胜出，旧的留在库里。

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
