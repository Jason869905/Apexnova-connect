# 0024 收窄平台声明：不再声称支持 macOS

- 状态：已接受
- 日期：2026-09-12
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0023](0023-integration-status-ladder.md) 第 1 条把「声称即有据」变成受检条件，并指出 macOS 一次性卡住全部四个 Integration
- 结论：四个 manifest 的 `compatibility.platforms` 全部去掉 `macos`；同日按新标准重跑采集，**六个缺口降到五个，且剩下的没有一个是「跑一遍」能解决的**

## 1. 决策

**不再声称支持 macOS。** 四个 Integration 的 `compatibility.platforms` 去掉 `macos`：

| Integration | 之前 | 现在 |
| --- | --- | --- |
| `opencode` | windows, macos, linux | windows, linux |
| `codex` | windows, macos, linux | windows, linux |
| `claude-code` | windows, macos, linux | windows, linux |
| `hermes` | macos, linux | linux |

[ADR 0023](0023-integration-status-ladder.md) 第 5 节给的出路是两条：拿到实机，或者收窄声明。选后者。

macOS 自 M2 挂账至今（[路线图](../roadmap.md) M2 唯一未满足的退出条件就是它），十天里没有实机出现过。**继续声称一个从未测过的平台，与本项目那条一以贯之的规矩直接冲突**——没测过的不得显示为支持。这条规矩此前只用在 capability 上；ADR 0023 第 1 条把它推到了 Integration 的平台声明这一层，而推上去之后，四个 manifest 立刻都不合格。

**这不是降低要求，是把声明改到事实上。** 代价是明说的：Connect 现在不声称支持 macOS，`compatibility.platforms` 从此是一个受检断言，不是意向。要恢复声称，需要的是证据，而不是改回一行 JSON——`tests/integration-status.test.ts` 会当场拒绝。

## 2. 同日重跑采集的结果

收窄之后剩六个缺口。逐个试过，实际能采集的**只有一个**：

| 缺口 | 结果 |
| --- | --- |
| `hermes` linux / `anthropic-messages` | **已采集**。四个 Deployment，三个 `compatible`、一个 `partial`，计费 0.004 USD |
| `hermes` linux / `openai-chat-completions` | **采不了**，见第 3 节 |
| `opencode` linux+windows / `openai-chat-completions` | **采不了**，见第 3 节 |
| `codex` linux / `openai-responses` | 本机没有 Linux 安装，见第 4 节 |
| `codex` windows / `openai-responses` | 需要 Windows 会话，本机是 WSL |

`hermes` 这四条是它**第一次有真实证据**——[ADR 0004](0004-m3-scope-and-evidence-path.md) 把 M3 首批定为 OpenCode 与 Claude Code 两个 Agent，`codex` 与 `hermes` 从未进入过采集范围。

一条值得记的旁证：`hermes` 那个 `partial` 出现在 `deployment.apexnova.cmtdear4g…` 上，失败项是 `agent.forced-tool-choice` 与 `agent.structured-output`，原因是该部署的 `tool_choice` 不接受 `required`。**`claude-code` 在同一个 Deployment 上是同样的 `partial`。** 两个不同的 Agent、同一个部署、同一组失败项——这说明该结论属于部署侧的限制，不是 Integration 的缺陷。能这样交叉验证，正是 subject 里同时记 agent 与 deployment 的用处。

## 3. 三个缺口卡在能力套件上，不是卡在「没跑」

`openai-chat-completions` **根本不在能力套件的覆盖范围内**。`suiteProtocol()` 只认 `openai-responses` 与 `anthropic-messages`，其余一律拒绝并明说「首批只覆盖这两个」。

于是剩下五个缺口里有三个是同一件事：`opencode` 声称 `openai-chat-completions`（两个平台）、`hermes` 也声称它（linux）——**而我们没有任何办法测它**。

这一条必须写清楚，因为它推翻了「重跑采集就能补上」这个默认假设：**这三个缺口跑多少遍都不会关闭**，要么把能力套件扩到 `openai-chat-completions`，要么这两个 Integration 收窄协议声明——与 macOS 这次是同一种选择，只是换了一根轴。

本记录不做那个决定。它与 macOS 那次不同：macOS 是「声称了一个没人验证过的平台」，而 `openai-chat-completions` 是这两个 Agent **真实支持并且在用**的协议（`hermes` 的默认协议就是它），只是我们的测量工具够不着。收窄声明在这里会是把要求改到工具的能力上，而不是改到事实上。

## 4. 本机环境限制，如实记

- `codex` 与 `opencode` 在本机 PATH 上解析到的都是 **Windows 安装**（`/mnt/c/Users/…/AppData/Roaming/npm/`），Linux 侧没有安装。`codex` 那份 Windows 安装本身已经报错。**不用它们采集 Linux 证据**——那会把一份 Windows 安装记成 `linux-x64` 的结论，正是 M4 那次 launcher 静默错配的同一个坑；
- Windows 的两个缺口需要一个 Windows 会话，本机是 WSL2。

## 5. 现状

| Integration | 机检缺口 |
| --- | --- |
| `claude-code` | **无**（第 1、4 条已满足；是否 `stable` 取决于机器看不见的第 2、3、5 条，而 [ADR 0020](0020-gateway-batch-closure.md) 记着它从未经 Gateway 实跑） |
| `hermes` | linux / `openai-chat-completions`（卡在套件） |
| `opencode` | windows + linux / `openai-chat-completions`（卡在套件） |
| `codex` | windows + linux / `openai-responses`（卡在安装与平台） |

六降到五，但**性质变了**：原先看起来是「还没跑」，现在看清楚是三个卡工具、两个卡环境。
