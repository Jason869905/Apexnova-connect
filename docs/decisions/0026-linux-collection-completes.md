# 0026 Linux 两格补齐：装本机客户端，只剩 Windows

- 状态：已接受
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0025](0025-capability-suite-covers-chat-completions.md) 把剩余四个缺口从「卡工具」全部转为「卡环境」
- 结论：Linux 两格已采集；四个 Integration 中**两个机检无缺口、两个各剩一格 Windows**

## 1. 本机的 `opencode` 与 `codex` 其实早就装好了

[ADR 0024](0024-narrow-platform-claims.md) 第 4 节记的是「本机 Linux 侧没有安装」。核对后应当更正：**`~/.npm-global/bin` 里三个客户端都在**（`opencode`、`codex`、`claude`），`~/.bashrc` 也已经把该目录排在 WSL 注入的 `/mnt/c` 条目之前——那是 M4 定位 launcher 静默错配之后加的。

当时看到的 `/mnt/c/...`，是因为**非交互 shell 没有走到 `.bashrc` 的那一段**，于是 PATH 上只剩 Windows 那份。所以 ADR 0024 那句话对现象是准的，对原因是错的：不是没装，是这条 shell 看不见。

**这一点本身值得记。** 「PATH 上解析到哪一份」在这个环境里会随 shell 是否交互而变，而 M4 那次事故正是配置写给 Linux、进程启动的却是 Windows 那份。补 PATH 之后 `detect` 给出的是 `/home/wanke/.config/opencode/opencode.jsonc` 与 `/home/wanke/.codex/config.toml`，两条 Linux 路径——先确认这一点，再采集。

## 2. 采集结果

八次运行，各四个 Deployment：

| 目标 | 结论 |
| --- | --- |
| `opencode` linux / `openai-chat` | 三个 `partial`、一个 `compatible` |
| `codex` linux / `openai-responses` | 四个 `partial` |

`opencode` 的四条与 `hermes` 在同样四个 Deployment、同一协议上**逐项一致**。这是预期的：能力套件测的是（Deployment × 协议），Agent 身份在 subject 里的作用是说明「这条证据支持谁的声称」。两个不同 Agent 得出同一组结论，是对套件确定性的又一次交叉印证。

## 3. 一个只有横比三个协议才看得见的结论

`agent.structured-output` 在四个 Deployment × 三个协议上的分布：

| Deployment | `anthropic-messages` | `openai-chat` | `openai-responses` |
| --- | --- | --- | --- |
| `…cmq4770nr…`（GLM-5.1） | yes | no | no |
| `…cmqr4cngr…`（GLM-5.2） | yes | no | no |
| `…cmt0bub5d…` | yes | yes | no |
| `…cmtdear4g…` | no | yes | no |

**没有一行是三个相同的。** 因此：

- **结构化输出不是 Deployment 的属性，是（Deployment × 协议）的属性。** 证据的 subject 本来就同时记这两者，所以数据模型是对的；但任何「部署 X 支持结构化输出」的说法，不指明协议就是错的；
- **`openai-responses` 这一列四个全 `no`**，包括在另外两个协议上都能按 schema 作答的那个。这更像参数在转发途中被丢掉，而不是模型能力差异，已作为观察（不是诊断）记入 [Hub 需求 12K](../apexnova-ai-hub-requirements.md)，带请求 id 可回溯。

[ADR 0025](0025-capability-suite-covers-chat-completions.md) 第 4 节说「只测一个协议会给出一个看起来完整、实际只对一半的答案」。补齐两格之后，这句话有了完整的证据面：**只测 `openai-responses` 会得出「四个部署都不支持结构化输出」，只测 `anthropic-messages` 会得出「四个里三个支持」。两个结论都成立，也都只对三分之一。**

## 4. 现状与剩下的

| Integration | 机检缺口 |
| --- | --- |
| `claude-code` | 无 |
| `hermes` | 无 |
| `opencode` | windows / `openai-chat-completions` |
| `codex` | windows / `openai-responses` |

**剩下两格都需要一台 Windows**，本机是 WSL2。这不是可以靠写代码绕开的一类阻塞，也不该用 WSL 里那份 `/mnt/c` 的安装去代替——那会把一份 Windows 安装记成 `linux-x64` 的结论，正是第 1 节那个坑。

两个 Integration 现在机检无缺口，但**这不等于 `stable`**：[ADR 0023](0023-integration-status-ladder.md) 的第 2、3、5 条机器看不见，而 [ADR 0020](0020-gateway-batch-closure.md) 记着 `claude-code` 从未经 Gateway 实跑。升档仍需人的判定，本记录不做。

## 5. 本批证据已发布（2026-09-13）

自 2026-09-12 起采集的 16 条（`hermes` 8、`opencode` 4、`codex` 4）连同存量记录**已 `sync` 到 Hub：提交 44 条、失败 0 条**，套件 `0.4.0` 已登记。

两件要写明：

- **12 条历史记录 Hub 拒收**，因为它们用的是 id 形式约定之前的 `evidence.<32hex>`（`400 evidence_legacy_id`）。记录不可变，所以**只能留在本地**；要发布得重采那些 subject；
- **四条被取代的记录在发布后立即撤销。** `sync` 不能按 id 过滤，所以 `hermes × openai-chat` 那四个 subject 的 `0.3.0` 与 `0.4.0` 两批都上传了，随后撤销了 `0.3.0` 那四条并附理由。撤销不是删除：记录仍可按 id 读取，只是不再支持任何判定——那四次运行确实发生过，不该被抹掉，该被抹掉的只是它们对判定的支持力。

明细见 [Hub 联调清单](../hub-h1-integration-checklist.md)。
