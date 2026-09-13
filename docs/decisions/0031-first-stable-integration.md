# 0031 按 ADR 0023 的标准逐条判定：Hermes 升 `stable`，Claude Code 不升

- 状态：已接受
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0023](0023-integration-status-ladder.md) 定义五档判定条件，[ADR 0026](0026-linux-collection-completes.md) 让 `claude-code` 与 `hermes` 的机检缺口归零
- 结论：**`hermes` 升为 `stable`（本项目第一个）；`claude-code` 不升**，差的是 Windows 上从未验证过的 launcher

## 1. 逐条判定

机器能看的两条（第 1、4 条）由 `tests/integration-status.test.ts` 保证。本记录做的是机器看不见的第 2、3、5 条。

| 条件 | `hermes`（声称 Linux） | `claude-code`（声称 Windows、Linux） |
| --- | --- | --- |
| 1 声称即有据 | **满足**（机检） | **满足**（机检） |
| 2 每个声称平台有端到端闭环记录 | **满足（本记录当日补上）** | **未满足**：Linux 有，**Windows 的 launcher 从未验证过** |
| 3 失败可恢复有验收 | **满足** | **满足** |
| 4 文档齐全 | **满足（本记录当日修正后）** | **满足** |
| 5 已知限制不为空 | **满足（本记录当日补上一条）** | **满足**（六条） |

## 2. 第 2 条：`hermes` 原本也不满足，当日补齐

核对时发现：**`hermes` 从来没有一次 `run` 加归属对账的记录。** 它 M2 的生命周期记录走的是 `connect → verify --live → switch → verify --live → restore`——有真实 requestId 与实扣金额，但没有经启动器；而唯一一次经启动器的尝试（2026-09-12 的 Gateway 验收）**每个请求都被上游拒绝**，那次正是协议错配。

当日补跑，一次完整闭环：

- `run hermes --deployment …cmq4770nr…`，协议 `openai-chat`，Agent 退出 0；
- **`attributedRequests: 1`**，审计记 `billed (run): confirmed via ledger-window — 1 on cmtzrrtsa00xk5i91eodow8yz`；
- `restore` 之后，6188 字节的真实 `config.yaml` 与运行前 **逐字节一致**（`diff` 确认）。

`claude-code` 这一条差的是 Windows。[Hub 联调清单](../hub-h1-integration-checklist.md) 至今把它记为 `[partial]`：配置写入路径验证过，**launcher 未验证**，因为它的配置就是当时会话自己在用的文件。Linux 侧已于当日补上（[ADR 0029](0029-launch-must-honour-the-configured-file.md) 第 5 节）。**一个声称两个平台的 Integration，其中一个平台的启动从未跑通过，不能算 `stable`。**

## 3. 第 4 条：`hermes` 的 README 在声称一个它不支持的协议

核对时发现 README 的协议一行写着 `openai-responses、openai-chat-completions、anthropic-messages` **三个**，而 manifest 只有**两个**——`openai-responses` 在 M5 期间被证明不成立后已从 manifest 移除，README 没跟上。

这是「没测过的不得显示为支持」在文档一层的违反，当日修正。**值得记下的是它怎么被发现的**：不是有人去读 README，而是这次逐条比对把 README 和 manifest 摆在了一起。

## 4. 第 5 条：补了一条我们早就知道、却没写进去的限制

清单里记着一条 2026-09-12 的观察：**一次每个请求都被拒绝的运行，Hermes 仍以退出码 0 结束并报 `exited successfully`**——是 Hermes 自己吞掉了错误。

这条一直躺在验收记录里，没有进 README 的「已知限制」。它直接影响用户能不能信任 `run hermes` 的退出码，因此升档前补上，并写明替代做法：看 `apexnova audit` 的逐请求归属，或经 `--gateway` 运行。

**这正是第 5 条存在的理由**（[ADR 0023](0023-integration-status-ladder.md) 第 3 节）：前四条都可以在只跑顺利路径的情况下满足，而一个「已知限制」为空或过时的 Integration，说明没有人认真用过它。

## 5. 第 3 条的一处说明

该条要求负向 fixtures 覆盖「不支持版本与损坏配置」。**损坏配置**两者各有两条夹具（非法 JSON/YAML、类型错误的节）。**不支持版本**则不在各自的夹具里——版本范围的判定集中在 `packages/core` 的 registry，并由它的测试覆盖（`downgrades a version outside the declared range to unsupported`）。

覆盖是有的，位置不同。照实记录，不算作缺口，也不假装每个 Integration 各自测过。

## 6. 对 M5 退出条件的影响

M5 的退出条件是「**三个**首批 Integration 达到 `stable`」。现在是 **1/3**，而且这条条件本身有一个从未定义过的地方——[ADR 0023](0023-integration-status-ladder.md) 第 5 节已经指出：**「三个首批」指哪三个，路线图里从来没写过。** 四个都是 `experimental` 时不影响结论，现在开始升档就必须说清楚。本记录不替它定，但把它从「含糊」改为「必须决定」。

剩下三个各差什么，都已具体：

- `claude-code`：Windows 的 launcher 实跑（需要一台 Windows）；
- `opencode`：`windows/openai-chat-completions` 证据（需要一台 Windows）；
- `codex`：`windows/openai-responses` 证据（需要一台 Windows）。

**三个都卡在同一件事上：一台 Windows 机器。**
