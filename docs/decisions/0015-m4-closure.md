# 0015 M4 收口

- 状态：已接受
- 日期：2026-09-11
- 阶段：M4 Match Beta（目标版本 `v0.4`）
- 前置：[ADR 0011](0011-m4-milestone-review.md) 与 [ADR 0013](0013-m4-second-review.md) 两次评审都判定不关闭
- 结论：**关闭**

ADR 0011 与 0013 是各自时点的判断，本记录不修改它们。这里记录它们列出的条件如何被逐条清掉。

## 1. 退出条件是否全部满足

| 退出条件 | 结论 | 依据 |
| --- | --- | --- |
| 相同输入和规则版本产生可重复结果 | 满足 | 确定排序（同分按 `deploymentId` 兜底）；契约测试正反两次跑并断言逐字节相同；发布文档内容寻址为 `rec.sha256.<hash>`；`catalogVersion`、`ruleVersion`、`profileVersion`（[ADR 0009](0009-recommendation-schema-carries-the-profile-version.md)）与逐项 `evidenceRefs` 全部记录 |
| 每个推荐都有分项理由、备选和排除原因 | 满足 | 每个候选给出分项、分数、权重、依据与 Evidence ID；被排除者逐条给理由；零候选时报出最大的一组排除理由及计数 |
| 用户可以强制模型白名单和预算约束 | 满足 | `--model-allowlist` 逐个对目录解析、名字不在目录里直接报错；`--max-price` 在 Hub 交付 12H 后实测在筛（`1.0` 留 2 个、`0.5` 留 1 个），价格未知者判为不通过 |
| 不存在隐藏商业评分项 | 满足 | `sponsored` 恒为 `false` 且不是打分函数的输入，由断言测试保证 |

**这条退出条件清单与 M4 开工时不同，代价已在 [ADR 0012](0012-region-is-the-wrong-requirement.md) 与 [ADR 0014](0014-data-handling-attributes-belong-to-m5.md) 中写明**：原文是「模型白名单、预算、区域和隐私约束」，区域被判定选错对象而移除，隐私移到 M5。收口验收的是前两项，这一点不藏在本记录里。

## 2. ADR 0013 列出的三件关闭条件

| 条件 | 处置 |
| --- | --- |
| Hub 交付 12J，实现运营方隐私约束 | 按 [ADR 0014](0014-data-handling-attributes-belong-to-m5.md) **移到 M5**，形状选定为数据处理属性，记为遗留 |
| 修 `expiresAt` 的价格有效期 | **已修**。目录按时段计价，Hub 给出 `priceValidUntil`；`expiresAt` 现在取「证据到期」与「每一个被实际读取过的价格的有效期」里最早的那个。实测把一条推荐的有效期从四周收到当天 22:00Z |
| launcher 错配至少定位到根因 | **已定位并修复**，见下 |

## 3. launcher 的根因与修复

根因不是协议、也不是远端目录——**是我们配置了一个安装、启动了另一个安装**。WSL 的 `$PATH` 带着 Windows 条目，`opencode` 解析到 Windows 安装，而配置写到 Linux 的 `$HOME`。Agent 于是按 Windows 用户的 provider 运行，用那里的长期 key，而每一步都报成功。

排查过程中先后给出过两条错误的根因（协议错配、远端 v2 catalog），都已在[联调清单](../hub-h1-integration-checklist.md)中作废并更正。定位靠的是让被启动的子进程自报配置，返回的 `"username"` 是 Windows 账号。

修复三段：

- **对账**：launcher 退出后按台账比对，请求若不在我们签发的凭据上则失败（`LAUNCH_ATTRIBUTION_MISMATCH`），而不是报成功。只在能证明时失败——台账为空报「未确认」；
- **拒绝**：PATH 上只找得到 `/mnt/<盘符>/` 下的安装时，`detect` 警告、launcher 拒绝。任何本机条目都会让它放行；
- **回滚**：Connect 创建配置时自己写上 OpenCode 的 schema 指针，否则 Agent 补上它会让 `restore` 以 `CONFLICT` 拒绝回滚自己创建的文件。

## 4. 是否有真实用户完成核心流程

**没有外部用户**，全部由维护者在一个账号上完成。但核心流程本身在两个平台上跑通了：

- `linux-x64`、`windows-x64` 各自有真实 Evidence，`recommend` 在各自平台引用各自的记录；
- `recommend → connect → verify --live → restore` 现网跑通；
- `switch` 链路实测，**恢复时重新签发的凭据真实可用**（此前只有契约测试覆盖）；
- **`run` launcher 端到端跑通**：真实 Agent 进程返回预期文本，模型是推荐的那一个，对账正面确认请求落在我们签发的凭据与配置的 Deployment 上，`restore` 一次收回。

**仍未合上的一条**：没有人验证过排第一的 Deployment **用起来确实更好**。那需要 Scenario Quality Pack，不属于 M4。

## 5. 下一阶段的最大未决依赖

1. **12J**（数据处理属性）——M5 的退出条件之一依赖它；
2. **非 Apexnova 候选来源**（[ADR 0008](0008-non-apexnova-candidates-belong-to-m5.md)）——同为 M5 退出条件，两条都不得再推迟；
3. **macOS 无实机**，自 M2 挂到现在；
4. **Scenario Quality Pack 与 Operational Evidence**：路线图给 M4 的五个权重分项里只有 `cost` 活了，其余四个的指标定义已写入 [`compatibility-evidence.md`](../compatibility-evidence.md)，缺的是常驻采集与质量任务集；
5. **可启动性前置检查**：launcher 的拒绝发生在写配置之后，一次被拒的 `run` 会留下可 `restore` 的状态。要在动状态之前判定，需要在 Agent Discovery Contract 上加前置检查，四个 Integration 都会跟着改。

## 6. 是否需要缩小而不是扩大范围

M4 的经验是**一个分项从「有数据」到「进入排序」需要多少配套**：解析、零值语义、有效期、约束语义、以及一次真实闭环才能发现的错配。M5 应当同样收窄首批，理由与 [ADR 0007](0007-m4-scope-and-recommendation-path.md) 决策 1 相同。

## 交付物

`packages/recommendation`（`coding-general` v1 Scenario、版本化打分规则 `coding.v1`、硬约束过滤、可解释排序、schema 一致的 Recommendation 文档与 ajv 校验）、CLI `recommend`（`--scenario`、`--deployment`、`--max-price`、`--model-allowlist`、`--exclude-publisher`）、launcher 的归属对账，以及 M3 证据在第二个平台的采集与发布。
