# 0003 M2 里程碑评审

- 状态：已接受
- 日期：2026-09-07
- 阶段：M2 Multi-Agent Alpha（目标版本 `v0.2`）

路线图要求每个里程碑结束时记录一份 Decision Record，回答五个问题。以下按顺序回答。

## 1. 退出条件是否全部满足

| 退出条件 | 结论 | 依据 |
| --- | --- | --- |
| 四个 Agent 使用同一套发现、计划、验证和恢复生命周期 | **满足** | OpenCode、Codex、Claude Code、Hermes 全部实现 `AgentIntegration`，全部经由 `packages/core` 的 `runIntegrationChange` 执行变更，并在现网 Hub 跑完 `connect → verify --live → switch → restore` |
| 产品特有逻辑没有进入 `packages/core` 和 `apps/cli` | **满足** | 新增一个 Agent 只需要在 `apps/cli/src/integrations.ts` 加一行；`packages/core` 不 import 任何 integration，registry 接收注入的数组 |
| 未知配置格式不会被猜测修改 | **满足** | 公共 Contract Test 对每个 Integration 强制：无法解析的配置返回 `invalid`、`plan` 抛 `AgentIntegrationError`、目标文件字节不变。Codex 另有 `UNSUPPORTED_LAYOUT`（无法安全编辑的 `model_providers.apexnova` 布局） |
| 社区能够独立实现只读 Detection Integration | **满足** | `integrations/_template/example-agent` 是可运行的只读实现，走 Contract Test 的 `readOnly` 模式，测试为绿 |
| 三个平台的凭证和恢复流程通过真实环境测试 | **未满足（macOS）** | Windows Credential Manager 与 Linux Secret Service 均已现网验收；macOS Keychain 后端已实现，但没有实机，只有 mock command runner 测试 |

M2 因此**不宣布关闭**。除 macOS 外的全部条件已满足，`v0.2` 作为 Multi-Agent Alpha 发布，macOS 验收挂账到取得实机为止。按路线原则，不通过降低验证要求把它标记为通过。

## 2. 哪些风险被验证或推翻

**被推翻的**

- *「OpenCode 证明了 Hub 的接口，其他 Agent 顺势可用」*。这条对 Codex 和 Hermes 成立，对 Claude Code 不成立：它走 `anthropic-messages`，而 M1 只验证过两个 OpenAI 协议。这条路径直到本次验收才第一次被真实调用（请求 `cf0d50b0-655a-4372-a596-2322709e09b2`）。结论是**协议维度的假设不能从别的 Agent 继承**，必须逐条验。
- *「按公开文档实现即可」*。Hermes 文档站描述的 `providers.<id>.{base_url, api_key, models[]}` 在 v0.21.0 实机上根本不存在，真实字段在顶层 `model` 块。计划里「先实机核实再写代码」这一步直接避免了一个完全写错的适配器。
- *「文档写的优先级可信」*。文档称 Hermes 的取值优先级是 环境变量 → `.env` → 配置默认值；源码里 `.env` 是 `override=True` 加载的，**恰好相反**。这改变了设计：集成必须主动检测 `.env` 是否定义了凭据变量并告警。

**被验证的**

- 先重构再加 Agent 的顺序是对的。契约与 registry 落地后，Codex、Claude Code、Hermes 各自只是一个包加一行注册。
- 公共 Contract Test 值回票价：它在 Codex 上抓到计划不幂等和解析错误消息回显用户配置两个问题，在 Claude Code 上迫使凭据断言改成与配置格式无关的形式。
- 事务恢复语义经得起真实文件考验。四个 Agent 的真实配置（Claude Code 225 行、Codex 90 行、Hermes 250+ 行）restore 后全部逐字节一致，乱序 restore 被拒绝，switch 的恢复会重新签发上一目标的凭据。

**新暴露的**

- 真实环境暴露了三个只有实机才会出现的缺陷：版本正则对 `v0.21.0` 前缀失效而误取构建日期；命令失败时仍记录版本（把 Node 崩溃栈里的 `v22.23.1` 当成 Codex 版本，还通过了版本范围检查）；凭证后端不可用时报成 `UNEXPECTED_ERROR`，且 `doctor` 只按平台名报 pass、不做实测。第三个最严重：用户批准了设备码之后才失败，而且没有任何线索指向 keyring。

## 3. 是否有真实用户完成核心流程

有。维护者在现网 Hub（`api.apexnova-consulting.com`）上，用发布产物在 Windows 完成 OpenCode、Codex、Claude Code 的完整生命周期，在 Linux/WSL2 完成 Hermes 的完整生命周期，四次真实推理合计 `0.000292 USD`，全部按 requestId 对账。详见 [Hub 联调清单](../hub-h1-integration-checklist.md)。

尚无外部用户完成该流程。

## 4. 下一阶段的最大未决依赖

- **macOS 实机**。这是 M2 唯一未满足的退出条件，也阻塞 M3 在该平台上采集兼容性 Evidence。
- **Hub 的 Capability/Evidence 接口**。M3 需要 Hub 提供 Evidence 查询与版本化 Test Suite 语义，目前只有需求文档。
- **Deployment 的协议真实性**。现网 catalog 里几乎每个文本 deployment 都同时声明三种协议；M3 的兼容性测试必须验证「声明」与「真实可用」是否一致，不能沿用目录声明当作证据。

## 5. 是否需要缩小而不是扩大范围

M2 期间范围**扩大过一次**：Hermes Agent 由三个 Agent 增为四个。事后看这次扩大是划算的——Hermes 是唯一三种协议全支持的 Agent，逼出了 YAML 编辑路径，并推翻了两条文档假设。

进入 M3 建议**缩小**：路线图给 M3 定的是 3 个 Agent、6～10 个 Deployment、8～12 项能力测试。现在有 4 个 Agent 和 46 个 Deployment，若按现有规模铺开，Evidence 的采集与过期管理会先于兼容性结论本身成为瓶颈。建议 M3 首批固定为 2 个 Agent × 4 个 Deployment × 8 项测试，跑通 Evidence 的不可变与过期语义之后再扩。
