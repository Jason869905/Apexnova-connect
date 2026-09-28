# 0040 推荐永远给出一张排序表，隐私合规随 Hub 收回的接口一起删除

- 状态：已接受
- 日期：2026-09-28
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0007](0007-m4-scope-and-recommendation-path.md)、[ADR 0010](0010-m4-constraint-exit-condition-status.md)、[ADR 0014](0014-data-handling-attributes-belong-to-m5.md)、[ADR 0039](0039-connect-only-has-models.md)
- 结论：`recommend` 无论如何返回一张排序模型列表；缺证据时退回 Hub 的目录顺序，只剔除被证明不兼容的模型；`--exclude-publisher` 与 `privacy` 分项删除

## 1. 问题：一个只在实验室里成立的推荐

[ADR 0007](0007-m4-scope-and-recommendation-path.md) 定下的规则是「硬约束是过滤不是扣分」，其中一条是：**没有当前平台的实时证据 → `eligible: false`，不参与排序**。这条规则在「必需能力实测失败」上是对的，在「没人测过」上是错的，而两者当时用的是同一个出口。

后果可以逐条核：

| 情形 | 旧行为 | 用户看到的 |
| --- | --- | --- |
| macOS（无实机，一条证据都没有） | 全部 `eligible: false` | 空推荐 |
| 新模型进目录、还没采集 | `eligible: false` | 不存在 |
| 46 个 Model，8 条 subject 有证据 | 只排得出个位数 | 「这就是全部」 |

**「谁都别用」不是一个答案。** 用户问的是「这些模型里我该用哪个」，这个问题**仅凭目录就能部分回答**——Hub 的模型广场本来就是一个有意义的顺序，价格和上下文窗口也都在目录里。证据缺失改变的不是「能不能回答」，而是「这个回答值多少」。旧实现把后者当成了前者。

## 2. 决策：三件事移出排序表，其余一律在表内

只有目录或证据**正面说出来**的事实能把一个 Model 移出排序表：

1. Agent 不会说它的任何协议；
2. 目录报它不在服务（`maintenance` / `unavailable`）；
3. 它在本轮 `--max-price` 之外——包括目录不给价格因而证明不了它在上限之内（[ADR 0010](0010-m4-constraint-exit-condition-status.md) 决策 2 不变）；
4. 证据显示**某条 required 能力实测失败**。

第 4 条是证据唯一还能排除一个 Model 的情形。**没测过、测得不全，都不再是排除理由**，它们改为决定顺序：

- `basis: "evidence"` —— required 全过、有当前平台的实时证据，按 `coding.v1` 计分，排在前面；
- `basis: "catalog-order"` —— 没有可用证据，**保留 Hub 目录给它的位置**，不计分（`score` 缺席，不是 0）。

两段之内同分一律按**目录顺序**打平——此前的打平键是 modelId 字典序，那是一个连 Hub 顺序都不肯用的排法。代价是：同一批候选换一个目录顺序会得到不同的文档 id。这是对的，`catalogVersion` 本来就在文档里。

**平台规则不变。** Linux 上的结论仍然不适用于 Windows，不会被借用；变的只是「借不到」的后果——从「排不出来」变成「按目录顺序排，并在警告里说去哪采集」。

## 3. 「没测过」不会被打扮成「测过了」

M3 的那条底线（**绝不把未测显示为支持**）在本记录下仍然成立，靠的是两样东西：

- `basis` 逐个 Model 说明它的位置从哪来，人读的输出里那一行理由写的就是 "not tested yet, so it holds Hub's catalog order"；
- **不给默认分**。按目录顺序排的 Model `score` 缺席，而不是取中位数或零——一个默认分就是「没测过」穿着「中等」的衣服进排序，[ADR 0007](0007-m4-scope-and-recommendation-path.md) 拒绝过它，这里同样拒绝。

因此「某个分项在所有候选上都没有数据就整项丢弃」这条规则，看的集合从「所有 eligible」改为「所有被计分的」：按目录顺序排的 Model 本来就不在任何分项上计分，它有没有价格说明不了 `cost` 能不能给其余的排序。

## 4. 输出简化：六列，一行一个 Model

此前每个候选占五到七行（分数、置信度、协议、model id、逐个分项的分数×权重与依据文字、证据 id 列表），46 个 Model 就是两百多行。**排序本身反而看不见了。**

现在人读的输出是一张表：名次、`--model` 认的那个别名、发布方、混合单价、评分、一句理由。逐分项的数字、权重与证据 id 全部留在 `--json` 文档里——那才是要复算这份排序的人读的东西。

`recommendation.schema.json` 随之升到 `0.3`：

- 候选新增 `publisher`、`pricePerMillion`、`currency`、`displayName`、`basis`。**发布方与价格此前只在目录里**，读一份排序还得把目录摆在旁边；
- `unmeasured` 提到文档顶层。此前它被复制进**每一个**候选的 `reasons`——46 个 Model 各抄一遍同样几句话——只因为 `reasons` 是 `additionalProperties: false` 之下唯一活下来的字段。

## 5. 隐私合规删除，连同 Hub 收回的那个接口

`--exclude-publisher` 与 `privacy` 分项**一并删除**，不保留别名、不打提示。

[ADR 0014](0014-data-handling-attributes-belong-to-m5.md) 把隐私约束移到 M5 时，理由是「Connect 侧该建的已经建好了，缺的只有一个上游字段」——即需求 12J 的数据处理属性。**那个字段不会来了：Hub 已经收回该接口。** 推迟的理由在 [ADR 0022](0022-m5-midpoint-review.md) 就已经用掉过一次，这次的处置是撤销而不是第四次顺延。

留着那一半会更糟。ADR 0014 自己写过，`--exclude-publisher` 与数据处理约束「在文案上不得合并成隐私」——**而一个叫「隐私约束」的功能只实现了按发布方过滤，就是那次合并本身**。它回答不了「请求经过谁的手」，却会让设过它的人以为合规要求已经满足。

**发布方本身保留**，作为排序输出里的 `PROVIDER` 一列——DeepSeek、MiniMax、Zhipu AI。它回答的是「这是谁的模型」，那是一个目录答得上的问题，也是用户真正在看的那个。

## 6. 破坏性

- `--exclude-publisher` 不再是一个选项，落到 `INVALID_ARGUMENT`；
- Recommendation schema 升到 `0.3`，候选与顶层都有新字段。**同一批输入算出的文档 id 与 `0.2` 不同**，本来就该不同；
- `unmeasured` 不再出现在候选的 `reasons` 里，改读顶层同名字段；
- `NO_ELIGIBLE_DEPLOYMENT` 改名为 `NO_ELIGIBLE_MODEL`（[ADR 0039](0039-connect-only-has-models.md) 的收尾），且**只在四条排除规则把所有 Model 都清空时**才可能出现——`connect --best` / `switch --best` 不再因为「没采集过证据」而失败；
- Scenario 的 `priorities` 不再接受 `privacy`，`scenario-profile.schema.json` 的枚举同步删除。
