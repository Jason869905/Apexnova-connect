# 0034 OpenCode 与 Codex 升 `stable`：四个全部升档，M5 该条退出条件满足

- 状态：已接受
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0031](0031-first-stable-integration.md)（`hermes`）、[ADR 0033](0033-probe-what-the-launcher-starts.md)（`claude-code`）
- 结论：四个 Integration 全部 `stable`；判定过程照例揪出两件——**`opencode` 的 README 停留在 M1**，**`codex` 的 Windows 声称没有可用路径**

## 1. `opencode` 的 README 是 M1 时期的

第 4 条比对时发现：**本项目最常用的那个 Integration，README 停在 M1 之前的状态**，而且一个 `##` 小节都没有。原文写着：

> - 尚未通过 CLI 对用户配置开放；
> - 尚未连接操作系统凭证存储；
> - **manifest 继续保持 `planned`**，在端到端 apply、verify 和 rollback 完成前不声明已交付 capability。

三条全是错的：它自 M1 起就是 `apexnova run opencode` 这条主路径的对象，凭据早已走系统凭证库，manifest 是 `experimental`（现在是 `stable`）。[adding-an-integration](../adding-an-integration.md) 第 7 节要求的支持范围、受管理配置、重启要求、断开恢复步骤，一条都没有。

已重写，并把今天学到的写进「已知限制」，其中最要紧的一条是：**OpenCode 自带 provider，所以"配置没被读到"不会表现为报错**——它会照常作答、退出 0，而请求走了别人的账（[ADR 0029](0029-launch-must-honour-the-configured-file.md) 实测过）。

**这条为什么一直没人发现**：README 不参与构建，不参与测试，也没有人为了别的事去读它。[ADR 0023](0023-integration-status-ladder.md) 的第 4、5 条把它拉进了判定范围，于是它在第一次逐条比对时就掉了出来——`hermes` 那次是协议写错，这次是整份过时。

## 2. `codex` 的 Windows 声称原本没有可用路径

第 2 条要求每个声称平台都有端到端记录。`codex` 声称 Windows，而在这台 Windows 上：

- npm 安装只把 `codex.cmd` 放上 PATH；
- 三个 Windows 启动器都只接受 `.exe`（`.cmd` 无法以 `shell: false` 启动，本项目不使用 shell）；
- 于是 **`run codex` 直接 `AGENT_NOT_FOUND`**。

也就是说：**用最常见的方式安装 Codex 的 Windows 用户，这条路根本走不通**，而 manifest 里 Windows 一直在声称位置上。真正的二进制存在，只是 npm 把它藏在平台子包里：`@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`。

**`opencode` 的解析器早就认识自己的 npm 布局**（`node_modules/opencode-ai/bin/opencode.exe`），`codex` 没有。补上后，普通 npm 安装下 `run codex` 在 Windows 上直接跑通，无需任何 PATH 手脚。

两个架构的路径按 npm 自己的命名列出（x64 与 arm64），**不从 `process.arch` 猜**——目录要么存在要么不存在。三条测试覆盖：找到藏起来的、优先直接在 PATH 上的、两处都没有时仍然拒绝且消息给出出路。

## 3. 四条实跑

| Integration | 平台 | 结果 |
| --- | --- | --- |
| `opencode` | Linux | `attributedRequests: 1`，退出 0，配置还原 |
| `opencode` | Windows | `attributedRequests: 1`，退出 0，配置还原 |
| `codex` | Linux | `attributedRequests: 1`，退出 0，配置还原 |
| `codex` | Windows | `attributedRequests: 1`，退出 0，配置还原（**修复后以普通 npm 安装重跑**） |

`codex` 的 Windows 记录同样是**修好之后重跑的**——修复前那次是靠手工把 vendor 目录加进 PATH 才成立的，那不是用户会走的路，撑不起「真实记录」。与 [ADR 0033](0033-probe-what-the-launcher-starts.md) 对 `claude-code` 的处理同一把尺子。

## 4. 五条判定结果

| 条件 | `opencode` | `codex` |
| --- | --- | --- |
| 1 声称即有据 | 满足（机检） | 满足（机检） |
| 2 每平台端到端闭环 | 满足（本日两次） | 满足（本日两次，Windows 为修复后重跑） |
| 3 失败可恢复有验收 | 满足 | 满足 |
| 4 文档齐全 | **满足（README 已重写）** | 满足 |
| 5 已知限制不为空 | 满足（七条，含今日三条新的） | 满足（八条，含今日两条新的） |

## 5. M5 该条退出条件满足

「三个首批 Integration 达到 `stable`」——**四个全部达到**，因此无论「三个首批」指哪三个，这条都满足。[ADR 0023](0023-integration-status-ladder.md) 第 5 节与 [ADR 0031](0031-first-stable-integration.md) 第 6 节提出的「哪三个从没定义过」因此**不再需要裁决**：不是被回答了，是被绕过去了，如实记录。

**四次逐条判定，四次都揪出了东西**：`hermes` 缺 `run` 闭环、README 协议写错、少一条已知限制；`claude-code` 检测与启动不是同一份安装；`opencode` README 停在 M1；`codex` 的 Windows 声称没有可用路径。**没有一件是测试发现的**，全部来自把标准对着记录逐条读。

这给 [ADR 0023](0023-integration-status-ladder.md) 那条设计以事后证据：机器能查的两条挡住了「声称但没测」，而机器查不了的三条挡住的是**「测过但记错了」和「能跑但用户走不通」**——后两类不写下来就永远不会被发现。
