# 0009 Recommendation 记录 Scenario 的 profileVersion（schemaVersion 0.2）

- 状态：已接受
- 日期：2026-09-10
- 阶段：M4 Match Beta（目标版本 `v0.4`）
- 前置：[ADR 0007](0007-m4-scope-and-recommendation-path.md) 决策 6 要求每条 Recommendation 记录 `profileVersion`

## 背景

ADR 0007 决策 6 把可重复性落在四样东西上：`catalogVersion`、`ruleVersion`、Scenario 的 `profileVersion`，以及逐项 `evidenceRefs`。这是路线图那条退出条件（「相同输入和规则版本产生可重复结果」）的实现方式。

其中三样都在。`profileVersion` 从来没有出现在任何一条 Recommendation 里，因为 [`recommendation.schema.json`](../../schemas/recommendation.schema.json) 没有这个属性，而该 schema 是 `additionalProperties: false`。此前实现擅自在输出里加过字段（`platform`、`unmeasured`、候选上的 `dimensions`），也漏过 schema 必填的 `expiresAt`，且没有任何校验发现——那件事已经收口：实现改为跟随 schema，并由 ajv 在返回前把关。**跟随 schema 之后，这个缺口就再也不能靠加字段绕过去了，只能要么改 schema，要么撤回要求。**

缺口是实在的，不是形式问题。`coding-general` 的 1.0.0 与假想的 2.0.0 会有不同的 `requirements` 与不同的 `priorities` 顺序，因此是不同的排序依据；但两者产出的记录 `scenarioId` 同为 `coding-general`、`ruleVersion` 同为 `coding.v1`。**两份基于不同要求集的推荐，在文档上无法区分。** 这与 M3 把 `implementationFingerprint` 放进 Evidence subject 要防的是同一类失真，也与本阶段刚修好的 `platform`、`scenarioId` 身份缺口同源。

## 决策

1. **`recommendation.schema.json` 增加 `profileVersion`，并且是必填。** 可选会让它重新变成「想起来才写」的字段，而这条要求存在的理由正是不能忘。

2. **文档的 `schemaVersion` 从 `0.1` 提到 `0.2`。** 必须携带 profileVersion 的文档与不必携带的不是同一份契约，`schemaVersion` 这个字段存在的意义就是让读到的人分得清自己拿的是哪一份。代价接近零：Recommendation 目前不落盘、不上行，现网不存在任何一份旧文档。

3. **不撤回 ADR 0007 决策 6。** 另一条路是把「记录 profileVersion」从可重复性的定义里删掉。但那会让可重复性变成「同一个 Scenario 名字加同一个规则版本」，而这两样在 profile 改版后都不变——等于把定义改到现状上，[ADR 0008](0008-non-apexnova-candidates-belong-to-m5.md) 刚否决过同一种做法。

4. **Hub 的 H3（`POST /v1/recommendations`）按 0.2 实现。** 该接口尚未开工，因此这次变更不产生迁移成本；[需求文档](../apexnova-ai-hub-requirements.md)的 H3 一节已注明。

## 后果

- `RECOMMENDATION_SCHEMA_VERSION` 成为一个常量而不是内联字面量，与 `EVIDENCE_SCHEMA_VERSION` 对称；
- 一条测试断言删掉 `profileVersion` 的记录校验不通过，所以「必填」是被验证的，不是被声明的；
- profile 改版会改变记录的内容哈希，因此 `id` 也随之改变——同一份排行在不同 profile 下是不同文档，这正是想要的；
- 对 `additionalProperties: false` 的旧校验器而言，0.2 文档是不合法的。这次可以接受，因为不存在这样的校验器：Hub 未实现 H3，本地也不持久化任何 Recommendation。**下一次改这份 schema 时不会再有这个便利**，届时需要真正的版本协商。

## 被否决的选项

- **把 profileVersion 塞进 `constraints`。** 那个字段是自由对象，塞得进去，但它的语义是用户施加的约束，而 profile 版本是产出这份排序的规则来源。字段复用是以后要还的债。
- **把版本编进 `scenarioId`，例如 `coding-general.1.0.0`。** stableId 的模式允许，但从此没有任何地方还能拿到干净的 Scenario id，按 Scenario 聚合就得靠解析字符串。
- **写进 `summary` 或某条 `reasons` 的文本里。** 平台与分项数值确实是这么承载的，因为 schema 装不下且没有别的去处。但那是权宜，不是范本：可重复性靠的是可比较的字段，不是可阅读的句子。
