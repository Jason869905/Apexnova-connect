# 0033 版本探针改为探启动器真正会启动的那一个；Claude Code 升 `stable`

- 状态：已接受
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0032](0032-windows-verification.md) 第 3 节发现 `claude-code` 在 Windows 上「检测一份、启动另一份」
- 结论：缺陷是**系统性的**，修在共享 SDK；修完后 `claude-code` 按 [ADR 0023](0023-integration-status-ladder.md) 判定升 `stable`

## 1. 缺陷不属于 Claude Code，属于共享探针

[ADR 0032](0032-windows-verification.md) 把这条记成 `claude-code` 的问题。核对后要更正范围：**三个 Integration 在 Windows 上都是这样。**

- 三个启动器**都只接受 `<name>.exe`**——`.cmd` 无法以 `shell: false` 启动，而本项目不使用 shell；
- 而共享的 `defaultProbe` 在 Windows 上**明确去跑 `<name>.cmd`**（`cmd.exe /d /s /c "<name>.cmd --version"`）。

也就是说**"报告的版本"与"将要运行的二进制"在结构上就是两回事**。`opencode` 与 `codex` 之所以看不出来，只是因为它们的 shim 与 exe 来自同一次安装、版本碰巧相同——**不是设计使然，是运气**。

这台 Windows 上有两份 Claude Code（npm shim 2.1.233、原生 exe 2.1.201），运气用完了，缺陷才显形。

## 2. 修法：探针去问启动器会启动的那一个

`where.exe` 返回全部匹配。现在优先取其中的 `.exe` 并直接运行它取版本；没有 `.exe` 时才回落到 `.cmd`——那种情况下启动器本来就会拒绝，而 shim 的版本是仅有的可报之物，如实报出即可。

一处修改，三个 Integration 同时受益，且**对非 Windows 平台没有任何影响**。

**为什么它一直没被发现**：探针的测试全部通过 `run` 注入桩，`defaultProbe` 里的 Windows 分支**一行都没有被测过**。现在把选择逻辑抽成纯函数 `nativeWindowsTarget` 并加了三条测试，其中一条用的就是这台机器上真实的三行 `where.exe` 输出。

真机验证：

| PATH | 修复前 | 修复后 |
| --- | --- | --- |
| 含原生 `claude.exe` | `2.1.233`（shim） | **`2.1.201`**（真正会启动的） |
| 只有 npm shim | `2.1.233` | `2.1.233`（启动器会拒绝，如实） |

## 3. 顺带把拒绝消息补全

`claude-code` 与 `codex` 在 Windows 上找不到 `.exe` 时的消息原本只说缺什么，没说怎么办。现在写明：npm 安装提供的是 `.cmd`，无法在不使用 shell 的情况下启动；装原生版，或把 `.exe` 所在目录排到 npm shim 之前。

## 4. `claude-code` 按五条判定，升 `stable`

| 条件 | 结论 |
| --- | --- |
| 1 声称即有据 | 满足（机检；Windows 与 Linux 两格均有实测结论） |
| 2 每个声称平台有端到端闭环记录 | **满足**：Linux（[ADR 0029](0029-launch-must-honour-the-configured-file.md)）与 Windows（本日，修复后重跑）各一次 `connect → run → 归属对账 → restore`，两次都 `attributedRequests: 1`，配置逐字节还原 |
| 3 失败可恢复有验收 | 满足：两平台各一次逐字节还原；损坏配置夹具两条；另有 `unsupportedProtocol` 夹具；版本范围拒绝由 `packages/core` 集中覆盖 |
| 4 文档齐全 | 满足 |
| 5 已知限制不为空 | 满足（八条），**本记录补上两条**：Windows 必须原生安装；同机两份安装时以 `claude.exe` 为准，而用户自己敲 `claude` 可能启动另一份 |

**第 2 条的 Windows 记录是修复之后重跑的。** 修复前那次也通过了，但它写下的版本是 2.1.233 而实际运行的是 2.1.201——**一条与事实不符的记录撑不起「真实记录」这个要求**，所以作废重来。

## 5. 现状

| Integration | `stable` |
| --- | --- |
| `hermes` | 是（[ADR 0031](0031-first-stable-integration.md)） |
| `claude-code` | **是（本记录）** |
| `opencode` | 未判定 |
| `codex` | 未判定 |

M5 的那条退出条件从 1/3 到 **2/3**。剩下两个没有已知阻塞，缺的只是逐条判定——而前两次判定各自都揪出了东西（`hermes` 缺 `run` 闭环、README 声称了不支持的协议；`claude-code` 的版本错配），**没有理由假设后两次会空手而归**。
