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

- 首 Token 延迟；
- 生成吞吐；
- 成功率；
- Provider 错误率；
- 区域可用性；
- 限流行为；
- 价格和计费单位一致性。

### Scenario Quality

M4 后引入，用于比较任务效果，不与技术兼容性混合：

- 任务完成率；
- 指令遵循；
- 工具调用正确率；
- 代码或输出质量；
- 成本和耗时；
- 人工修正量。

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
