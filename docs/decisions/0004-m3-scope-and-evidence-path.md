# 0004 M3 启动：首批范围与 Evidence 产出路径

- 状态：已接受
- 日期：2026-09-08
- 阶段：M3 Compatibility Beta（目标版本 `v0.3`）

## 背景

M2 除 macOS 外全部退出条件已满足，`v0.2.1` 已发布，M2 遗留的 `restore` 顺序判定缺陷已在开 M3 之前修复（顺序改由备份元数据推导）。

M3 要回答的问题是「能证明」：任何公开的 `compatible` 都必须能追溯到 Evidence，证据不足时返回 `unverified`。语义在 M0 已经冻结（[`compatibility-evidence.md`](../compatibility-evidence.md)、[`compatibility-evidence.schema.json`](../../schemas/compatibility-evidence.schema.json)），M3 是第一次真的产出记录。

三个事实决定了本阶段的形状：

- 现在有 4 个 Agent 和 46 个 Deployment。按这个规模铺开，Evidence 的采集与过期管理会先于兼容性结论本身成为瓶颈（[ADR 0003](0003-m2-milestone-review.md) 的收窄建议）。
- Hub 的 Evidence 查询与版本化 Test Suite 接口目前只有需求文档，是 M3 第二大未决依赖。
- ADR 0003 已经推翻「协议维度的结论可以跨 Agent 继承」：Claude Code 的 `anthropic-messages` 直到 M2 验收才第一次被真实调用。

## 决策

1. **首批固定为 2 个 Agent × 4 个 Deployment × 8 项测试。** 采用 ADR 0003 的收窄建议，而不是路线图原定的 3 Agent × 6～10 Deployment × 8～12 项测试。跑通 Evidence 的不可变与过期语义之后再扩。

2. **首批 Agent 为 OpenCode 与 Claude Code。** 两者分别走 `openai-responses` 和 `anthropic-messages`，第一批 Evidence 因此同时覆盖两条协议族，而不是把同一条路测两遍。Codex 与 Hermes 在第二批加入。

3. **Deployment 用选择标准固定，不预先写死清单。** 现网 catalog 是活的，四个 Deployment 必须满足：

   - 至少覆盖 2 个 Provider；
   - 包含 GLM-5.2——M1 与 M2 已经对它做过真实调用并按 requestId 对过账，可以和历史记录相互印证；
   - 至少 1 个声明支持 `anthropic-messages`；
   - 至少 1 个声明支持 tool call；
   - 四个在采集时都处于 `available`。

   具体 ID 在第一次采集时固定，并写进每条 Evidence 的 `subject`，不另建一份会漂移的清单。

4. **首批八项测试如下。**

   | 测试 ID | 类别 | 判定什么 |
   | --- | --- | --- |
   | `auth.endpoint-reachable` | Protocol Conformance | runtime credential 能通过 Endpoint 鉴权；无效凭据被明确拒绝，而不是静默降级 |
   | `protocol.model-id-mapping` | Protocol Conformance | 目录里的 Deployment ID 被服务端接受，响应回显的模型与目录一致 |
   | `protocol.non-streaming` | Protocol Conformance | 最小非流式请求的响应符合协议 Schema，用量字段可用于对账 |
   | `protocol.streaming-order` | Protocol Conformance | 流式事件顺序合法并正常终止，没有截断 |
   | `protocol.cancellation` | Protocol Conformance | 客户端中断后连接关闭，Hub 侧用量与实际产出一致 |
   | `protocol.error-semantics` | Protocol Conformance | 无效请求与限流返回结构化错误和可用的 requestId |
   | `agent.single-tool-call` | Agent Interaction | 单个 tool 定义可被调用，参数符合声明的 JSON Schema |
   | `agent.structured-output` | Agent Interaction | 结构化输出遵循请求给出的 Schema |

   Prompt Cache、长上下文、图片、并行 Tool Call 和 Operational 指标（延迟、吞吐、成功率）不在首批。

5. **Evidence 本地先行，Hub 接口就绪后再同步。** CLI 采集并写入本地不可变存储（与 `backups` 同级的 `evidence/`，按内容哈希命名，只追加，纠错通过新记录的 `supersedes` 指向而不是覆盖），带 M0 定义的 TTL。这样 M3 不被跨仓依赖阻塞，而且 Hub 的接口需求由第一批真实记录反推，而不是先冻结契约再返工。

6. **Capability Definition Registry 落在新包 `packages/capabilities`。** 它持有版本化的能力定义、可运行的测试套件、Verdict 计算和过期判定；`apps/cli` 只做呈现（`compatibility run`、`compatibility explain`、`compatibility list`）。与 M2 一样，产品特有逻辑不进 `packages/core` 和 `apps/cli`。

7. **采集会真实计费，因此默认不真跑。** `compatibility run` 默认输出估价与将要发出的请求，`--yes` 才真实调用；单次运行有本地预算上限，结果按 requestId 与 Hub 用量对账。Hub 的请求级硬消费上限（`M1-HUB-01`）仍未实现，本地上限是目前唯一的护栏。

8. **声明不是证据。** 现网 catalog 里几乎每个文本 Deployment 都同时声明三种协议。测试必须验证「声明」与「真实可用」是否一致；不一致时产出 `incompatible` 或 `compatible-with-limits` 的 Evidence，不允许沿用目录声明当作结论展示。

## 修订（2026-09-08）：Provider 标准无法满足，首批四个 Deployment 已固定

第一次按决策 3 的标准去现网目录挑选时，第一条标准就落空了。

**现网 catalog 的 46 个 Deployment 全部报告同一个 `providerId`（`provider.apexnova-ai-hub`），而且 `providers` 数组是空的。** Hub 没有对外暴露上游厂商身份，所以「至少覆盖 2 个 Provider」在客户端可见的数据里根本无法验证，更无法作为挑选标准。这是 Hub 侧的缺口：同一个模型由不同上游服务时是不同的问题，Evidence 的 `subject` 却只能记下「Apexnova」，因此**同一 Deployment 换了上游，现有的 Evidence 不会因此过期**。已登记为 M3 对 Hub 的待确认项。

该标准由**模型家族**替代——它是目录里唯一可观测的多样性维度。其余标准不变。首批四个：

| Deployment | Inference alias | 目录声明的能力 | 挑它的理由 | 每轮估价 |
| --- | --- | --- | --- | --- |
| `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | `glm-5.2` | tool.calling（**不含** structured-output.json） | M1/M2 的真实调用基线，可与历史 requestId 相互印证；已采集 | `0.001820` |
| `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | `qwen3.8-flash` | tool.calling + structured-output.json | 两项都声明的正向对照，且是目录里最便宜的一个 | `0.000275` |
| `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | `deepseek-v4-pro-0813` | tool.calling + structured-output.json | 第三个家族。GLM-5.2 在 `anthropic-messages` 上的 Tool Call 502 究竟来自网关还是模型，需要跨家族才能分开 | `0.001650` |
| `deployment.apexnova.cmq4770nr0000edzis38w378a` | `glm-5.1` | 两项都**不**声明 | 负向对照：声明缺失时是否真的缺失。同家族相邻版本，顺带回答「版本变化是否改变结论」——Evidence 的过期规则正是建立在这个假设上 | `0.002641` |

`anthropic-messages` 的原生路径（Claude 家族的 `claude-fable-5-1`，或 `gpt-6-astra`）没有进首批：单轮估价 `0.039000`，是其余三个加起来的七倍，而「502 是网关还是模型」用跨家族的便宜 Deployment 已经能分开。等这个问题有了答案再决定是否值得为原生路径单独付费。

另外两处目录观察，一并留给 Hub 侧：`discountRate` 逐 Deployment 不同（GLM-5.2 是 `0.5`，上表其余为 `1`）；`providers` 数组为空但 Deployment 引用了 `provider.apexnova-ai-hub`。

## 后果

- M3 的进度不再挂在 Hub 上。代价是本地存储与未来的 Hub Evidence 接口之间需要一次同步实现，这笔成本被接受。
- 首批公共矩阵只有 2 × 4，宁可窄而可追溯。
- macOS 仍是 M2 未关闭的退出条件，首批 Evidence 只覆盖 Windows 与 Linux。平台写进 `subject`，不默认跨平台成立。
- 每条 Evidence 带 TTL（Tool/Streaming 类 30 天），重复采集的成本从第一天起就是可见的，而不是等矩阵开始过期才发现。
- 首批之后再扩 Agent 与 Deployment 时，扩的是数据量而不是语义，因为不可变、过期与冲突处理已经在 2 × 4 上跑通。

## 被否决的选项

- **等 Hub Evidence 接口就绪再动手。** 契约能一次到位，但 M3 的全部进度会挂在跨仓依赖上，而且没有真实记录时冻结的接口大概率要返工。
- **四个 Agent、6～10 个 Deployment 全铺。** 这是路线图的原定规模，ADR 0003 已经指出采集与过期管理会先于结论成为瓶颈。
- **首批选 OpenCode + Codex。** 采集环境最稳（两者都在 Windows 现网验收过），但两个都是 OpenAI 协议族，第一批 Evidence 会漏掉 `anthropic-messages`——正是 ADR 0003 证明不能靠继承的那一维。
- **把能力测试塞进 `packages/integration-testing` 的 Contract Test。** Contract Test 验的是 Integration 是否遵守发现、计划与恢复契约：离线、不花钱、失败意味着代码有问题。能力测试要真实调用、产生计费并生成 Evidence，失败往往意味着 Deployment 或协议的声明不成立。两者的失败含义不同，不能共用一套套件。
