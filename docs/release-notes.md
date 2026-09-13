# Release Notes

按版本倒序。每条写明**包含什么**与**不包含什么**——后者同样是发布的一部分。

## v0.6.1 — 2026-09-13

**`detect` 的 warning 不再打印两遍。** 只有这一条。

### 修复

v0.6.0 开始在非 `--json` 模式下回显命令的 warnings。`doctor` 当时就声明了 `humanIncludesWarnings` 跳过这层回显——它的 warning 本来就是它自己打印的那几行——而 `detect` 是同样的形状却没声明:它把每条 warning 挂在对应 Agent 下面打印,于是通用回显又把整份列表说了一遍,而且脱离了它所属的那个 Agent。

`executeDetect` 带显式返回类型标注而 `executeDoctor` 没有,所以漏掉这个字段是类型错误而非静默遗漏——但 `vitest` 只转译不检查,是 `tsc` 才报出来的。

### 不包含

- **没有改变检测逻辑**。找 Agent 仍然只解析 `$PATH`:那解析到的就是你在同一个 shell 里敲命令时会跑的那一份,这个性质是刻意保留的;
- **没有改变安装脚本**。`~/.local/bin` 不在 `PATH` 上时仍然只打印提示。

## v0.6.0 — 2026-09-13

**Linux 不再需要 keyring。** 凭证默认存进一个 0600 文件，装完 CLI 直接 `login` 即可——不需要 `libsecret-tools`、不需要 D-Bus、不需要 sudo。初始化流程从五步降到三步：装 → login → run。

### 为什么改

旧默认要求 Secret Service：装 `secret-tool`，并有 keyring daemon 挂在 D-Bus 上。桌面发行版满足，而本 CLI 真正在跑的地方——容器、CI runner、headless SSH、WSL——**四类里没有一类默认满足**。于是「默认」在多数机器上的实际形态是五条命令、两条 sudo，而且失败发生在**用户已经批准设备授权之后**。坚持它换来的保护是 0：那些机器上根本没有 keyring 可以保护任何东西。判定与取舍见 [ADR 0035](decisions/0035-explicit-file-credential-backend.md)、[ADR 0036](decisions/0036-file-backend-becomes-the-linux-default.md)。

### 新增

- **凭证文件后端**（0700 目录 + 0600 文件）。Linux 默认；Windows 仍是 Credential Manager，它在每个会话里都在、已验收过，拿它换便利是纯亏；
- **`apexnova init --credential-store system|file`** 与 **`APEXNOVA_CREDENTIAL_STORE`**（环境变量优先级更高），两个方向都能切；
- **`doctor` 新增 `credential-protection` 检查**：用文件后端时固定输出一条警告，并说明怎么切回 `system`。

### 必须说清楚的代价

**这个文件只靠文件权限保护秘密**，没有操作系统加密在背后。headless 机器上没有可派生密钥的操作系统秘密，任何"加密"都得把密钥放在密文旁边——那是混淆，不是保护，所以这里不提供那个假象。三条配套边界：权限被放宽（如 0644）时**拒绝读取**并要求吊销，而不是 `chmod` 修好把暴露事件藏起来；文件解析失败时**不重写**；写入走同目录临时文件 + rename，并用锁文件挡住另一个进程的并发读—改—写。

### 没有改变的规则

**默认不是回退。** 点名了 `system` 而 keyring 不应答时，命令照样报 `BACKEND_UNAVAILABLE` 并停下，绝不改写到文件。秘密在两个后端之间悄悄搬家，会让一台机器一半凭证在这边、一半在那边，而用户对此一无所知。

### 修复

- **非 `--json` 模式下命令的 warnings 被整个丢弃**，只打印结果。环境变量覆盖了刚写的配置文件、凭证后端没有操作系统保护——这类提醒此前只有 `--json` 消费者看得到。现在它们打到 stderr（`Warning: ...`），stdout 只留结果，管道不受影响。

### 升级影响

**Linux 用户从 v0.5.2 升上来会表现为「没登录」**：旧凭证在 keyring 里，新默认读文件。重新 `apexnova login` 即可，或 `apexnova init --credential-store system` 继续用 keyring。**不做自动迁移**——迁移要么把秘密复制到保护更弱的地方而没问过用户，要么按探测决定用哪个后端（回到「一半一半」）。要做也该是显式的命令，不是一次静默的读写。

### 不包含

- **不自动安装 Agent**：`run` 找不到可执行文件仍返回 `AGENT_NOT_FOUND`，OpenCode / Codex / Claude Code / Hermes 要自己装；
- **安装脚本不碰系统包**：不 `sudo apt-get`，不起 keyring daemon；
- **Gateway 仍默认关闭**，最后一条门槛还是一次真实的长交互会话。

## v0.5.2 — 2026-09-13

**四个 Agent Integration 全部升为 `stable`**，M5 的「三个首批 Integration 达到 stable」退出条件因此满足。判定标准见 [ADR 0023](decisions/0023-integration-status-ladder.md)：两条可机检、三条人工逐条判定。

**四次判定揪出四件事，没有一件是测试发现的。**

### 修复

- **Windows 上报告的版本与实际运行的二进制不是同一个。** 三个 Windows 启动器都只接受 `<名字>.exe`（`.cmd` 无法以 `shell: false` 启动，本项目不用 shell），而共享探针**明确去跑 `.cmd`**。一台同时装有 npm 版与原生版 Claude Code 的机器上，检测报 2.1.233、启动的是 2.1.201。探针现在取 `where.exe` 结果里的 `.exe`。**一处修改，三个 Integration 同时受益。** 它能活这么久，是因为探针测试全部走注入桩，`defaultProbe` 的 Windows 分支一行未测；
- **npm 安装的 Codex 在 Windows 上根本无法启动。** npm 只把 `codex.cmd` 放上 PATH，真正的二进制藏在平台子包里。解析器现在会找到它（`opencode` 的解析器一直认识自己的 npm 布局，`codex` 没有）。**用最常见方式安装 Codex 的 Windows 用户，此前 `run codex` 直接失败**；
- **`claude-code` / `codex` 找不到 `.exe` 时的拒绝消息只说缺什么，没说怎么办。** 现在写明：装原生版，或把 `.exe` 所在目录排到 npm shim 之前。

### 文档修正

- **`opencode` 的 README 停在 M1**，写着「尚未通过 CLI 对用户配置开放」「manifest 继续保持 `planned`」，[新增 Integration 指南](adding-an-integration.md)第 7 节要求的小节一个都没有。已重写；
- **`hermes` 的 README 声称一个它已不支持的协议**（`openai-responses`，M5 期间被证明不成立后已从 manifest 移除）；
- **两份 README 的「已知限制」补进了几条一直知道却没写下来的事实**，其中最要紧的两条：**Hermes 在每个请求都被拒绝时仍以退出码 0 结束**（它自己吞掉错误）；**OpenCode 自带 provider，所以「配置没被读到」不会报错**——它照常作答、退出 0，而请求走了别人的账。

### Integration 状态

| Integration | 状态 |
| --- | --- |
| `opencode` | `experimental` → **`stable`** |
| `codex` | `experimental` → **`stable`** |
| `claude-code` | `experimental` → **`stable`** |
| `hermes` | `experimental` → **`stable`** |

四个都有每个声称平台（Windows、Linux）的 `connect → run → 归属对账 → restore` 实跑记录。**macOS 不在支持范围内。**

### 仍未改变

**Gateway 默认关闭。** 转默认的三条门槛只剩最后一条——**一次真实的长交互会话**，那需要人去用，不是自动任务能替代的。

## v0.5.1 — 2026-09-13

修复版。**六个缺陷里有五个属于同一类：命令做错了事，还报告成功。** 它们都是在真实运行中撞出来的，没有一个是既有测试发现的。

### 修复

- **`--config` 对启动完全不起作用。** Connect 把配置写到指定文件，然后启动一个读**另一份**配置的 Agent。在 OpenCode 上的后果是它用自带 provider 作答、退出 0、**账记在别处**，而命令报成功。现在要么把 Agent 指向那份文件（Claude Code 用 `--settings`，Codex 用 `CODEX_HOME`），要么**拒绝启动**（OpenCode 与 Hermes 没有可用机制）。规则写进公共契约套件，新 Integration 自动受约束；
- **Agent 非零退出时，网关不关闭。** 关闭网关与取回配置只在启动成功后执行，而 Agent 非零退出会抛 `AGENT_EXITED`——于是网关继续监听、**进程永不退出**，并在 Agent 配置里留下一个已经死掉的 loopback 地址；
- **运行期续期继承了整条命令的截止时间**（默认 120 秒），因此**任何比 `--timeout` 更长的 `--gateway` 运行都无法续期**——正是唯一需要续期的那一类。同一根因还静默丢掉了长会话的计费对账；
- **轮换锁超时时报「在等另一个凭据轮换结束」，而根本没有另一个轮换**。现在只有真撞见过被持有的锁才这么说；
- **`logout` 什么都不检查。** `restore` 需要当前会话向 Hub 重新签发被回滚到的凭据，所以登出会让尚未恢复的事务**永远无法恢复**——Agent 的配置停在指向 Hub 的状态，而账号已经不在手里。现在会拒绝并点名具体事务与 Agent，`--yes` 表示知情；
- **`restore --list` 不说事务写的是哪个文件。** 用 `--config` 建的事务必须用同样的 `--config` 恢复，而列表只有 id，只能手工打开凭据去查。现在每个事务下方列出它写过的路径。

### 新增

- **`--credential-ttl <秒>`**（120～86400，默认 86400），用于 `run`／`connect`／`switch`。续期窗口随之改为**「最后一小时，或寿命的后一半，取较短者」**——固定一小时在寿命可配后会让短寿命凭据每个请求都触发续期。续期复制原有寿命，不退回 24 小时。

### 与 [ADR 0020](decisions/0020-gateway-batch-closure.md) 的三条门槛

Gateway 转默认的前两条已达成（凭据跨过到期的实跑、Claude Code 端到端）。**第三条——一次真实的长交互会话——仍未达成，`--gateway` 因此仍然默认关闭。** 上面六个缺陷里有五个正是在执行前两条时才暴露的，这本身就是坚持第三条的理由。

## v0.5.0 — 2026-09-13

**版本号为什么跳过两位。** 上一次发布是 `v0.2.1`（2026-09-07）。M3 的目标版本是 `v0.3`、于 09-09 关闭，M4 的目标版本是 `v0.4`、于 09-11 关闭——**两个里程碑都关闭了，都没有发过版**。因此本次一个发布同时带上 M3、M4 与 M5 至今的成果。与其把它悄悄编成 `0.3`，不如把这件事写出来。

本发布**不代表 M5 关闭**：M5 仍开着，目标版本仍是 `v1.0`。按 [ADR 0022](decisions/0022-m5-midpoint-review.md) 第 6 节，「可发布」与「里程碑闭环」是两件事。

### 包含

- **兼容性证据（M3）**：内容寻址、不可变的 Evidence 记录；九项能力的测试套件（`apexnova.capability-suite` 0.4.0，覆盖 `openai-responses`、`anthropic-messages`、`openai-chat-completions`）；`compatibility run/refresh/sync/revoke/replay/explain/matrix`；到期与实现指纹语义；
- **推荐（M4）**：`recommend`，Scenario `coding-general` v1，schema 校验的 Recommendation 记录，约束（模型白名单、预算、排除发布方）。**没有测量来源的分项不参与排序、不给默认分**；
- **路由审计（M5）**：`selected` / `attributed` / `released` 三类不可变记录，带依据与事后计费对账；`connect --best` 把推荐传递到连接；`apexnova audit` 读取；
- **可选本地 Gateway（M5）**：忠实转发、逐请求归属、运行期内凭据续期、只对响应头计时的超时、失败如实不重试。**默认关闭**；
- **配置事务**：备份、逆序 `restore`、内容哈希冲突检测、`restore --discard-local-changes`；
- **四个 Agent Integration**：OpenCode、Codex、Claude Code、Hermes，统一生命周期，通过公共契约测试；
- **拒绝无效开关**：命令不读取的选项一律以 `INVALID_ARGUMENT` 拒绝，而不是接受后忽略。

### 不包含

这一节和上一节同等重要。

- **Circuit Breaker**：未开始；
- **新请求边界上的受控选择**：未开始。Gateway 今天只转发，不做选择；
- **Connection Profile**：只有 schema，CLI 不接受 `--connection-profile`；
- **推荐非 Apexnova Provider**：已撤销（[ADR 0022](decisions/0022-m5-midpoint-review.md) 第 3.2 节）。候选只来自 Apexnova 目录，`recommend` 每次运行都会声明这一点；
- **隐私约束**：已撤销（[ADR 0022](decisions/0022-m5-midpoint-review.md) 第 3.1 节）。依赖 Hub 发布数据处理属性（需求 12J），在此之前**用户无法强制隐私约束**；
- **macOS**：不支持（[ADR 0024](decisions/0024-narrow-platform-claims.md)、[ADR 0027](decisions/0027-m2-exit-condition-two-platforms.md)）。Keychain 后端在代码里但**默认拒绝**，可用 `APEXNOVA_ALLOW_UNVERIFIED_MACOS=1` 显式启用，启用后一切按未验证对待。

### 使用前应当知道的限制

- **Gateway 默认关闭，且不建议设为默认。** 转默认的三个条件都未满足：凭据续期已实现但**没有一次跨过到期的实跑**；Claude Code 经 Gateway 的端到端**从未跑过**；**没有一次真实的长交互会话**（见 [ADR 0020](decisions/0020-gateway-batch-closure.md) 第 3 节）；
- **四个 Integration 全部是 `experimental`，没有一个是 `stable`。** 判定标准见 [ADR 0023](decisions/0023-integration-status-ladder.md)。`claude-code` 与 `hermes` 已满足其中可机检的两条，`opencode` 与 `codex` 各缺一格 Windows 证据；
- **至今没有任何外部用户完成过核心流程。** 这句话自 2026-09-07 的 [ADR 0003](decisions/0003-m2-milestone-review.md) 起一次未变，也没有外部实现过 Detection Integration；
- **结构化输出因协议而异。** 同一个 Deployment 的 `agent.structured-output` 在三个协议上可以给出三个不同答案，`openai-responses` 上实测四个部署全部失败（[Hub 需求 12K](apexnova-ai-hub-requirements.md)）。**不要按部署去理解这项能力**；
- **12 条历史 Evidence 无法发布**：它们用的是 id 约定之前的形式，Hub 以 `400 evidence_legacy_id` 拒收，且记录不可变，因此只能留在本地。

### 里程碑状态

| 里程碑 | 状态 |
| --- | --- |
| M1 | 已关闭 |
| M2 | 已关闭（[ADR 0028](decisions/0028-m2-closure.md)；最后一条退出条件是**被取消**而非被满足） |
| M3 | 已关闭 |
| M4 | 已关闭 |
| M5 | **进行中**。七条退出条件：四条满足、一条未满足（Integration 达到 `stable`）、两条撤销 |
