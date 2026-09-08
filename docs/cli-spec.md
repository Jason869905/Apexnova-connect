# CLI Specification

## 文档状态

- 阶段：M0
- 状态：Draft
- 命令名：`apexnova`

## 目标

CLI 是首个可审计、可脚本化宿主。它负责用户交互和编排，不直接实现第三方产品配置解析、OAuth、凭证后端或协议转换。

## 全局原则

- 默认面向人类输出，`--json` 输出版本化机器数据；
- 修改状态前必须展示 Plan 并获得明确确认；
- 非交互环境没有显式 `--yes` 时拒绝修改；
- Secret 不接受普通命令行参数，避免进入 shell history 和进程列表；
- 标准输出用于结果，标准错误用于进度、警告和诊断；
- 所有命令支持 `--profile <name>` 选择本地账号/连接配置；
- 所有网络调用显示请求 ID，但不显示 Token；
- `--verbose` 仍必须脱敏；
- 未验证、受限和不兼容是不同状态。

## 全局选项

```text
--profile <name>       本地 Profile，默认 default
--json                 输出版本化 JSON
--no-color             禁用颜色
--non-interactive      禁止任何交互提示
--yes                  接受已经输出或通过 --plan-file 指定的 Plan
--timeout <seconds>    单次网络或短操作超时；设备登录遵循设备码有效期
--verbose              输出脱敏诊断
--key <id>             使用已有 API key（opencode/usage 命令）
--rotating             使用 24h 短期 credential 而非永久 key（run/connect 命令）
--api-key-helper       让 Agent 自己取凭据（仅支持该机制的 Agent，如 Claude Code）
--from <RFC3339>       用量查询起始时间（usage 命令）
--to <RFC3339>         用量查询结束时间（usage 命令）
--granularity <g>      用量聚合粒度 hour|day|month（usage 命令）
--version
--help
```

`--yes` 不能跳过 Plan 生成、权限检查和 Verify，只能代替人工确认。高风险操作未来可以要求额外策略确认。

## 命令

### `apexnova agents`

列出本次构建注册的 Agent Integration：id、显示名、状态、支持平台、可消费协议和支持的产品版本范围。

```text
apexnova agents
apexnova agents --json
```

### `apexnova detect [agent]`

扫描已注册 Integration，返回 Agent 安装、版本、配置位置、当前连接和检测置信度。省略 agent 时检测全部已注册 Integration。

```text
apexnova detect
apexnova detect opencode --json
apexnova detect codex --config ./config.toml
```

输出符合 [`detection-result.schema.json`](../schemas/detection-result.schema.json)。`status` 区分 `installed`（可执行文件响应了版本探测）、`config-only`（只找到配置文件）、`not-found` 和 `unsupported`（版本超出 manifest 声明的范围）。`unsupported` 的 Agent 不会进入 `connect`。

默认只读。不得读取无关目录或上传本地绝对路径。

`--config <path>` 显式指定要检查的配置文件，主要用于测试、非标准安装和项目级配置。未指定时 Integration 按项目目录、XDG 目录和平台配置目录的已知候选路径只读探测。

### `apexnova inspect <agent>`

显示目标 Agent 的当前 Provider、模型、协议、Integration 状态、受管理字段和已知限制。输出符合 [`inspection-result.schema.json`](../schemas/inspection-result.schema.json)：只报告凭据引用的环境变量名，不读取也不输出其值；`status: "invalid"` 表示配置不可解析，此时 CLI 不会猜测或改写。

```text
apexnova inspect opencode
apexnova inspect claude-code
apexnova inspect codex --config ./config.toml
```

### `apexnova login`

显式发起 Apexnova AI Hub Device Authorization。UI 只展示 `user_code`、验证 URI 和有效期。

```text
apexnova login
apexnova login --profile work
```

H1 staging contract test 通过前，开发版必须显式配置 Hub base URL 和 OAuth client ID，不得内置生产默认地址。

### `apexnova logout`

默认删除本地会话并尝试服务端撤销当前设备。服务端不可用时必须说明“仅完成本地登出”。

```text
apexnova logout
apexnova logout --all-devices
```

`--all-devices` 需要服务端支持和额外确认。

### `apexnova whoami`

显示当前账号、Profile、设备和 Token 到期元数据，不显示 Token。

### `apexnova balance`

显示余额、币种、信用额度、更新时间和计费主体。

### `apexnova run <agent>`

一行命令完成连接与启动：自动选模型 → 创建 key → 写配置 → 启动目标 Agent。已经连接过的 profile 直接启动，不再生成计划。

```text
apexnova run opencode
apexnova run codex --deployment <id>
apexnova run claude-code --key <keyId>
apexnova run opencode --rotating
apexnova run opencode -- --model apexnova/glm-5.2
```

`apexnova opencode` 保留为 `apexnova run opencode` 的别名，v0.1 的文档和安装脚本继续有效。

启动器要求 `detect` 结果为 `installed`：只有配置文件、没有可执行文件时返回 `AGENT_NOT_FOUND`。凭据只注入子进程环境，不进入 argv、配置文件或日志。

选项：

```text
--deployment <id>      指定模型（省略时自动选第一个；交互模式弹出上下键选择器）
--key <id>             绑定已有 API key（跳过创建，用于按工具追踪用量）
--rotating             使用 24h 短期 runtime credential 而非永久 key
-- <agent args>        透传参数给 OpenCode
```

流程：`detect → resolve deployment → ensure key → plan → apply → launch`。

`ensure key` 行为：默认 `POST /v1/api-keys` 创建永久 `sk-` key；`--rotating` 创建 24h `anrt_`；`--key <id>` 验证存在并提示输入 secret。已有配置时跳过 plan/apply 直接 launch。永久 key 不过期无需续期；`--rotating` 剩余不足 1 小时时自动续期。

### `apexnova credential print <agent>`

把某个 Agent 当前绑定的凭据打到标准输出，**除凭据本身外不输出任何内容**（Claude Code 等产品的 credential helper 要求如此）。短期 credential 剩余不足一小时时先续期再输出。

```text
apexnova credential print claude-code --profile default
```

该命令只服务于 `--api-key-helper` 写入的 helper 配置。它不接受 `--json`，没有绑定凭据时以退出码 3 失败。凭据本身存放在同一用户可读的系统凭证库中，因此这个命令不引入新的暴露面；但它的输出不应被重定向进文件或日志。

### `apexnova models`

查询 Model 与 Deployment 目录。交互模式下列出模型，上下键选择并回车切换。

```text
apexnova models
apexnova models --agent opencode
apexnova models --protocol openai-responses
apexnova models --compatible-only
```

`--compatible-only` 只隐藏明确不兼容项；未验证项必须单独标记，不能当作兼容。交互模式（TTY + 非 `--json` + 非 `--non-interactive`）：上下键选择，回车切换（创建 key + 更新配置），Esc 取消。

### `apexnova usage`

查询用量，支持按 key、时间、模型过滤和聚合。

```text
apexnova usage
apexnova usage --key <keyId>
apexnova usage --granularity day
apexnova usage --key <keyId> --from 2026-09-01T00:00:00Z --to 2026-09-07T00:00:001Z --granularity day
```

+D
```

选项：`--key <id>`、`--from <RFC3339>`、`--to <RFC3339>`、`--granularity hour|day|month`。

查询 Model 与 Deployment 目录。

```text
apexnova models
apexnova models --agent opencode
apexnova models --protocol openai-responses
apexnova models --compatible-only
```

`--compatible-only` 只隐藏明确不兼容项；未验证项必须单独标记，不能当作兼容。

### `apexnova connect <agent>`

生成并可选执行 ConnectionProfile 对应的 Change Plan。

```text
apexnova connect opencode --deployment apexnova/model-x --dry-run
apexnova connect codex --deployment apexnova/model-x --yes
apexnova connect opencode --connection-profile coding-fast
```

选项：

```text
--deployment <id>
--connection-profile <name>
--protocol <id>
--gateway auto|on|off
--dry-run
--plan-file <path>
```

流程固定为：

```text
detect → inspect → resolve credentialRef → plan → approve → backup → apply → verify
                                                               │
                                                              └─ failure → rollback
```

`--dry-run` 永不签发凭证或写文件。经 Hub H1 官方 mock contract 后，`--yes` 已开放事务化写入：先签发短期 runtime credential，再应用配置并验证；失败会 rollback 并撤销新凭证。

### `apexnova verify <agent>`

验证当前配置、凭证引用、Endpoint、模型映射和最小协议行为。默认不执行会产生费用的测试；可能产生费用的验证必须展示非约束估价与估价假设。

默认只做配置验证。`--live` 会先以固定的 `64 input + 256 output tokens` 假设调用 Hub 估价接口，不发送推理请求；只有显式追加 `--yes` 才使用已保存的 runtime credential 发起一次最小真实请求：

```text
apexnova verify opencode --live
# 展示非约束 estimate 及其假设后退出，不产生推理费用

apexnova verify opencode --live --yes
# 执行真实请求，并验证 Request ID、Provider、requested/resolved model 与 Deployment 响应头
```

`verify` 不接受明文密钥，也不输出响应正文、Prompt 或源码。

Hub 的 estimate 明确不是锁价或消费上限。推理模型可能产生额外 reasoning token；在 Hub 提供请求级硬消费上限前，CLI 不得把估价描述成“最多扣费”。

### Runtime credential 预续期

`apexnova run opencode` 会在启动 Agent 前检查 runtime credential。剩余有效期不超过一小时时，在 profile 级跨进程锁内执行：重新读取绑定 → 签发新凭据 → 通过控制面列表确认 active 与授权范围 → 原子保存 → 撤销旧凭据。并发启动只允许一个进程续期；新凭据验证或保存失败时保留旧绑定，并 best-effort 撤销新凭据。

M1 不承诺 Agent 进程启动后的热更新；超长会话的无感轮换需要后续本地 Gateway。

### `apexnova switch <agent>`

切换到已存在 ConnectionProfile 或 Deployment，仍必须生成 Plan。

```text
apexnova switch opencode --connection-profile coding-cheap
```

首版只提供显式切换，不承诺当前 Agent 会话内热切换。

### `apexnova restore [transaction-id]`

列出或执行恢复。

```text
apexnova restore --list
apexnova restore <transaction-id> --dry-run
apexnova restore <transaction-id>
```

恢复只撤销 Connect 管理的变更，并执行并发哈希检查。恢复必须按事务逆序执行；尝试跳过较新的切换事务会返回 `RESTORE_ORDER_CONFLICT`，不修改配置或凭据。

顺序的判定来源是备份目录本身：同一 integration 中只有最新的事务可恢复，`restore --list` 会标出它，`--dry-run` 走同一检查。凭据绑定只承载凭据链，不参与顺序判定——绑定指向别的事务时（旧版本可能留下这种状态）配置照样恢复，CLI 撤销当前凭据、删除绑定并以警告说明该 profile 已断开，需要重新 `connect`。

恢复一次 `switch` 时，凭据库只保存上一个 Deployment/协议及事务链，不保存已撤销的旧 secret。CLI 会先为上一个目标签发并通过控制面确认一枚新 runtime credential，再回滚配置、原子保存新绑定并撤销当前凭据。恢复最初的 `connect` 则回到连接前配置、撤销当前凭据并删除本地绑定。若新凭据签发或验证失败，文件保持不变；若配置已经恢复但绑定保存失败，CLI 撤销相关凭据并进入安全断开状态。

### `apexnova compatibility run <agent>`

对一个 Deployment 运行首批能力测试套件，产出一条不可变的本地 Evidence。**会真实计费。**

```text
apexnova compatibility run opencode --deployment <id>
apexnova compatibility run opencode --deployment <id> --yes
apexnova compatibility run opencode --deployment <id> --budget 0.20 --yes
```

一次运行发七个请求，其中五个进入推理面计费（另外两个是被拒的无效凭据与无效请求）。流程：

1. 探测本机 Agent 版本——Evidence 必须写明它是对哪个版本采集的，取不到版本就拒绝运行；
2. 向 Hub 取估价。估价高于本地上限（默认 `0.05`，用 `--budget` 显式抬高）时返回 `BUDGET_EXCEEDED` 并且不发任何请求；
3. 没有 `--yes` 时返回 `APPROVAL_REQUIRED`，附估价、Deployment、协议和将测的能力清单，不签发凭据、不发请求；
4. 签发只作用于该 Deployment 与协议的 runtime credential，跑完（无论成败）立即撤销；
5. 按 requestId 向 Hub 核对真实扣费，未结算的请求以警告列出；
6. 写入 Evidence 并给出当前 Verdict。

首批支持 `openai-responses` 与 `anthropic-messages`；其他协议返回 `PROTOCOL_NOT_SUPPORTED`。任何一项能力失败都是 Evidence 里的一条结论，不是命令失败。

### `apexnova compatibility replay <recording>`

对一份录制回放能力套件。不调用 Hub、不需要凭据、不产生任何费用，**也不写入 Evidence**。

```text
apexnova compatibility run opencode --deployment <id> --yes --record run.json
apexnova compatibility replay run.json
```

`--record` 会把该轮的真实交互写成可回放的录制：请求头一律不记录（凭据在那里），响应头只保留探针会读的白名单字段，响应体与保留的头都经过与 Evidence 相同的脱敏。

回放报告的是**套件对这些响应的判定**，不是该 Deployment 当下的行为，因此它不产出 Evidence——Evidence 只来自真实运行。录制里缺少某个请求时命令直接报 `RECORDING_INCOMPLETE` 而不是把缺口记成失败：用陈旧的录制生成「结论」正是必须避免的事。录制的套件版本与当前构建不同时会给出警告。

### `apexnova compatibility matrix`

把本地证据渲染成公开的兼容性矩阵（Markdown）。只读，不调用 Hub。

```text
apexnova compatibility matrix
apexnova compatibility matrix --agent opencode --deployment <id> --protocol <id>
apexnova compatibility matrix > docs/compatibility-matrix.md
```

矩阵按 subject 逐行给出 Verdict、逐项能力的支持情况和所依据的 Evidence ID——公开的结论必须能被追回到记录。厂商声明单独标为 `claimed ..., untested`，永远不计入已验证；过期证据照常显示并标注 `(expired)`，但不支撑 Verdict。

[`docs/compatibility-matrix.md`](compatibility-matrix.md) 就是这条命令的产物，不应手工编辑。

### `apexnova compatibility explain [agent]`

只读地解释本地已采集的 Compatibility Evidence。不调用 Hub，不产生计费。

```text
apexnova compatibility explain
apexnova compatibility explain opencode
apexnova compatibility explain opencode --deployment <id> --protocol <id>
```

结果按 subject 分组——Agent 与版本、Integration 与版本、Deployment、协议、平台，任一不同都是另一个问题——每组给出 Verdict（`compatible`、`partial`、`incompatible`、`unknown`）以及逐项能力的支持程度、级别和所依据的记录。

- 过期的 Evidence 仍然显示并标记为 stale：它正是「为什么是 unknown」的解释；
- 完全没有采集过时命令成功返回并说明未采集，不作为错误；
- 当前安装的 Agent 版本与 Evidence 的版本不同时，该 subject 标记为不适用于当前安装并给出警告。

采集命令 `compatibility run` 随首批能力测试套件提供，见 [ADR 0004](decisions/0004-m3-scope-and-evidence-path.md)。

### `apexnova doctor [agent]`

执行只读诊断，省略 agent 时诊断全部已注册 Integration。每项检查符合 [`diagnostic-result.schema.json`](../schemas/diagnostic-result.schema.json) 的 `checks[]` 形状：

- 运行环境和版本；
- Integration 加载；
- 配置可读性；
- 凭证后端；
- Hub 连接；
- Schema 和备份目录；
- 过期或未完成事务；
- 已知 Agent 版本兼容性。

`doctor` 不自动修复。未来的 `--fix` 必须生成独立 Plan。

### `apexnova compatibility explain`

M3 提供：

```text
apexnova compatibility explain \
  --agent opencode \
  --deployment provider/model
```

输出 Verdict、限制、Evidence、测试版本、新鲜度和未验证能力。

### `apexnova recommend`

M4 提供：

```text
apexnova recommend \
  --agent opencode \
  --scenario coding.repository-edit \
  --priority quality
```

选项包括：

- `--priority quality|cost|latency|privacy|balanced`；
- `--max-cost`；
- `--region`；
- `--provider`；
- `--model-allowlist`；
- `--verified-only`。

输出推荐、备选、排除原因、Evidence 和商业推广标记。

## JSON 输出

所有 JSON 输出使用统一信封：

```json
{
  "schemaVersion": "1",
  "command": "detect",
  "requestId": "local-or-server-request-id",
  "ok": true,
  "data": {},
  "warnings": []
}
```

失败：

```json
{
  "schemaVersion": "1",
  "command": "connect",
  "requestId": "request-id",
  "ok": false,
  "error": {
    "code": "CONFIG_CONCURRENTLY_MODIFIED",
    "message": "Target configuration changed after the plan was created.",
    "retryable": false,
    "details": {}
  }
}
```

`details` 必须经过脱敏，不能包含原始 Token、完整用户配置或未授权绝对路径。

## 退出码

| Code | 含义 |
| ---: | --- |
| 0 | 成功，包括明确的 no-op |
| 1 | 未分类运行失败 |
| 2 | 参数或 Schema 错误 |
| 3 | 未认证或认证过期 |
| 4 | 权限不足或用户拒绝 |
| 5 | Agent/Integration 未发现或不支持 |
| 6 | 配置冲突、版本未知或并发修改（含 `PRODUCT_VERSION_UNSUPPORTED`） |
| 7 | Verify 或 Compatibility 失败 |
| 8 | 网络、Provider 或 Hub 暂时不可用 |
| 9 | 余额、预算或 Rate Limit 阻止 |
| 10 | Rollback/Restore 需要人工处理 |

## 交互与自动化

- TTY 中可以显示选择器和差异；
- 非 TTY 默认等价于 `--non-interactive`；
- 自动化必须显式指定 Deployment/Profile，不允许依赖交互默认值；
- 将来允许签名 Plan 文件，但不能接受来源未知的 Plan；
- JSON 输出字段只做向后兼容增加，破坏性变更提升 Schema Version。

## 安全要求

- 禁止 `--api-key`、`--refresh-token` 等参数；
- Secret 只能来自系统凭证存储、受控标准输入或受支持的外部 Secret Provider；
- 错误栈、HTTP Body 和第三方配置输出前必须脱敏；
- 打开浏览器或二维码不包含 `device_code`；
- CLI 不自动启用 `yolo`、`bypassPermissions` 或等价权限；
- 切换和验证不自动重放带副作用的 Agent 请求。
