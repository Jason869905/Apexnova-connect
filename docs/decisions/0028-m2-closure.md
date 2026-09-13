# 0028 M2 收口

- 状态：已接受
- 日期：2026-09-13
- 阶段：M2 Multi-Agent Alpha（目标版本 `v0.2`）
- 前置：[ADR 0003](0003-m2-milestone-review.md) 评审时判定「除 macOS 外全部满足」并拒绝降低验证要求；[ADR 0027](0027-m2-exit-condition-two-platforms.md) 修订第五条并要求关闭时交代阶段内的限制
- 结论：**关闭**。五条退出条件全部满足，但其中一条是**改了条件之后**满足的，本记录把这件事说清楚

## 1. 退出条件的最终状态

| 退出条件 | 结论 | 依据 |
| --- | --- | --- |
| 四个 Agent 使用同一套发现、计划、验证和恢复生命周期 | **满足** | 四个都实现 `AgentIntegration`、都经 `runIntegrationChange` 执行变更、都通过 `describeIntegrationContract`，并在现网跑完 `connect → verify --live → switch → restore` |
| 产品特有逻辑没有进入 `packages/core` 和 `apps/cli` | **满足** | `packages/core/src` 检索四个产品名零命中；`apps/cli` 仅有注册表组装与 `apexnova opencode` 这一个 v0.1 兼容别名（转发到通用 `run`，不含专有逻辑） |
| 未知配置格式不会被猜测修改 | **满足** | 契约套件对每个不支持版本／损坏配置的 fixture 断言「拒绝改写」，目标文件字节不变 |
| 社区能够独立实现只读 Detection Integration | **满足（有限制）** | `integrations/_template/example-agent` 是可运行的只读实现，走 `readOnly` 模式测试。**至今没有任何外部实现走过这条路**——这一条验的是路径存在，不是有人走过 |
| ~~三个~~ **两个**平台的凭证和恢复流程通过真实环境测试 | **满足（条件已修订）** | Windows 与 Linux 均完成现网生命周期验收。第三个平台不是通过了，是**不再被要求**，见第 2 节 |

## 2. 唯一未满足的那条，是被取消的，不是被做到的

必须用最直白的话写：**[ADR 0003](0003-m2-milestone-review.md) 把 macOS 实机列为 M2 唯一未满足的退出条件，也列为下一阶段最大未决依赖。它从来没有被满足。M2 关闭，是因为那条要求在 [ADR 0027](0027-m2-exit-condition-two-platforms.md) 里被改小了。**

这条挂账的完整轨迹值得留下，因为它跨了三个里程碑：

| 时间 | 状态 |
| --- | --- |
| 2026-09-07（[ADR 0003](0003-m2-milestone-review.md)） | M2 唯一未满足项；同时被列为「阻塞 M3 在该平台采集 Evidence」 |
| 2026-09-09（[ADR 0006](0006-m3-closure.md)） | M3 关闭，macOS 继续挂在未决依赖上 |
| 2026-09-11（[ADR 0015](0015-m4-closure.md)） | M4 关闭，`recommend` 在该平台如实返回无证据 |
| 2026-09-12（[ADR 0024](0024-narrow-platform-claims.md)） | 平台声明收窄，macOS 退出支持范围 |
| 2026-09-13（[ADR 0027](0027-m2-exit-condition-two-platforms.md)、本记录） | 退出条件随之改为两个平台；M2 关闭 |

**一条活过三个里程碑的依赖，最终是靠去掉要求结清的，不是靠满足它。** 这不体面，但它是事实，而记录的用处正在于此。

要为它说的公道话只有一句，也已经在 [ADR 0027](0027-m2-exit-condition-two-platforms.md) 第 2 节核对过：**收窄是先于「M2 能不能关」这个问题发生的**。[ADR 0023](0023-integration-status-ladder.md) 把「声称即有据」做成受检条件，四个 manifest 当场全部不合格，出路只有拿到实机或收窄声明——那时没有人在问 M2。顺序可查，所以这不是为了关里程碑而改要求。

**代价照实记**：`v0.2` 作为 Multi-Agent Alpha 交付的是 **Windows 与 Linux**。macOS 用户今天得不到支持，凭据后端自 ADR 0027 起默认拒绝并说明原因。

## 3. M2 期间的其他限制，各自去了哪里

[ADR 0003](0003-m2-milestone-review.md) 第 3、4 节留下的东西，逐条交代：

- **「尚无外部用户完成该流程」——今天仍然成立。** 六天过去，M3、M4 关闭、M5 走到第三批，这句话一次都没有变过。[ADR 0019](0019-gateway-first-slice-review.md) 第 5 节对 Gateway 也重复了同一句。**这是本项目最久的一条未变限制**，不因里程碑关闭而消失；
- **「社区能够独立实现只读 Detection Integration」**：路径在、模板在、测试绿，但**零外部实现**。与上一条同源；
- **Hub 的 Capability/Evidence 接口**：已交付，M3 收口时完成真实同步（[ADR 0006](0006-m3-closure.md)）。**这条依赖是被满足的**，与 macOS 相反；
- **「Deployment 的协议真实性」**：[ADR 0003](0003-m2-milestone-review.md) 第 4 节警告过「目录声明不能当证据」。这条预判**被后续证实，而且比预期更强**——[ADR 0026](0026-linux-collection-completes.md) 第 3 节的三协议横比显示，同一个 Deployment 的 `agent.structured-output` 在三个协议上可以给出三个不同答案，没有一行是三个相同的。目录按部署给一个布尔值会是错的。

## 4. 一件本应更早处理的事：M2 开了太久

M2 在评审（2026-09-07）之后保持「进行中」六天，期间 M3 关闭、M4 关闭、M5 走完三批。**一个未关闭的里程碑没有阻挡任何后续工作**——也就是说「未关闭」这个状态在这六天里不承担任何功能，它只是一条不准确的自述。

正确的做法当时就该在两条里选一条：要么承认 macOS 短期拿不到实机、当场做出取舍（也就是 ADR 0024 后来做的事），要么明确宣布 M2 带一条未满足条件关闭并写明代价。**把它无限期挂成「进行中」，是第三条路，而它什么也没解决。**

这条教训写进做法：**里程碑不得以单条外部依赖为由长期悬置。** 依赖若不能在本阶段结清，要么明确带缺口关闭并写明代价，要么对要求本身做一次结构性判断——像 [ADR 0012](0012-region-is-the-wrong-requirement.md) 和 [ADR 0024](0024-narrow-platform-claims.md) 那样。悬置不是这两者中的任何一个。

## 5. 交付物

- 四个 Agent Integration（OpenCode、Codex、Claude Code、Hermes），统一的发现／计划／验证／恢复生命周期；
- Agent Discovery Contract、`DetectionResult` 与 `DiagnosticResult`（[ADR 0002](0002-agent-discovery-contract.md)）；
- 公共 Contract Test（`describeIntegrationContract`），并成为 `research` 以上档位的门槛；
- Community Integration 模板（只读实现，走 `readOnly` 模式）；
- 产品版本漂移与安全拒绝：无法解析的配置一律拒绝改写，不猜测；
- 事务与逆序 `restore`，四个 Agent 的真实配置 restore 后逐字节一致。

**不含**：macOS 支持（见第 2 节）。四个 Integration 目前均为 `experimental`，升 `stable` 的判定标准见 [ADR 0023](0023-integration-status-ladder.md)，与本阶段关闭无关。
