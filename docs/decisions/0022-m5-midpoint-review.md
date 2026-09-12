# 0022 M5 中期状态评审，并撤销两条退出条件

- 状态：已接受
- 日期：2026-09-12
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0016](0016-m5-scope-and-first-batch.md) 定首批范围并写明两条退出条件「不得再推迟」；[ADR 0017](0017-m5-first-batch-review.md)、[ADR 0020](0020-gateway-batch-closure.md) 分别评审两批
- 结论：七条退出条件**四条满足、一条未满足、两条本记录撤销**。M5 **不关闭**

## 1. 七条退出条件的逐条状态

| 退出条件 | 状态 | 依据 |
| --- | --- | --- |
| Provider 故障不造成工具副作用请求的自动重放 | **满足** | Gateway 一次都不重试，上游不可达／超时各有注入验收且断言只尝试一次；`withRetry` 只包在控制面调用上（`whoami`/`balance`/`catalog`/凭据签发），不在推理路径上 |
| 每次路由可解释且可审计 | **满足** | `selected`/`attributed` 两类不可变记录带 `grounds` 与所引 Recommendation；`apexnova audit` 可读 |
| 切换失败不会破坏 Agent 配置 | **满足** | 事务、逆序 `restore`、失败注入验收，外加 `--discard-local-changes` 给「目标已被改动」留出路 |
| 用户始终能看到实际 Deployment 和计费主体 | **满足** | `connect`/`switch`/`run`/`verify` 输出真实 deployment 与计费凭据；经 Gateway 时逐请求归属 |
| 三个首批 Integration 达到 stable | **未满足** | 见第 2 节 |
| 允许推荐非 Apexnova Provider | **撤销** | 见第 3.2 节 |
| 用户可以强制隐私约束 | **撤销** | 见第 3.1 节 |

## 2. 「达到 stable」：本次才发现，而它一直可以被发现

四个 Integration 的 manifest 里 `status` **全部是 `experimental`**。Integration manifest 的 schema 给出的阶梯是 `research → planned → experimental → stable → deprecated`，`stable` 就在下一档，**一个都没有升过**。

「三个首批 Integration」指哪三个，路线图里没有定义。但四个全在 `experimental`，所以指哪三个都不改变结论。

值得单独记下的不是这条没满足，而是**为什么它至今没被提起**：前四条退出条件都有人在实现时反复触碰，这一条谁也不会在写代码时撞上——它要求的不是功能，是一个「凭什么算 stable」的判定标准，而那个标准不存在。**一条没有判定标准的退出条件不会被发现未满足**，它只会在收口那天被默认满足。

这与本阶段反复出现的那类缺陷是同一形状：[ADR 0019](0019-gateway-first-slice-review.md) 第 4 节记的是「开关被设置、什么也没做、并且报告成功」，这一条是「条件被写下、没有判定、并且不会报错」。

本记录不定义 stable 的标准，只把它从「无人过问」改为「明确未满足」。

## 3. 撤销两条退出条件

[ADR 0016](0016-m5-scope-and-first-batch.md) 决策 5 写明：这两条不进首批不等于不做，收口时若未交付按未满足记录，**M5 不得凭它们关闭**；要真正取消需要**第三次决定，且理由必须是结构性的**——像 [ADR 0012](0012-region-is-the-wrong-requirement.md) 证明「区域选错了对象」那样，而不是「来不及」。

**本记录就是那第三次决定。** 那条规矩按设计生效了：它没能阻止取消，也不该阻止，但它逼着理由被写出来，而不是让这两条第三次悄悄顺延。

### 3.1 隐私约束：这条要求指错了对象

Connect 这一侧的路径**已经做完并且验证过**：约束管道存在，`--exclude-publisher` 证明按发布方过滤可用，`recommend` 的约束语义（白名单、预算）在 M4 收口时已经真正参与排序。

缺的不是代码，是**一个只有 Hub 能发布的事实**：可比较的数据处理属性（[需求 12J](../apexnova-ai-hub-requirements.md)——处理所在司法辖区、是否用于训练、是否存在子处理方）。而 [ADR 0010](0010-m4-constraint-exit-condition-status.md) 已经更正过一次：**发布方身份不能度量隐私强度**，所以本地没有替代品可算。

于是这条退出条件有一个可核对的性质：**在本仓库里做任何工作都无法满足它**。一条本仓库无法满足的退出条件挂在本仓库的里程碑上，是归属错误——它是 Hub 的需求，不是 M5 的退出条件。这与 ADR 0012 的形状相同，区别只在 0012 指错的是对象（区域不是约束，是测量条件），这里指错的是**责任方**。

**代价必须写明，不得含糊：撤销这条不会让用户获得这个能力。** 今天用户无法强制隐私约束，12J 交付之前也不会有。撤销改变的只是「M5 不再声称拥有它」。12J 仍在 Hub 需求清单上，形状已选定；真交付时 Connect 这侧接线很小，因为过滤路径已经证明可用。

### 3.2 非 Apexnova 候选来源：字面交付即是假支持

这一条的问题反过来——它**过于容易满足**。

`recommend()` 接收的就是一个注入的 `candidates` 数组，整个推荐实现里**没有一处 Apexnova 特判**；能力套件也已经是端点无关的（它接 `endpoint`/`protocol`/`credential`，[ADR 0020](0020-gateway-batch-closure.md) 那次忠实性验证正是拿它对着一份回放夹具跑的）。所以「允许推荐非 Apexnova Provider」在字面上今天就近乎成立：塞进去一个候选，它会被排序。

**然后它会一律 `eligible: false`**，因为没有证据。得到的是一个只能排除、不能推荐的来源——[ADR 0008](0008-non-apexnova-candidates-belong-to-m5.md) 当时的原话是「一种只能排除、不能推荐的假支持」，这与本项目那条一以贯之的规矩（**没测过的不得显示为支持**）正面冲突。

**一条可以被「什么都没多做」满足、而诚实交付则需要另一个量级工作的退出条件，测的是错的东西。** 它真正需要的是三样 Hub 绑定的东西在非 Hub 端点上各有对应：凭据签发、价格来源、计费归属。那是底座，不是路由功能。

这里要把结构与判断分开写清楚：

- **结构性的部分**：这条退出条件的措辞可以被一次无意义的改动满足，而它的诚实版本是另一件事（一层独立的证据与归属底座）。措辞选错了对象；
- **产品判断的部分**：今天不做那层底座，因为四个 Integration 全部指向 Hub，没有真实需求推着它。**这一条是判断，不是结构**，照此记录，不拿结构性理由给它背书。

**代价**：Connect 因此在可预见的时间内只推荐 Apexnova 目录内的候选。`recommend` 每次运行都会声明这一点——这个声明从 M4 首批起就在输出里，撤销退出条件之后它更不能去掉。

### 3.3 这个决定是终局的

[ADR 0008](0008-non-apexnova-candidates-belong-to-m5.md) 与 [ADR 0014](0014-data-handling-attributes-belong-to-m5.md) 移入 M5 时都写了「推迟的理由已经用掉」。现在是第三次，结果是撤销而不是第四次顺延。

因此**不留挂账**：将来若要做，是一个新的里程碑范围，从第 3.1、3.2 节列出的前提开始，而不是「恢复 M5 的退出条件」。第 3.2 节那三样前提照原样记在这里，就是为了让那时候不必重新推导一遍。

## 4. 范围八项里整项未动的

除退出条件外，[路线图](../roadmap.md) 给 M5 列的范围还有四项没有开始，本记录如实点名：

- **Circuit Breaker**——全仓检索 `circuit` 零匹配；
- **新请求边界上的受控选择**——Gateway 今天只转发，不选择（[ADR 0018](0018-gateway-first-slice.md) 决策 1 有意如此）；
- **Connection Profile**——`connection-profile.schema.json` 存在，但 CLI 不接受 `--connection-profile`，属于「有 schema、无实现」；
- **Pro 高级策略与 Team 基础能力**。

## 5. M5 还剩什么

撤销两条之后，M5 的退出条件是**五条，四条满足、一条未满足**（`stable`）。加上第 4 节四项范围。

建议的下一步顺序，理由写在后面：

1. **定义 stable 的判定标准，并逐个 Integration 对照**。它最便宜，而且它会把别处躺着的问题逼出来——Claude Code 至今没有经 Gateway 跑过、Hermes 的协议错配刚修完、macOS 自 M2 挂到现在。这些在「凭什么算 stable」面前都必须有个说法，而不是继续分散在各处；
2. **Gateway 转默认的三条**（[ADR 0020](0020-gateway-batch-closure.md) 第 3 节），其中凭据续期的实现已完成（[ADR 0021](0021-gateway-credential-renewal.md)），缺的是实跑；
3. 之后才是 Circuit Breaker 与受控选择。

## 6. 基本功能可发布，但不等于 M5 闭环

当前形态是可用的：`login/whoami/balance/models/detect/inspect/doctor`、`connect`/`switch`/`restore`/`verify`、`recommend`/`audit`、`run` 启动器、四个 Agent Integration、可选 Gateway（忠实转发、逐请求归属、运行期内凭据续期）。OpenCode 在 Linux 上端到端跑通且无手工干预。

**据此切一个发布是成立的，把它与 M5 闭环脱钩。** 发布说明必须如实写出不含什么：Circuit Breaker、受请求边界的受控选择、Connection Profile、非 Apexnova 候选、隐私约束，以及四个 Integration 均为 `experimental`。

**M5 保持未关闭。** 本记录没有让任何一条未满足的条件变成满足——它撤销了两条，点名了一条，并把剩下的路写成可核对的顺序。
