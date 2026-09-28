# 0041 M5 收口：Gateway 保持默认关闭，未动的四项范围移出

- 状态：已接受
- 日期：2026-09-28
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0022](0022-m5-midpoint-review.md) 中期评审（四条满足、一条未满足、两条撤销，并点名四项未动的范围）；[ADR 0034](0034-opencode-and-codex-stable.md) 满足最后一条未满足的退出条件；[ADR 0020](0020-gateway-batch-closure.md) 第 3 节给出 Gateway 转默认的三条门槛
- 结论：**关闭**。五条有效退出条件全部满足。**Gateway 不转默认**，第三条门槛（真实长交互会话）按决定不再追。范围里整项未动的四项**移出 M5，不留挂账**

## 1. 退出条件的最终状态

| 退出条件 | 结论 | 依据 |
| --- | --- | --- |
| Provider 故障不造成工具副作用请求的自动重放 | **满足** | Gateway 一次都不重试，上游不可达／超时各有注入验收；`withRetry` 只包在控制面调用上（[ADR 0022](0022-m5-midpoint-review.md) 第 1 节） |
| 每次路由可解释且可审计 | **满足** | `selected`／`attributed` 两类不可变记录，`apexnova audit` 可读；`grounds: recommendation` 由 `connect --best` / `switch --best` 写入 |
| 切换失败不会破坏 Agent 配置 | **满足** | 事务、逆序 `restore`、三点失败注入验收；`--dry-run` 与写入共用 `deploymentsAfterSwitch`（[ADR 0039](0039-connect-only-has-models.md)），计划与写入不可能列出两套模型 |
| 三个首批 Integration 达到 stable | **满足** | 四个全部 `stable`（[ADR 0031](0031-first-stable-integration.md)、[0033](0033-probe-what-the-launcher-starts.md)、[0034](0034-opencode-and-codex-stable.md)） |
| 用户始终能看到实际 Model 和计费主体 | **满足** | `connect`／`switch`／`run`／`verify` 输出真实 model 与计费凭据；经 Gateway 时逐请求归属 |
| ~~允许推荐非 Apexnova Provider~~ | 撤销 | [ADR 0022](0022-m5-midpoint-review.md) 第 3.2 节 |
| ~~用户可以强制隐私约束~~ | 撤销 | [ADR 0022](0022-m5-midpoint-review.md) 第 3.1 节；所依赖的 Hub 接口已收回，Connect 侧实现随之删除（[ADR 0040](0040-a-ranking-always-comes-back.md)） |

这一次关闭**没有改任何一条条件**。与 [ADR 0028](0028-m2-closure.md) 不同，没有哪条是靠改小要求结清的；两条撤销发生在 ADR 0022，早于本记录十六天，理由在那里写完了。

## 2. Gateway：不转默认，也不再追第三条门槛

[ADR 0020](0020-gateway-batch-closure.md) 第 3 节的三条门槛，前两条已达成，第三条——一次真实的长交互会话——**本记录决定不做**。

后果只有一个，而且必须说死：**`--gateway` 在 v1.0 保持显式开启，默认路径是直连。** 没有走完第三条门槛，就没有资格改默认；这不是暂缓，是 v1.0 的产品形态。

这不削弱 ADR 0020 的门槛。那三条仍然是「将来谁想把 Gateway 设为默认」必须重新满足的条件，并且第三条仍然不能用自动任务近似（[ADR 0019](0019-gateway-first-slice-review.md) 第 5 节已否决过一次）。本记录改变的只是「M5 要不要等它」：**不等**，因为它从来不是 M5 的退出条件，而把一项需要人手的验收挂在里程碑上，只会重复 ADR 0028 第 4 节记下的那种长期悬置。

代价照实记：选择 `--gateway` 的用户仍然是在一条只有短时实跑支撑的路径上运行长会话。前两条门槛各自在被真正执行时都揪出了缺陷，**没有理由相信第三条会例外**。`--gateway` 的文档保持现有措辞，不因里程碑关闭而改称成熟。

## 3. 范围里整项未动的四项，移出 M5

ADR 0022 第 4 节点名的四项，十六天后仍然一行代码都没有：

| 范围项 | 现状 | 去向 |
| --- | --- | --- |
| Circuit Breaker | 全仓检索 `circuit` 零匹配 | 移出。它需要 Connect 位于请求路径上，而请求路径上的组件是 Gateway，Gateway 默认关闭（第 2 节）。**一个只在显式开关后面才存在的熔断器保护不了默认路径上的任何人**，在 Gateway 成为默认之前做它是本末倒置 |
| 新请求边界上的受控选择 | Gateway 只转发，不选择（[ADR 0018](0018-gateway-first-slice.md) 决策 1） | 移出，理由同上。它还需要 Hub 的显式路由接口（[Hub 需求 H4](../apexnova-ai-hub-requirements.md#h4显式路由)），该接口未开工 |
| Connection Profile | `connection-profile.schema.json` 存在，CLI 不接受 `--connection-profile` | 移出。**schema 保留，但在 schema 目录里标为「无实现」**，否则它仍是一份看起来像已支持的契约 |
| Pro 高级策略与 Team 基础能力 | 未开始 | 移出，归到[商业能力门槛](../roadmap.md#商业能力门槛)，由商业需求驱动而不是由里程碑驱动 |

**不留挂账**，与 ADR 0022 第 3.3 节同一规矩：将来要做是新的里程碑范围，从上表「去向」一栏写下的前提开始，而不是「恢复 M5 的范围」。前两项的共同前提写在这里，免得那时重新推导：**先有一个默认在请求路径上的组件**，也就是先过 Gateway 转默认的三条门槛。

## 4. v1.0 交付的是什么，不是什么

**是**：设备码登录、Hub 目录与余额、一枚永久 key 覆盖一组模型、`models` 只读与 `switch` 换模型、基于兼容性证据的 `recommend`（无证据时按目录顺序）、带事务与恢复的配置变更、不可变路由审计、Linux 文件凭证后端与 Windows Credential Manager、四个 `stable` 的 Agent Integration（Hermes 仅 Linux，其余 Windows 与 Linux）、显式开启的本地 Gateway。

**不是**：

- **不支持 macOS**（[ADR 0024](0024-narrow-platform-claims.md)）；
- **没有 Circuit Breaker、没有受控选择、没有 Connection Profile、没有 Pro／Team**（第 3 节）；
- **Gateway 不是默认路径**（第 2 节）；
- **没有隐私约束，只推荐 Apexnova 目录内的候选**（ADR 0022 第 3 节、[ADR 0040](0040-a-ranking-always-comes-back.md)）；
- **没有请求级费用上限**：`--max-cost` 在 Hub 交付服务端硬上限之前不提供（[Hub 需求 M1-HUB-01](../apexnova-ai-hub-requirements.md#m1-hub-01请求级硬消费上限新增高优先级)）；
- **没有外部用户走完过核心流程**，也没有任何外部 Integration 实现。这是 [ADR 0028](0028-m2-closure.md) 起最久未变的一条限制，不因 M5 关闭而消失。

本记录不切发布。v1.0 是否与 M5 关闭同日发出，是单独的决定。

## 5. 下一步

M6 Domain Expansion 按路线图「M5 后按实际需求推进，不预设固定日期」。在它有真实需求之前，最有价值的两件事都不在本仓库之内：

1. **一个外部用户走完 `login → run → switch → restore`**。它验的是本项目迄今全部自述，而这些自述至今只被作者本人检验过；
2. **Hub 侧的剩余需求**，盘点见 [Hub 需求 §18](../apexnova-ai-hub-requirements.md#18-v10-前的需求盘点2026-09-28)。
