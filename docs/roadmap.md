# Roadmap

## 路线原则

每个里程碑只解决一个主要问题：

```text
M0 定义清楚
M1 能连接
M2 能扩展
M3 能证明
M4 能推荐
M5 能可靠路由
M6 能跨领域复制
```

时间为小团队的相对估算，不是对外承诺。上一个里程碑没有满足退出条件时，不应通过减少验证或安全要求强行进入下一个阶段。

## M0：领域模型与产品边界冻结

预计：1～2 周。

当前状态：设计与 Schema 草案已落库，等待 Connect/Hub 跨仓评审和契约验证；评审完成前不标记为正式冻结。

交付物：

- [`product-scope.md`](product-scope.md)；
- [`domain-model.md`](domain-model.md)；
- 本路线图；
- [`cli-spec.md`](cli-spec.md)；
- [`compatibility-evidence.md`](compatibility-evidence.md)；
- [`apexnova-ai-hub-requirements.md`](apexnova-ai-hub-requirements.md)；
- Agent、Model、Provider、Deployment、Scenario、Evidence、Recommendation、Connection 和 Diagnostic Schema 草案；
- Apexnova AI Hub M1 API 契约清单；
- 开源与收费边界。

退出条件：

- Integration 与 Agent、Model、Deployment 的职责没有重叠；
- 核心模型可以表达非 Coding Agent；
- Evidence 来源、过期和冲突处理有明确语义；
- CLI 命令、错误和非交互行为已定义；
- Hub 团队能够仅依据需求文档开始 OpenAPI 设计；
- M1 不再依赖未决的产品级命名和数据边界。

## M1：Connect CLI Developer Preview

预计：4～6 周。目标版本：`v0.1`。

当前状态：M1 收口。已对齐 Hub H1 P6 OpenAPI/fixtures，并通过官方 mock、本机 Docker、Windows OpenCode CLI 1.18.29 和 Linux 现网（`api.apexnova-consulting.com`）的完整真实流程：device flow、账号、余额、目录、runtime credential、现行 Provider 配置、GLM 5.2 真实调用、requestId 精确对账、限流退避重试、事务恢复与凭据撤销。CLI 已实现 `detect/inspect/login/logout/whoami/balance/models`、`connect --dry-run`、`connect --yes`、`switch`、安全 `run opencode` launcher、配置级与显式付费 `verify --live`、启动前 runtime credential 预续期、`doctor` 和事务 `restore`。OpenCode Integration 已从 `planned` 升为 `experimental`。

首个正式目标：OpenCode。

范围：

- `detect`、`inspect`、`login`、`balance`、`models`；
- `connect --dry-run`、`connect`、`verify`、`switch`、`restore`、`doctor`；
- Apexnova AI Hub OAuth、账号、余额和模型目录；
- OpenCode 现行 `provider/npm/options` ConnectionProfile 到 Change Plan；
- 操作系统凭证引用；
- Apply、Verify、Rollback 与跨进程恢复；
- JSON 输出和规范化退出码；
- Windows、Linux 真实环境验收。

退出条件：

- 新用户可在十分钟内完成首个已验证连接；
- `--dry-run` 不修改状态；
- 密钥不进入配置、Plan、日志或命令行参数；
- 写入中断和验证失败均可恢复；
- OpenCode Integration 从 `planned` 升级到 `experimental`；
- Hub M1 Contract Test 全部通过。

依赖：

- Hub OAuth 和 scopes 冻结；
- `/me`、余额、Provider、Model、Deployment 和协议 Endpoint 可用；
- Hub 错误语义和请求 ID 可用。

## M2：Multi-Agent Alpha

预计：4～6 周。目标版本：`v0.2`。

当前状态：进行中。契约与 registry 重构已完成；四个 Integration 均已实现、通过公共 Contract Test，并在现网 Hub 完成完整生命周期验收（OpenCode/Codex/Claude Code 在 Windows，Hermes 在 Linux/WSL2；含首次真实 `anthropic-messages` 调用），记录见 [Hub 联调清单](hub-h1-integration-checklist.md)。唯一未满足的退出条件是 macOS：无实机，Keychain 后端只有 mock command runner 测试。**2026-09-13 已裁决**（[ADR 0027](decisions/0027-m2-exit-condition-two-platforms.md)）：该条改为两个平台（Windows、Linux），并同时把 macOS 凭据后端改为默认拒绝——只改文档会留下「声明说不支持、代码照常服务」这个本项目反复在抓的形状。**五条退出条件现已全部满足**（其余四条已逐条核对，见 ADR 0027 第 5 节），但**M2 的关闭是另一条独立记录**，本阶段状态在那条记录之前不改为已关闭。关闭时须一并交代 M2 期间的限制，例如「社区能够独立实现只读 Detection Integration」至今**没有外部实现走过**——它验的是路径存在，不是有人走过。

范围：

- Claude Code、Codex 和 Hermes Agent Integration；
- Agent Discovery Contract；
- DetectionResult 和 DiagnosticResult；
- Integration 公共 Contract Test；
- Community Integration 模板；
- 产品版本漂移和安全拒绝；
- ~~macOS Keychain 后端与三平台验收~~——后端已实现但**从未在真机验证**，macOS 已于 [ADR 0024](decisions/0024-narrow-platform-claims.md) 退出支持范围；该后端自 [ADR 0027](decisions/0027-m2-exit-condition-two-platforms.md) 起**默认拒绝**（`APEXNOVA_ALLOW_UNVERIFIED_MACOS=1` 可显式启用，启用后一切按未验证对待）。

Hermes Agent（Nous Research）在 M2 期间纳入范围，因此本阶段目标从三个 Agent 变为四个（含 M1 已交付的 OpenCode）。

退出条件：

- 四个 Agent 使用同一套发现、计划、验证和恢复生命周期；
- 产品特有逻辑没有进入 `packages/core` 和 `apps/cli`；
- 未知配置格式不会被猜测修改；
- 社区能够独立实现只读 Detection Integration；
- **两个平台（Windows、Linux）**的凭证和恢复流程通过真实环境测试（原为「三个平台」，2026-09-13 按 [ADR 0027](decisions/0027-m2-exit-condition-two-platforms.md) 修订：[ADR 0024](decisions/0024-narrow-platform-claims.md) 已在前一日因独立理由收窄产品的 macOS 声明，一条退出条件不应继续要求验证一个产品不再交付的平台）。

## M3：Compatibility Beta

预计：6～8 周。目标版本：`v0.3`。

当前状态：**已关闭**（2026-09-09，收口见 [ADR 0006](decisions/0006-m3-closure.md)；9 月 8 日的评审见 [ADR 0005](decisions/0005-m3-milestone-review.md)）。五条退出条件全部满足：ADR 0005 时未满足的「Provider 变化使 Evidence 过期」由目录的 `implementationFingerprint` 补上——指纹进 `subject` 并参与 subject 身份比较，`compatibility refresh` 另按 `implementationChangedAt` 判到期；`Hub Evidence 查询接口`已交付并完成真实同步。**该条以 Hub 的指纹稳定性保证为前提**，保证失效按契约问题处理。首批范围与 Evidence 产出路径见 [ADR 0004](decisions/0004-m3-scope-and-evidence-path.md)：2 个 Agent（OpenCode、Claude Code）× 4 个 Deployment × 8 项测试，Evidence 由 CLI 本地采集并写入不可变本地存储，Hub 接口就绪后再同步，因此 M3 不被跨仓依赖阻塞。

已完成：`packages/capabilities`（能力定义与版本化套件，首批 8 项、`0.3.0` 起 9 项、Evidence 的不可变本地存储与过期语义、Verdict 计算、Vendor Claimed 与 Apexnova Verified 分离）、可运行的能力测试套件（`openai-responses` 与 `anthropic-messages`，离线 fixture 测试）、`compatibility run`（估价、预算上限、按 requestId 对账）、`compatibility explain`、`compatibility matrix` 与由它生成的[兼容性矩阵](compatibility-matrix.md)；首批 4 个 Deployment 已固定并完成真实采集（记录见 [Hub 联调清单](hub-h1-integration-checklist.md)）。能力套件的运行可以 `--record` 录制并 `compatibility replay` 离线回放（仓库内保留了一份对现网 `qwen3.8-flash` 的真实录制作为回归夹具），过期后的重采集由 `compatibility refresh` 承担。`compatibility sync` 与 `compatibility revoke` 把本地证据推到 Hub 并报告服务端的派生判断（是否支撑当前 Verdict、`staleReason`、指纹是否对得上）；12A 的七条服务端缺口全部关闭，其中 (b) 推理错误响应缺 Request ID 与 (d) 用量无法区分未结算/不计费两项硬前置已在现网验证。套件 `0.3.0` 增加 `agent.forced-tool-choice`，把「能否调用工具」与「能否强制指定工具」分开，首次实测即复现了 `qwen3.8-flash` 的拒绝。未交付并明确推迟的：图片、缓存、长上下文与并行 Tool Call；macOS 平台的证据行（无实机）。

范围：

- ~~修复 `restore` 的顺序判定来源~~（M2 遗留缺陷，已在 M3 开始前修复，见下）；
- Capability Definition Registry；
- 协议、流式、Tool Call、结构化输出、图片、缓存和上下文测试；
- 不可变 Compatibility Evidence；
- Verdict 计算和 Evidence 过期；
- 静态公共兼容性矩阵；
- CLI `compatibility explain`；
- Hub Evidence 查询接口。

首批控制规模（[ADR 0004](decisions/0004-m3-scope-and-evidence-path.md) 采纳 ADR 0003 的收窄建议，原定为 3 个 Agent、6～10 个 Deployment、8～12 项测试）：

- 2 个 Agent：OpenCode（`openai-responses`）与 Claude Code（`anthropic-messages`）；
- 4 个 Model Deployment，按 ADR 0004 的标准在采集时固定；
- 8 项基础能力测试：6 项 Protocol Conformance、2 项 Agent Interaction（套件 `0.3.0` 后为 9 项，新增 `agent.forced-tool-choice`）。

### 遗留缺陷：`restore` 的顺序判定来源（已修复）

`apexnova restore` 用**凭据绑定里的 `transactionId`** 判断「这是不是最新的事务」，但磁盘状态的权威来源是备份目录本身（每个事务都记录了 `appliedAt`、`state` 和内容哈希）。两者一旦不一致，两个方向会同时被锁死：

- 较新的事务被顺序检查拒绝（`RESTORE_ORDER_CONFLICT`，因为绑定没记它）；
- 较旧的事务被内容哈希检查拒绝（`CONFLICT`，因为文件已被较新的事务改过）。

此时 CLI 没有任何出路，只能手工删除备份目录和绑定。2026-09-07 在一台开发机上真实遇到过，来源是旧版本写入配置后没有更新绑定。

现行代码在保存绑定失败时会回滚 receipt，因此不应再产生这种状态；但**判定来源本身仍然是错的**，且没有针对不一致状态的恢复路径。

修复（2026-09-08）：

- 顺序改由备份元数据推导。备份摘要新增 `restorable`，同一 integration 中只有最新的事务带这个标记；`FileConfigExecutor.rollback()` 自身也拒绝已被覆盖的事务（`ROLLBACK_ORDER_CONFLICT`），因此这条规则不依赖调用方记得什么。
- 绑定退回到只承载凭据链。绑定指向别的事务时不再拒绝恢复：配置照备份恢复，当前凭据被撤销，绑定被删除，CLI 以警告说明 profile 已断开——不一致状态因此永远有出路，不需要手工删备份目录。
- `restore --list` 标出可恢复的那条，`--dry-run` 与实际执行走同一顺序检查，预览不再与结果矛盾。
- 顺序扫描容忍读不出的兄弟备份：一份损坏的备份不会连带锁死无关事务，逐条内容哈希检查仍是最后一道防线。

退出条件：

- 每个公开 Verdict 都有可追溯 Evidence；
- Vendor Claimed 与 Apexnova Verified 分开；
- 测试可在隔离环境中重放；
- 模型、Provider、Integration 或 Test Suite 版本变化会使相关 Evidence 过期；
- 失败日志完成脱敏。

## M4：Match Beta

预计：6～8 周。目标版本：`v0.4`。

当前状态：**已关闭**（2026-09-11，收口见 [ADR 0015](decisions/0015-m4-closure.md)；两次评审见 [ADR 0011](decisions/0011-m4-milestone-review.md) 与 [ADR 0013](decisions/0013-m4-second-review.md)）。四条退出条件全部满足——约束一条在 [ADR 0014](decisions/0014-data-handling-attributes-belong-to-m5.md) 把隐私移到 M5 后变为「白名单与预算」，两项均已实现且可用（**Hub 已交付需求 12H**，46 个 Deployment 中 34 个给出真实价格，`cost` 首次真正参与排序）。ADR 0013 列的另两件也已完成：Recommendation 有效期现已计入分时价格；launcher 的静默错配定位到根因（WSL 上配置了一份安装、启动了另一份），并以归属对账、安装不一致拒绝、schema 指针三处修复收口。OpenCode 在 Linux 上**端到端跑通且无手工干预**（记录见 [Hub 联调清单](hub-h1-integration-checklist.md)）。首批范围见 [ADR 0007](decisions/0007-m4-scope-and-recommendation-path.md)。首批收窄为**一个 Scenario**（`coding-general` v1），候选只来自 Apexnova 目录，推荐在本地计算、Hub 托管 API 推迟。三个分项开工时没有证据来源——`latency`（需要 Operational Evidence）、`quality`（需要 Scenario Quality Pack，M4 之后引入）、`privacy`（发布方身份不能度量隐私强度，见 [ADR 0010](decisions/0010-m4-constraint-exit-condition-status.md) 的更正）——因此**不参与排序且显式标为未测量**，不给默认分；`cost` 已在 Hub 交付 12H 后转为真正参与排序。M3 的证据原本全部是 `linux-x64`；**Windows 采集已完成并发布**（8 条 subject，`recommend` 在 `windows-x64` 上引用的是 Windows 记录本身，记录见 [Hub 联调清单](hub-h1-integration-checklist.md)），ADR 0007 决策 5 的第一批任务已合上。macOS 仍无实机，`recommend` 在该平台如实返回无证据。「允许推荐非 Apexnova Provider」的挂账已在 2026-09-10 结清：按 [ADR 0008](decisions/0008-non-apexnova-candidates-belong-to-m5.md) 移到 M5，不在 M4 收口时记为未满足。

已完成：`packages/recommendation`（`coding-general` v1 Scenario、版本化打分规则 `coding.v1`、硬约束过滤与可解释排序）与 CLI [`recommend`](cli-spec.md)；Windows 采集的发布过程暴露并修好了两处 subject 身份缺陷——公开矩阵的能力表和 Evidence 列表不带 platform，以及 `scenarioId` 声明至今无人读写（Scenario Quality 引入后会把两个 Scenario 并成一行）。两者的根因相同：同一条身份规则曾有三份拷贝，现已收敛为 `subjectIdentity` 一处。首次消费目录价格时发现**公共目录对全部 46 个 Deployment 发布 `pricing: 0`**，与估价接口和实际计费矛盾，已作为需求 12H 提给 Hub；`recommend` 在此期间把零价判为「没有价格」，并在所有候选都无价时整项丢弃 `cost` 而不是给零分。

范围：

- Coding Scenario Pack v1；
- 硬约束过滤；
- 质量、成本、速度、隐私和稳定性权重；
- 可解释 Recommendation；
- Evidence 置信度；
- CLI `recommend`；
- Hub 托管 Recommendation API；
- 商业推广标记。

退出条件：

- 相同输入和规则版本产生可重复结果；
- 每个推荐都有分项理由、备选和排除原因；
- 用户可以强制模型白名单和预算约束；
- 不存在隐藏商业评分项。

「隐私约束」原为上一条退出条件的一项，按 [ADR 0014](decisions/0014-data-handling-attributes-belong-to-m5.md) **移到 M5**：它不是选错了对象，而是缺一个上游字段——Connect 侧的过滤路径已由 `--exclude-publisher` 证明成立，缺的是 Hub 发布可比较的数据处理属性（需求 12J，已选定形状并记为遗留）。措辞与验证标准不变，只换阶段。**代价要写明：这条退出条件原文是「模型白名单、预算、区域和隐私约束」四项，M4 收口实际验收的只有前两项**——区域被判定选错对象而移除，隐私移到 M5。

「区域」原为上一条退出条件的第三项，按 [ADR 0012](decisions/0012-region-is-the-wrong-requirement.md) **移除**——不是推迟，是这条要求选错了对象：用户想从区域得到的要么是低延迟（可直接测量），要么是数据落在某个司法辖区（属于需求 12J 的数据处理属性），中间那个不可校验的目录标签不增加信息。区域保留的唯一位置是延迟证据的测量条件。隐私因此成为该条退出条件唯一的外部依赖。

「允许推荐非 Apexnova Provider」原为本阶段退出条件，按 [ADR 0008](decisions/0008-non-apexnova-candidates-belong-to-m5.md) **移到 M5**：它真正缺的不是第二份候选列表（推荐引擎已经接收注入的候选数组），而是一条不经 Hub 签发凭据、不经 Hub 计费对账的证据采集路径——没有它，第二来源产出的候选因为没有实测证据只会一律 `eligible: false`，成为一种只能排除、不能推荐的假支持。措辞和验证标准不变，只换阶段；`recommend` 在此之前每次运行都声明候选只来自 Apexnova 目录。

## M5：Reliable Provider Routing

预计：6～8 周。目标版本：`v1.0`。

当前状态：已启动，**首批完成并评审**（2026-09-11，见 [ADR 0017](decisions/0017-m5-first-batch-review.md)；范围见 [ADR 0016](decisions/0016-m5-scope-and-first-batch.md)）。首批三个验收目标达成：路由审计（`selected` 与 `attributed` 两类不可变记录）、切换失败的三点注入验收（含变异检查）、`connect`/`switch` 输出真实 deployment 与计费凭据。**M5 不关闭**，且首批留下三个缺口：`grounds: "recommendation"` 无人写入（与 M4 的 `scenarioId` 同型）、`restore` 不写审计、没有读取审计的命令。**首批收窄为两件：显式 Provider 切换与路由审计**，不含 Gateway、Circuit Breaker、受控选择与 Team——那几项都要求 Connect 参与请求路径，而与审计语义同时做会让出问题时分不清是路由错了还是审计错了。今天没有 Gateway，一次「路由」就是一次连接目标的确定，审计要回答三句话：选了哪个 Deployment、依据是什么、实际由谁计费。首批之后已完成：`recommend → connect` 的传递（`connect --best`，让审计的 `grounds: recommendation` 不再是死字段）、`restore` 写审计、`apexnova audit` 读取命令；Gateway 的首个切片（忠实转发与逐请求归属，默认关闭）已交付并评审（[ADR 0018](decisions/0018-gateway-first-slice.md)、[ADR 0019](decisions/0019-gateway-first-slice-review.md)），四个 Integration 的 Gateway 路径已逐个验收。**Gateway 这一批已收尾**（2026-09-12，见 [ADR 0020](decisions/0020-gateway-batch-closure.md)）：ADR 0019 列的八条缺口清完六条——失败注入与超时、忠实性的强证据（能力套件对同一份回放跑两遍并逐项比对）、`path`/`durationMs` 入审计、长会话的近似、其余开关的结构性复核（命令不读的选项一律拒绝）、并发验收（含变异检查）。**剩两条：运行期内凭据不续期与 Claude Code 的 launcher**（后者环境所限）。**前者已于同日实现**（见 [ADR 0021](decisions/0021-gateway-credential-renewal.md)）：续期在请求到来时发生、同时到期的请求共用一次、失败不中断运行、归属按凭据拆分；`--gateway` 同时改为一律签发 24 小时短期凭据，因为「换凭据要改写 Agent 配置」这个理由在进程边界之后不成立。ADR 0021 同时更正了 ADR 0019/0020 的一处事实错误：`run` 默认发的是永不过期的 key，所以当时**没有任何在用路径会撞上到期**。**实跑仍未发生，转默认的条件 1 因此仍不满足。****Gateway 仍不设为默认**，转默认的条件已写成可核对的三条（凭据可续期并有一次跨过到期的实跑、Claude Code 经 Gateway 的端到端实跑、一次真实长交互会话）。**中期评审已完成**（2026-09-12，见 [ADR 0022](decisions/0022-m5-midpoint-review.md)）：七条退出条件中**四条满足、一条未满足（Integration 达到 stable）、两条撤销**（非 Apexnova 候选来源与隐私约束，理由见上）。范围里整项未动的四项如实点名：Circuit Breaker（全仓 `circuit` 零匹配）、新请求边界上的受控选择、Connection Profile（有 schema 无实现，CLI 不接受 `--connection-profile`）、Pro 与 Team。**M5 保持未关闭。** 建议顺序：先定义 stable 的判定标准并逐个 Integration 对照（它最便宜，且会把 Claude Code 未经 Gateway 实跑、macOS 自 M2 挂账等散落各处的问题逼到一处），再补 Gateway 转默认的三条，之后才是 Circuit Breaker 与受控选择。**基本功能可据此发布，但与 M5 闭环脱钩**，发布说明须写明不含哪些能力、且四个 Integration 均为 `experimental`。

范围：

- Connection Profile 和显式 Provider 切换；
- Deployment 健康、余额、区域和价格约束（「区域」按 [ADR 0012](decisions/0012-region-is-the-wrong-requirement.md) 的同一理由待重新评估，M5 规划时决定）；
- 本地 Gateway 与 Hub 路由协作；
- Circuit Breaker；
- 新请求边界上的受控选择；
- 路由审计和实际计费来源；
- 非 Apexnova 端点的证据采集路径与逐候选来源记录（[ADR 0008](decisions/0008-non-apexnova-candidates-belong-to-m5.md)）；
- Pro 高级策略和 Team 基础能力。

退出条件：

- Provider 故障不会造成工具副作用请求的自动重放；
- 每次路由可解释且可审计；
- 切换失败不会破坏 Agent 配置；
- 三个首批 Integration 达到 stable（**未满足，但判定标准已建立**：五档条件见 [ADR 0023](decisions/0023-integration-status-ladder.md)，其中可机检的两条由 `tests/integration-status.test.ts` 强制，因此这条退出条件不再可能被默认满足。按新标准四个仍全是 `experimental`：macOS 无任何证据、一次性卡住四个；`codex` 与 `hermes` 一条证据都没有；`opencode` 声称两个协议而只测过一个——**最后这条是机检当场发现的，此前无人按声称范围核对过协议维度**。**2026-09-12 已收窄并重跑采集**（[ADR 0024](decisions/0024-narrow-platform-claims.md)）：四个 manifest 去掉 `macos`，`hermes` 首次采到真实证据（linux/`anthropic-messages`，四个 Deployment）。缺口六降到五。**同日把能力套件扩到 `openai-chat-completions`**（套件 0.4.0，见 [ADR 0025](decisions/0025-capability-suite-covers-chat-completions.md)）：该协议的流式没有事件名、靠 `[DONE]` 收尾，工具调用挂在 `choices[0].message`，且有自己的结构化输出模式——三处都是实质差异，各有变异验证。`hermes` 因此补齐，**`claude-code` 与 `hermes` 机检均无缺口**。剩余四个缺口**没有一个再卡在工具上**。**2026-09-13 Linux 两格已补齐**（[ADR 0026](decisions/0026-linux-collection-completes.md)）——本机其实早已装好两个客户端，此前看到 `/mnt/c` 是非交互 shell 没走到 `.bashrc` 的 PATH 段，补上后 `detect` 给出的是 Linux 配置路径，再采集。**四个 Integration 现在两个机检无缺口（`claude-code`、`hermes`），两个各剩一格 Windows**，需要一台 Windows 机器，不能用 WSL 里 `/mnt/c` 那份代替。横比三协议还发现：结构化输出**不是部署的属性而是（部署 × 协议）的属性**，且 `openai-responses` 上四个部署全部失败，已作为观察记入 [Hub 需求 12K](apexnova-ai-hub-requirements.md)）；
- 用户始终能看到实际 Deployment 和计费主体。

~~允许推荐非 Apexnova Provider~~、~~用户可以强制隐私约束~~ 两条**已于 2026-09-12 撤销**，见 [ADR 0022](decisions/0022-m5-midpoint-review.md) 第 3 节。这是 [ADR 0016](decisions/0016-m5-scope-and-first-batch.md) 决策 5 要求的第三次决定，两条的理由分别是：**隐私约束指错了责任方**（Connect 侧已做完并验证，缺的是只有 Hub 能发布的事实，本仓库做任何工作都无法满足它）；**非 Apexnova 候选的措辞选错了对象**（推荐实现本就没有 Apexnova 特判，字面交付得到的是一律 `eligible: false` 的假支持，而诚实版本需要凭据签发、价格来源、计费归属三样底座）。

**代价照实记：撤销不等于交付。** 用户今天无法强制隐私约束，Hub 需求 12J 交付前也不会有；Connect 在可预见时间内只推荐 Apexnova 目录内候选，`recommend` 每次运行的该项声明不得去掉。两条**不留挂账**：将来要做是新的里程碑范围，从 ADR 0022 列出的前提开始，不是恢复 M5 的退出条件。

## M6：Domain Expansion

M5 后按实际需求推进，不预设固定日期。

候选 Domain Pack：

- Automation：n8n、Dify、通用工作流 Agent；
- Research：搜索、引用、长上下文和文档抽取；
- Data：结构化输出、代码执行和可重复分析；
- Voice：低延迟、流式音频和中断；
- Browser：Computer Use、视觉定位和风险控制。

每个新领域必须提供：

- 至少一个真实 Integration；
- 一个版本化 Scenario Pack；
- 可重复 Capability Test；
- 不修改核心对象即可接入的证明。

## 商业能力门槛

| 阶段 | 可开始的商业能力 |
| --- | --- |
| M1 | Hub 模型消费、统一余额和基础目录 |
| M3 | 实时健康、区域延迟、持续兼容性数据 |
| M4 | Pro 推荐、偏好、预算优化和 Match API |
| M5 | 高级路由、Team 虚拟凭证、共享目录和基础审计 |
| M6+ | 多设备 Companion、自托管 Runner 和领域专属服务 |

## 暂缓清单

以下内容在 v1.0 前不进入主线：

- 完整桌面端和手机 IDE；
- 托管云开发环境；
- 自动生产部署；
- 多 Agent 编排；
- 插件市场；
- 企业 SSO/SCIM 和专属 VPC；
- 大规模模型智力排行榜。

## 里程碑评审

每个里程碑结束时记录一份 Decision Record，至少回答：

- 退出条件是否全部满足；
- 哪些风险被验证或推翻；
- 是否有真实用户完成核心流程；
- 下一阶段的最大未决依赖；
- 是否需要缩小而不是扩大范围。
