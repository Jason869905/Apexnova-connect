# 0006 M3 收口

- 状态：已接受
- 日期：2026-09-09
- 阶段：M3 Compatibility Beta（目标版本 `v0.3`）
- 前置：[ADR 0005](0005-m3-milestone-review.md) 在 2026-09-08 评审后**不宣布关闭**，本记录记的是那两条挂起理由如何清掉的

ADR 0005 是 9 月 8 日那个时点的判断，本记录不修改它——当时确实不该关闭。这里按路线图要求的五个问题，记录一天之后的状态与依据。

## 1. 退出条件是否全部满足

| 退出条件 | 结论 | 依据 |
| --- | --- | --- |
| 每个公开 Verdict 都有可追溯 Evidence | **满足** | [兼容性矩阵](../compatibility-matrix.md)由 `compatibility matrix` 从证据生成，16 行逐行列出所依据的 Evidence ID |
| Vendor Claimed 与 Apexnova Verified 分开 | **满足** | `provider-claim` 单独入桶，永不产生 `supported`。目录的 `capabilityStatements` 现在也被解析，证据等级读得到而不是靠猜（见 [需求 12F](../apexnova-ai-hub-requirements.md)） |
| 测试可在隔离环境中重放 | **满足** | `--record` / `compatibility replay`；仓库内的真实录制已随套件 `0.3.0` 重录 |
| 模型、Provider、Integration 或 Test Suite 版本变化会使相关 Evidence 过期 | **满足**（ADR 0005 时未满足） | 见下 |
| 失败日志完成脱敏 | **满足** | 探针只记结构性描述；录制走白名单；落盘前做凭据模式检查。三处都有断言测试 |

**「Provider 变化使 Evidence 过期」是怎么补上的。** ADR 0005 判它未满足，理由是目录不暴露上游身份。Hub 上线了 `implementationFingerprint` 与 `implementationChangedAt`，Connect 这侧做了三件事：指纹进 `subject`（因而进内容哈希）、**指纹参与 subject 身份比较**、`compatibility refresh` 另按 `implementationChangedAt` 判到期。第二件是补洞：指纹此前进了内容哈希却不参与身份，换实现前后的两条记录仍会并成一行，字段等于白记。现网核对：46/46 个 Deployment 带指纹，`implementationChangedAt` 全为 `null`。

这一条现在**依赖一条契约保证**，必须写明白：Hub 书面确认「实现不变时指纹逐字节稳定」，输入只有 enabled 上游线路的四元组集合，`catalogVersion`、价格、availability、LB 权重都不进指纹。**若该保证失效，同一实现会在每次采集下生成新 subject，矩阵碎成一行一条记录**——那是契约问题，不是本地实现问题，判据见 [需求 12D.1](../apexnova-ai-hub-requirements.md)。

**范围交付物 `Hub Evidence 查询接口` 已交付。** 六个端点上线，`compatibility sync` 与 `compatibility revoke` 实现完毕。当日完成两轮真实同步，16 条记录在 Hub 上，逐条 `supportsCurrentVerdict: true`、`fingerprint.match: "match"`；套件 `0.2.0` 与 `0.3.0` 都已登记。ADR 0005 点名的两项硬前置 (b)(d) 均已验证。

**M3 因此宣布关闭**，`v0.3` 按 Compatibility Beta 发布。

未交付、明确留到后面的：图片、缓存、长上下文与并行 Tool Call（[ADR 0004](0004-m3-scope-and-evidence-path.md) 主动收窄时就推迟了）；macOS 平台的证据行（无实机，M2 遗留）；12 条早于 id 形制约定写下的本地记录永远不能上行（不可变，只能被识别）。

## 2. 哪些风险被验证或推翻

**被推翻的**

- *「查不到就是没有」*。逐 requestId 对账时，用量解析因 `promoCovered` 的 `null` 抛异常，被 `catch` 归入「还没结算」；复查脚本又只读 `data.items` 而没看信封的 `ok`，把错误信封读成「返回 0 条」。于是「我们读不出来」被当成「Hub 没写记录」，还写成了一条对 Hub 的指控。**一个查询结果，只有在能区分「没有行」和「读不了行」时才算证据**（[需求 12E.1](../apexnova-ai-hub-requirements.md)）。
- *「同一件事复现八次就是八份证据」*。上面那条在 8 轮采集里逐轮出现，当时读成「稳定行为」。实际是同一个盲点被复现了八次——**重复触发同一个缺陷不增加信息量**。
- *「自己写的测试能覆盖契约」*。两个洞在同一个白名单解析器里：`promoCovered` 的 `null` 抛异常被吞成「没数据」，`capabilityStatements` 从未被解析因而直接消失。两个都由 Hub 指出，不是我们读代码读出来的——因为单元测试的数据出自我们对契约的理解，而缺陷正是这份理解漏掉的那块。处置：Hub 的 fixtures 原样收进 `schemas/fixtures/hub/` 并喂进解析器，且**验证过这条测试是承重的**（把两个缺陷分别改回去，它分别变红）。
- *「一条能力可以顺手多测一点」*。`agent.forced-tool-choice` 从 `agent.single-tool-call` 拆出来之后，才把两个原本混在一起的原因分开：`anthropic-messages` 上 `qwen3.8-flash` 的结构化输出失败**是强制 tool 被拒的后果**，而 `openai-responses` 上四个模型全部失败是另一回事（上游忽略 `text.format.json_schema`）。合并测会得到「qwen 不能调用工具」——既错误，又把两个原因永久焊死。

**被验证的**

- **本地先行、后同步**（ADR 0004 决策 5）。M3 全程没有被 Hub 阻塞，而 12A 的接口需求是由真实记录反推出来的；Hub 一上线，同步当天跑通。
- **不可变加时间序**经得住真实使用。跨一天两批采集，8 条 subject 的 Verdict 逐条一致，没有删改任何历史；旧记录与新记录按实现分行并存。
- **过期不是删除**。9 月 8 日那批（当时目录还没有指纹）仍在矩阵里，对 `0.3.0` 新增的能力读作 `untested` 而不是 `unsupported`——缺席即未知这条在发布物上也成立。

## 3. 是否有真实用户完成核心流程

仍然只有维护者。当日在现网完成 16 轮真实采集（4 个 Deployment × 2 个 Agent，两个套件版本），合计实扣 `0.019851 USD`，全部按 requestId 对账；末尾一批**七轮全部零条未结算**——此前每轮固定一条，那正是上面那个解析缺陷。产物是 16 条上行的 Evidence、一份 16 行的公开矩阵和一份可回放的真实录制。

尚无外部用户完成该流程。这一条从 M2 起没有变化，是 M4 之前最该改变的事实。

## 4. 下一阶段的最大未决依赖

- **macOS 实机**。M2 遗留至今，仍然阻塞该平台的证据采集与 Keychain 后端验收。M4 的场景评测同样只会有 Linux/Windows 数据。
- **目录能力位的填充**。Hub 加了 `tool.choice.forced`，但存量模型无人勾选。我们已经有四个 Deployment × 两条协议的实测结论，可以反过来喂给目录，而不是等运营手工填——这是 M4「Evidence 置信度」的第一块真实输入。
- **外部用户**。见第 3 条。

## 5. 是否需要缩小而不是扩大范围

M3 期间范围没有扩大，唯一的增量是套件从 8 项加到 9 项（`agent.forced-tool-choice`），而它当场就把两个混在一起的结论分开了——**加的是分辨率，不是规模**。

进入 M4 维持 ADR 0005 的建议：Coding Scenario Pack v1 先固定 1 个 Scenario 与少量任务，跑通「可重复、可解释、有 Evidence 支撑」的闭环之后再扩。M3 两次证明了规模会先于结论成为瓶颈：11 轮里 3 轮用于纠正前面的结论，8 轮复现放大的是同一个盲点。

## 决策

1. **M3 关闭**，`v0.3` 按 Compatibility Beta 发布；路线图 M3 状态同步更新；
2. 「Provider 变化使 Evidence 过期」的满足**以 Hub 的指纹稳定性保证为前提**，该保证失效按契约问题处理；
3. 本轮两条工程约定写入长期实践：**查询结果要能区分「没有行」和「读不了行」**；**契约测试的数据必须来自契约的另一侧**（fixtures 互喂，刷新后失败按契约变更处理，不更新快照）；
4. M4 从 1 个 Scenario 起步，不因为 M3 顺利而放宽起步规模。
