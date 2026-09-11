# Compatibility Evidence

## 文档状态

- 阶段：M0
- 状态：Draft
- 目标：定义兼容性结论、模型能力和推荐结果的证据规则

## 基本原则

兼容性不是静态标签，而是特定版本组合在特定时间和测试条件下的可重复结论。

```text
Agent + Integration + Model Deployment + Platform + Test Suite + Time
```

任何公开的 `compatible` 或 `incompatible` 都必须能够追溯到 Evidence。证据不足时返回 `unverified`。

## 证据来源

| sourceType | 含义 | 默认信任等级 |
| --- | --- | --- |
| `vendor-claimed` | Agent、模型或 Provider 官方声明 | 低，不代表实测 |
| `apexnova-verified` | Apexnova 控制的测试环境产生 | 高 |
| `community-verified` | 社区按公开测试套件提交 | 中，需签名与复现 |
| `runtime-observed` | 用户明确选择上传的脱敏运行观测 | 取决于样本量 |
| `user-reported` | 用户问题报告 | 低，等待复现 |

商业合作、赞助或 Hub 上架不能改变 Evidence 信任等级。

## 命名对照

本文用于说明语义，[`compatibility-evidence.schema.json`](../schemas/compatibility-evidence.schema.json) 是实现的权威来源。两者的枚举名尚未统一，实现按 Schema 为准：

| 本文用语 | Schema 枚举 |
| --- | --- |
| `vendor-claimed` | `provider-claim` |
| `apexnova-verified` | `official-test`（Apexnova 控制的环境）、`maintainer-test`（维护者实机） |
| `community-verified` | `community-test` |
| `runtime-observed` | `runtime-observation` |
| `compatible` | `compatible`（单次运行全部通过记为 `verified`） |
| `compatible-with-limits` | `partial` |
| `incompatible` | `incompatible` |
| `unverified` | `unknown` |

统一措辞需要 Connect/Hub 跨仓评审，在那之前不单方面改动任一侧。

## 测试类别

### Protocol Conformance

- 鉴权和 Endpoint；
- 请求与响应 Schema；
- 流式事件顺序；
- 中断与取消；
- 错误和 Rate Limit；
- 模型 ID 映射；
- 最大请求和响应限制。

### Agent Interaction

- 单 Tool Call；
- 强制 Tool 选择（能否强制指定某个 tool，与「能不能调用 tool」是两个问题）；
- 并行 Tool Call；
- Tool 参数 Schema；
- 多轮 Tool Loop；
- 结构化输出；
- Reasoning 事件；
- 图片和其他模态；
- Prompt Cache；
- 长上下文；
- 长时间流式稳定性。

### Operational

回答「用起来快不快、稳不稳」。全部由重复运行产生，**不接受任何一方的声明**——目录的 `availability.status` 是 Hub 声明，只能过滤候选，不进分数。

每条 Operational Evidence 必须随证据记下**测量条件**，否则两个数字不可比：客户端位置与网络、并发度、请求体与输出长度、时间戳。这是「区域」在本项目里唯一站得住的位置——它描述测量是在哪做的，不是 Deployment 的一个属性（见 [ADR 0012](decisions/0012-region-is-the-wrong-requirement.md)）。

| 指标 | 判定方式 | 聚合 |
| --- | --- | --- |
| 首 Token 延迟 | 请求发出到第一个内容增量的毫秒数 | p50 与 p95，**不报均值**——均值会把偶发长尾抹平 |
| 生成吞吐 | 稳态段 tokens/s，去掉首 token | p50 |
| 端到端完成时长 | 请求发出到可用结果，含多轮 tool loop | p50 与 p95 |
| 成功率 | 非 5xx、非截断、流式完整收尾的比例 | 时间窗内比例 |
| Provider 错误率 | 按类分开计：限流 / 上游 5xx / 截断 / 鉴权 | 每类各自的比例 |
| 流式中断率 | 长输出下未完整收尾的比例 | 时间窗内比例 |
| 限流行为 | 触发限流的频率，以及退避后的成功率 | 时间窗内比例 |
| 价格与计费单位一致性 | 估价、目录单价与按 requestId 实扣三者是否一致 | 每次采集逐条比对 |

两条语义与能力证据不同：

- **稳定性类指标（成功率、错误率、中断率、限流）单次运行给不出。** 它们要在一个时间窗上聚合，因此需要周期性探针而不是一次采集——这意味着一项至今没有的东西：常驻采集，以及它的持续成本；
- **延迟比能力更易变，TTL 必须明显更短。** 一条 30 天前的协议一致性结论通常仍然成立，一条 30 天前的延迟数字不构成今天的判断依据。

### Scenario Quality

M4 后引入，用于比较任务效果，**不与技术兼容性混合**——这条规则决定了它的记录在 subject 里带 `scenarioId`，与不带的记录互不作数。

| 指标 | 判定方式 |
| --- | --- |
| 任务完成率 | 固定任务集，每个任务配一个机器可判的验收器：补丁能否 apply、测试是否转绿、输出是否满足声明的 schema |
| 指令遵循 | 固定约束是否被违反：只输出 JSON、不得修改指定文件、不得超过长度上限 |
| 工具调用正确率 | 工具名是否正确、参数是否通过 schema 校验、是否调用了不该调用的工具 |
| 每任务成本 | 该任务全部请求按 requestId 实扣金额之和 |
| 每任务耗时 | 端到端时长，口径与 Operational 一致 |

**两条候选指标不纳入**：「代码或输出质量」与「人工修正量」需要人工打标，不可重复、不可离线回放，过不了本文开头那条可重复性要求。等有了可重复的评分方法再谈。

**不确定性是这里的核心约束。** 同一个模型对同一个任务跑两次可能给出不同结果，而 Recommendation 要求相同输入产生可重复结果。因此：

- 质量证据的最小单位**不是一次运行，是 k 次运行**。记录必须带上 k、温度与 seed（或说明该模型不支持固定 seed），以及通过率的方差；
- **一次运行的 pass/fail 不构成证据**，不得作为一条 Scenario Quality Evidence 写入；
- 成本同理：单次运行的实扣金额不是「这个模型的每任务成本」，k 次的中位数才是。

**成本的单位在这里被纠正。** 排序此前用的是混合单价（每百万 token），它有一个洞：**输出啰嗦的模型单价低，但每完成一个任务更贵**。真正该比较的是每完成任务的实扣金额，而这个数只有跑质量包时才拿得到——因此成本与质量是同一批运行的两个产出，不该分开设计。在质量包就绪之前，单价是可用的代理，但它是代理。

**代价必须先算。** 9 项能力测试一轮约 `0.0012 USD`；质量包是 N 个任务 × k 次 × 多轮 tool loop，量级完全不同。这是它排在 M4 之后的真实原因，不是「没顾上」。

### 隐私：不产生证据

隐私的全部输入都是声明——司法辖区、是否有子处理方、数据是否用于训练、留存多久。这些测不了。

按本文「证据来源」一节的规则（`vendor-claimed` 不代表实测，声明永远到不了 `apexnova-verified`），**隐私不能进打分**：给它一个分数，等于把声明洗成测量结果。它的正确形态是**硬约束过滤加声明来源标注**——按声明过滤候选，并在输出里写明这是 Provider 声明、未经验证。

路线图把隐私与质量、成本、速度、稳定性并列为「权重」是一个类型错误。参见需求 12J 与 [ADR 0012](decisions/0012-region-is-the-wrong-requirement.md)。

## Evidence 最小字段

- `id` 和 `schemaVersion`；
- `sourceType`；
- `createdAt`、`observedAt`、`expiresAt`；
- Agent ID 和版本；
- Integration ID 和版本；
- Model Deployment ID 和服务端模型 ID；
- Provider 和区域；
- 平台和运行环境摘要；
- Test Suite ID、版本和用例 ID；
- `passed`、`failed`、`skipped` 或 `error`；
- 结构化指标；
- 脱敏失败分类和日志摘要；
- 产物摘要或内容哈希；
- 签名、提交者和 supersedes 关系；
- 明确的限制和未测试能力。

Evidence 创建后不可修改。纠错通过新 Evidence 指向 `supersedes`，不得覆盖原记录。

## Verdict 计算

### `compatible`

- Agent 的所有 required Capability 都有有效证据；
- 没有未解决的必需能力失败；
- Evidence 与当前 Agent、Integration、Deployment 和 Test Suite 版本兼容；
- Evidence 未过期。

### `compatible-with-limits`

- 核心流程可运行；
- 存在可描述、可规避的限制；
- 限制不会被 UI 隐藏；
- Recommendation 必须评估这些限制是否违反 Scenario 硬约束。

### `incompatible`

- 至少一个 required Capability 存在可复现失败；或
- 协议、认证或模型映射无法建立；或
- 官方已明确移除所需能力且实测一致。

### `unverified`

- 没有足够证据；
- Evidence 过期；
- 测试版本不再适用；
- 证据冲突且尚未解决；
- 只存在厂商声明但没有满足政策要求的实测。

## Evidence 新鲜度

过期不是删除。过期 Evidence 保留历史价值，但不能单独支撑当前 `compatible`。

默认使 Evidence 失效的事件：

- Agent 主版本或相关协议实现变化；
- Integration 解析或 Gateway 实现变化；
- Model Deployment 的模型版本、Endpoint 或 Provider 实现变化——判据是目录的 `implementationFingerprint` 与 `implementationChangedAt`：指纹进 `subject`（[需求 12B.4](apexnova-ai-hub-requirements.md)），因此换了实现就是另一个 subject，旧记录不会被读成新实现的结论；指纹回退到旧值时用 `implementationChangedAt` 判断（同一个值可能再次出现，但变更时间是新的）；
- Test Suite 的破坏性变化；
- 到达 Evidence 类型的 TTL；
- Provider 通知弃用或能力回退。

建议初始 TTL：

| Evidence | 建议 TTL |
| --- | --- |
| 静态协议字段 | 90 天 |
| Tool/Streaming 兼容性 | 30 天 |
| 线路健康与延迟 | 5～30 分钟 |
| 价格 | 24 小时或 Provider 明确有效期 |
| 场景质量评测 | 模型版本不变时 90 天 |

实际 TTL 由 Capability Definition 和 Hub 策略版本决定。

## 冲突处理

证据冲突时：

1. 不按来源名称直接覆盖；
2. 先检查模型、Deployment、区域和版本是否实际不同；
3. 比较测试套件、样本量、时间和环境；
4. 无法解释时降级为 `unverified` 或 `compatible-with-limits`；
5. 创建复现任务，不删除不利证据。

## 社区证据

社区提交必须：

- 使用发布的 Test Suite 和锁定依赖；
- 包含环境摘要和产物哈希；
- 使用提交者签名；
- 不包含 API Key、提示词私密数据或用户代码；
- 在进入 `community-verified` 前通过自动 Schema、重放和异常检测；
- 对明显商业利益关系进行披露。

社区 Evidence 默认不能单独让高风险能力达到最高置信度。

## 隐私与脱敏

默认禁止上传：

- API Key、OAuth Token、Cookie；
- 完整第三方配置；
- 用户仓库路径和文件内容；
- 用户提示词、响应和工具参数；
- 私有 Endpoint、主机名和账号 ID；
- 能还原用户环境的高基数标识。

运行观测必须 opt-in，并在客户端显示将上传的字段。公开测试使用合成 Fixture 和测试凭证。

## Recommendation 的证据要求

Recommendation 必须展示：

- 硬约束通过或失败原因；
- 使用的 Scenario 和规则版本；
- 每个分项引用的 Evidence；
- Evidence 新鲜度和置信度；
- 未验证能力；
- 备选方案；
- 是否为商业推广。

不得用一个总分掩盖必需能力失败，也不得把“未测试”显示成“支持”。

## 发布与审计

- 公共 Registry 发布不可变 Evidence 摘要和内容哈希；
- 大型日志和产物可以单独存储，并通过受时限 URL 访问；
- Hub 保存 Evidence 生成、审核、撤回和 supersede 审计；
- 撤回只影响当前使用资格，不抹除历史；
- 每次 Verdict 和 Recommendation 保存规则版本，允许以后重算。
