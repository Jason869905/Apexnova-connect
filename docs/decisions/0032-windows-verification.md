# 0032 在 Windows 上原生验证：三条缺口全部关闭，但带出两个缺陷

- 状态：已接受
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0031](0031-first-stable-integration.md) 把剩余三条缺口全部归因于「需要一台 Windows 机器」
- 结论：三条全部关闭，**四个 Integration 的机检缺口归零**；但 `claude-code` 暴露出一个**检测与启动不是同一份安装**的缺陷，因此仍不升 `stable`

## 1. 做法：让 CLI 原生跑在 Windows 上

本机是 WSL2，宿主就是 Windows。关键不在于能不能从 WSL 摸到 Windows 的文件——**那恰恰是不能做的事**：CLI 跑在 Linux 上时平台判定是 `linux-x64`、配置路径是 Linux 的、凭据后端是 Secret Service，拿它去驱动 Windows 的 Agent 正是 M4 那次 launcher 静默错配的形状。

真正要做的是**让 CLI 自己跑在 Windows 上**。`pnpm bundle` 产出的 `dist/apexnova.mjs` 是单文件、不依赖 `node_modules`（凭据后端走的是 `cmdkey`/`security`/`secret-tool` 这类命令，不是原生模块），所以拷到 Windows 用它自己的 Node 直接跑即可。

核对过这确实是 Windows 侧：

```
credential-backend: Windows Credential Manager
state-root:         C:\Users\wakee\AppData\Local\Apexnova\connect
Config:             C:\Users\wakee\.config\opencode\opencode.jsonc
```

Windows 凭据管理器里**已经有会话**（M2／M4 那次 Windows 验收留下的，同一账号），所以不需要重新登录。

**顺带解释了 Claude Code 那条缺口为什么一直没做**：它此前被记为「配置就是本会话在用的文件」。在 Windows 上不是——本会话用的是 WSL 的 `/home/wanke/.claude/settings.json`，Windows 的是 `C:\Users\wakee\.claude\settings.json`，两个文件。

## 2. 三条缺口

| 缺口 | 结果 |
| --- | --- |
| `claude-code` Windows launcher 实跑 | **通过**：`attributedRequests: 1`，Agent 退出 0，5958 字节的真实 `settings.json` restore 后逐字节一致 |
| `opencode` `windows/openai-chat-completions` 证据 | **已采集**：九项里八项 supported，与 Linux 同部署的结论逐项一致 |
| `codex` `windows/openai-responses` 证据 | **已采集**：`partial`，失败项 `agent.structured-output`，与 Linux 一致 |

两份证据的结论都与 Linux 侧同部署、同协议**完全吻合**，这本身是对套件确定性的又一次交叉印证。

## 3. 缺陷一：`claude-code` 检测的和启动的不是同一份安装

这台 Windows 上有**两份 Claude Code**：

- `C:\Users\wakee\AppData\Roaming\npm\claude`（npm 安装，shim，**2.1.233**）
- `C:\Users\wakee\.local\bin\claude.exe`（原生安装，**2.1.201**）

`detect` 报 **2.1.233**；而 `resolveClaudeCodeExecutable` 在 Windows 上只接受 `claude.exe`，会启动 **2.1.201**。把 `.local\bin` 排到 PATH 最前再测，`detect` 仍然报 2.1.233——**检测走的是 shim，启动走的是 exe，两者版本不同。**

这正是 M4 那次的形状：**配置／记录指向一份安装，实际运行的是另一份。** OpenCode 为这一类专门有 `foreignInstallation` 检查（拒绝 `/mnt/<drive>/` 下的安装），**Claude Code 没有任何等价物**。

后果是具体的：任何记录（Evidence 的 `agentVersion`、审计、联调清单）都会写下 2.1.233，而跑的是 2.1.201。**这使得 `claude-code` 不能升 `stable`**——[ADR 0023](0023-integration-status-ladder.md) 第 2 条要的是「真实记录」，而这里记录与事实不符。

## 4. 缺陷二：npm 装的 Claude Code 在 Windows 上根本无法启动

`resolveClaudeCodeExecutable` 只找 `claude.exe`。npm 安装提供的是 `claude`／`claude.cmd`／`claude.ps1`，**没有 `.exe`**。只装了 npm 版的 Windows 用户会拿到：

> Claude Code was detected, but no native claude.exe target was found on PATH.

这条拒绝本身是对的——Node 以 `shell: false` 启动 `.cmd` 行不通，而本项目不用 shell 是出于注入面的考虑。但**消息只说了缺什么，没说该怎么办**（装原生版，或把它的目录加到 PATH）。本次就是靠手工把 `.local\bin` 加到 PATH 才跑通的。

## 5. 缺陷三：从驱动器根目录运行会被判为非绝对路径

在 `C:\` 下运行 `restore`，报 `INVALID_PLAN: Executor paths must be absolute: C:`——Windows 的 cwd 在驱动器根是 `C:`（无尾随反斜杠）。换到 `C:\Users\wakee` 即正常。小问题，但真实存在。

## 6. 一处工程缺口：证据不能跨平台流动

Windows 采到的证据写进 Windows 的证据库（`%LOCALAPPDATA%\Apexnova\connect\evidence`），而提交进仓库的矩阵是从 Linux 库生成的。**CLI 没有从 Hub 回拉证据的路径**——`compatibility sync` 只推不拉，hub-client 虽有 `evidence` 查询接口，但没有命令消费它。

本次是**手工复制那两个文件**过去的。证据是内容寻址的不可变记录（id 就是内容哈希），所以复制在语义上安全；但「跨平台采集必须手工搬文件」是一条应当补上的缺口。

## 7. 现状

| Integration | 机检缺口 | `stable` |
| --- | --- | --- |
| `hermes` | 无 | **是**（[ADR 0031](0031-first-stable-integration.md)） |
| `claude-code` | 无 | **否**——第 3 节那个缺陷 |
| `opencode` | 无 | 未判定 |
| `codex` | 无 | 未判定 |

**四个的机检缺口全部归零，但「机检无缺口」不等于 `stable`**：[ADR 0023](0023-integration-status-ladder.md) 五条里有三条是人的判定，至今只有 `hermes` 走过一遍。M5 的那条退出条件仍是 **1/3**，而阻塞它的已经不再是机器——是三次逐条判定，其中 `claude-code` 那次要先修掉第 3 节的缺陷。
