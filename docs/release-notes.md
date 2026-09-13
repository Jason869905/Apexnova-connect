# Release Notes

按版本倒序。每条写明**包含什么**与**不包含什么**——后者同样是发布的一部分。

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
