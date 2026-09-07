# 0002 Agent Discovery Contract 与 Integration Registry

- 状态：已接受
- 日期：2026-09-07
- 阶段：M2

## 背景

M1 交付了 OpenCode 的完整流程，但这条流程没有走抽象层：`apps/cli/src/run-cli.ts` 里 `requireAgent()` 只接受 `"opencode"`，`connect`、`verify`、`run`、`restore` 直接调用 OpenCode adapter，凭据绑定的存储 key 写死 `integrationId: "opencode"`，`configureOpenCode()` 还把 `packages/core` 已经实现过的 apply/rollback 又写了一遍。

M2 要在同一套生命周期上接入 Claude Code、Codex 和 Hermes。如果先加 Agent 再抽象，产品逻辑会在 CLI 里翻三倍，`packages/core` 的编排器则继续没人用。

## 决策

1. **把检测与检查提升为语言无关契约。** 新增 `schemas/detection-result.schema.json` 与 `schemas/inspection-result.schema.json`，形状取自 OpenCode 的真实输出（`installed | config-only | not-found | unsupported`、配置路径与作用域、检测证据），而不是重新设计一套。TypeScript SDK 提供投影与校验函数。

2. **定义 `AgentIntegration`。** 在通用变更 adapter 之上补 `configRoots`、`supportedProtocols`、`credentialEnvironmentVariable`、`planLaunch` 和 `diagnose`。产品的可执行文件解析、配置解析、变更计划和启动方式全部属于 Integration。

3. **`AgentIntegrationError` 承载规范化错误码。** 宿主把 `code` 映射到自己的退出码，不需要 `import` 任何具体 Integration 的错误类型。

4. **Registry 放在 `packages/core`，但不 import 任何 Integration。** `createIntegrationRegistry(integrations)` 接收注入的数组，具体清单在 `apps/cli/src/integrations.ts` 组装，保持 `apps → integrations` 的依赖方向。

5. **版本漂移在 registry 层拒绝。** `detectAgent()` 用 manifest 的 `compatibility.products[].versionRange` 判定探测到的版本，超出范围就把检测降级为 `unsupported`，`connect` 因此不可能对一个从未测过配置格式的版本生成计划。范围语法只支持显式比较符集合；`^`、`~`、`||`、通配符会被拒绝而不是近似解释——读不懂的范围不能被当成“满足”。

6. **CLI 拆成三层。** `cli-core`（原语）、`agent-workflow`（产品无关的连接/启动/轮换编排，真正调用 `runIntegrationChange`）、`run-cli`（解析、分发、呈现）。新增一个 Agent 只需要在 `apps/cli/src/integrations.ts` 加一行。

7. **公共 Contract Test 放在 `packages/integration-testing`。** 它需要 config-engine 来跑 apply/verify/rollback 往返，而 config-engine 依赖 SDK，所以套件不能放在 SDK 里。

## 后果

- `apexnova run <agent>` 成为正式的一键路径；`apexnova opencode` 保留为别名，v0.1 的安装脚本和文档不会失效。
- 凭据绑定按 agent 分维度存储。`opencode` 的 key 与 v0.1 生成的完全一致，因此不需要迁移。
- `DetectionResult` 与 `IntegrationAdapter` 的形状是破坏性变更，但只影响仓库内部；`--json` 输出的 `detect`/`inspect` 数据新增 `schemaVersion: "0.1"` 字段。
- 每个 Integration 必须通过同一套 Contract Test 才能超出 `research` 状态，只读 Detection Integration 走套件的 `readOnly` 模式。

## 被否决的选项

- **先加 Agent 再重构。** 能更早跑通一个非 OpenCode 的真实流程，但会让 `run-cli.ts` 先膨胀一轮，重构成本更高，且三份产品逻辑在契约稳定前会各写各的。
- **把 Contract Test 放进 SDK。** 会让 SDK 反向依赖 config-engine，破坏分层。
- **用完整 semver 库解析版本范围。** 引入依赖来支持 manifest 里根本不用的语法；显式比较符集合加上“读不懂就拒绝”覆盖了实际需求。
