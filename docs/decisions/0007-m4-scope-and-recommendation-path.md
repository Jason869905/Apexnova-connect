# 0007 M4 启动：首批 Scenario 与 Recommendation 的产出路径

- 状态：已接受
- 日期：2026-09-09
- 阶段：M4 Match Beta（目标版本 `v0.4`）

## 背景

M3 已关闭（[ADR 0006](0006-m3-closure.md)），`v0.3` 按 Compatibility Beta 成立：16 条 Evidence 在 Hub 上，公开矩阵每行可追溯到记录。

M4 要回答的问题从「能证明」变成「能推荐」：给定一个 Agent 和一件要做的事，说出该用哪个 Deployment，并且把理由、备选和排除原因摊开。数据形状在 M0 就已冻结（[`recommendation.schema.json`](../../schemas/recommendation.schema.json)、[`scenario-profile.schema.json`](../../schemas/scenario-profile.schema.json)），M4 是第一次真的产出推荐。

四个事实决定了本阶段的形状：

- **推荐的输入是 M3 的产出。** 8 条 subject 的 Verdict 已经存在，不需要为了开 M4 重新采集。
- **但那些证据全部是 `linux-x64`。** 库里 28 条记录逐条核对，平台字段无一例外。Windows 在 M2 做过现网验收，却从来没有采集过 Evidence；macOS 连机器都没有。
- **路线图给 M4 的分项是「质量、成本、速度、隐私和稳定性」，其中三项今天没有证据来源。** 质量要 Scenario Quality Pack（[`compatibility-evidence.md`](../compatibility-evidence.md) 写明 M4 之后引入），速度要 Operational Evidence（M3 未采），隐私要上游 Provider 身份（目录只给不可逆指纹）。
- **M3 两次证明规模会先于结论成为瓶颈**，收窄的建议在 ADR 0005、0006 里连提两次。

## 决策

1. **首批只做一个 Scenario：`coding-general` v1。** 覆盖「让 Agent 写代码」这一件事，requirements 直接引用 M3 已有的能力 id（`agent.single-tool-call`、`protocol.streaming-order` 等），不另造一套词表。多 Scenario 在首批闭环跑通之后再加。

2. **候选只来自 Apexnova 目录，并且明确记下这使一条退出条件无法验证。** 路线图的「允许推荐非 Apexnova Provider」需要目录之外的第二个候选来源，现在没有。架构上把候选来源做成可插拔的（推荐引擎接收候选数组，不自己去拉目录），但**首批不引入第二来源，该退出条件挂账**，在 M4 中期决定是引入本地 Ollama、用户自带 endpoint，还是承认它属于 M5。像 ADR 0004 处理 Provider 标准那样：写下来，而不是假装满足。

3. **只有有证据来源的分项参与排序；没有来源的显式标为「未测量」，不给默认分。**

   | 分项 | 证据来源 | 首批 |
   | --- | --- | --- |
   | `compatibility` | M3 Evidence，subject 含平台与实现指纹 | **参与** |
   | `cost` | 目录 `pricing` + 估价响应 + 按 requestId 实测计费 | **参与** |
   | `context` | 目录 `limits.contextWindow` / `maxOutputTokens` | **参与** |
   | `availability` | 目录 `availability.status`（Hub 声明，非实测） | **参与但降级**：只作硬约束过滤，不进分数 |
   | `latency` | 需要 Operational Evidence，M3 未采 | 未测量 |
   | `quality` | 需要 Scenario Quality Pack，M4 之后引入 | 未测量 |
   | `privacy` | 需要上游 Provider 身份；目录只给不可逆指纹 | 未测量（单一 Provider 目录下无法区分） |

   给未测量的分项一个默认分，等于把「没测过」显示成「中等」——这与 M3 全程守的那条规则（不得把未测试显示成支持）是同一条。**Recommendation 必须列出未测量的分项**，schema 的 `reasons` 承载它。

4. **硬约束是过滤，不是扣分。** required 能力实测 `unsupported` → `eligible: false` 加排除理由，不参与排序；`unknown` 不得算作通过。语义直接复用 M3 的 `computeVerdict`，不重写第二套判定。**不允许用总分掩盖必需能力的失败**，加断言测试。

5. **平台是硬约束的一部分，且当前只有一个平台有证据。** Evidence 的 subject 含 `platform`（M3 的 subject 身份决定），因此 `recommend` 在当前平台没有证据时**必须显式说「该平台无证据」，不得借用其他平台的结论**——那正是把指纹放进 subject 要防的同一类静默失真。

   首批因此只有 `linux-x64` 有支撑。**补 Windows 采集列为 M4 第一批任务**：8 条 subject、机器现成（M2 在 Windows 11 上做过现网验收）、按今日单价约 `0.012 USD`。macOS 仍无机器，按 ADR 0006 挂在未决依赖上，`recommend` 在该平台如实返回无证据。

6. **可重复性由记录版本加确定性排序保证。** 每条 Recommendation 记录 `catalogVersion`、`ruleVersion`、Scenario 的 `profileVersion` 与逐项 `evidenceRefs`；排序必须确定——同分时按 `deploymentId` 字典序兜底，不依赖目录返回顺序或 `Map` 迭代顺序。契约测试对同一输入跑两次并断言输出逐字节相同。这是退出条件「相同输入和规则版本产生可重复结果」的实现方式，而不是一句承诺。

7. **本地先行、后同步。** CLI `recommend` 完全本地计算：读本地 Evidence 库、目录快照和 Scenario Pack。Hub 托管 Recommendation API 推迟到本地闭环跑通之后再谈。M3 验证过这条路径——全程没有被 Hub 阻塞，而给 Hub 的接口需求是由真实产出反推的，不是凭空设计的契约。

8. **`sponsored` 首批恒为 `false`，且不参与排序。** 商业推广标记只作展示。退出条件「不存在隐藏商业评分项」由一条断言测试保证：打分函数的输入里没有 `sponsored`。

## 后果

- 交付形状是 `packages/recommendation`（Scenario Pack + 打分规则 + 版本化）加 CLI `recommend`，与 `packages/capabilities` 对称；推荐引擎不 import 目录客户端，候选与证据都由调用方注入；
- 首批的推荐只在 `linux-x64` 上有支撑，这一点会出现在每一条 Recommendation 上，而不是只写在文档里；
- 三个未测量分项使首批的排序实际上由 compatibility、cost 与 context 决定。这是诚实的窄，不是完整的宽——`recommend` 的输出必须让人一眼看出这一点；
- 「允许推荐非 Apexnova Provider」这条退出条件在首批不可验证，M4 收口时若仍未引入第二来源，按 ADR 0006 的做法如实记为未满足，不降低要求。

## 被否决的选项

- **给未测量的分项一个默认分或用目录声明代替实测。** 那会让 `quality` 和 `latency` 凭空产生排序影响，且目录声明在 M3 已经被证伪过一次（4 个 Deployment 都声明 `structured-output.json`，实测全部不通过）。
- **等 macOS 机器到位再开 M4。** M2 遗留至今，M3 也没有等它。挂账并如实呈现比停摆更好。
- **先做 Scenario Quality 评测。** 它是 M4 之后的范围，而且没有可重复的评分方法之前，质量分只会是一个看起来精确的意见。
- **先做 Hub 托管 Recommendation API。** 与决策 7 相反的顺序在 M3 已经被验证是错的。
