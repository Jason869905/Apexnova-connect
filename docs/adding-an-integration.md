# Adding an Integration

本指南定义新增 Agent、Harness、IDE、工作流或其他平台集成时应回答的问题。Manifest 必须符合 [`integration-manifest.schema.json`](../schemas/integration-manifest.schema.json)，可以从 [`manifest.example.json`](../integrations/_template/manifest.example.json) 开始。

## 1. 证明集成方式可行

在写实现前记录：

- 目标产品的准确名称、版本范围和运行平台；
- 官方插件、Provider、Node、Gateway 或配置接口文档；
- 认证、模型发现、流式输出、工具调用和错误协议；
- 分发、商标、许可及应用商店要求；
- 配置生效是否需要重启或重新打开会话。

不要依赖抓取第三方订阅令牌、未公开私有接口或绕过产品限制的方式。

## 2. 选择类别和唯一 ID

在 `integrations` 下选择最接近的类别。类别只用于组织，唯一 ID 才是稳定身份。ID 应使用小写 kebab-case，并避免公司内部代号。

## 3. 声明 capabilities

只声明已经实现并可测试的能力。缺少 `hot-switch` 并不表示集成不完整；如果平台需要重启，应明确声明和展示该限制。

## 4. 保持边界

Integration 可以：

- 发现产品和版本；
- 解析产品特有配置；
- 将用户意图转换为 change plan；
- 调用公共协议或 Gateway 能力；
- 验证连接结果并报告规范化状态。

Integration 不应：

- 自己保存 Apexnova AI Hub 长期密钥；
- 复制余额、认证或通用协议客户端；
- 在没有 change plan 的情况下直接覆盖配置；
- 把未脱敏的用户配置或提示词写入日志；
- 自动重放可能有副作用的请求。

### `planLaunch` 的两条硬规则

这两条各自是用一个真实缺陷换来的，公共契约套件会强制它们。

**一、启动必须落在 Connect 刚写的那份配置上，否则拒绝启动。** `planLaunch` 收到的 `context.configPath` 不是装饰——用 `explicitConfigPath()` 读它，然后要么把 Agent 指过去（命令行参数或该产品自己的配置位置变量），要么抛 `unlaunchableConfig()`。**悄悄启动到另一份配置上不是第三个选项**：OpenCode 曾因此用自带 provider 作答、退出 0，而请求记在了别人账上，输出里没有任何线索。见 [ADR 0029](decisions/0029-launch-must-honour-the-configured-file.md)。

**二、检测报告的版本必须是启动器会启动的那一个。** 在 Windows 上尤其容易错：`.cmd` 无法以 `shell: false` 启动，所以启动器只能用 `<名字>.exe`，而同一台机器上的 shim 与 exe 可能是两份不同安装。共享探针已经按这条修好（优先取 `where.exe` 结果里的 `.exe`），新 Integration 只要用 `probeExecutableVersion` 就自动继承。见 [ADR 0033](decisions/0033-probe-what-the-launcher-starts.md)。

## 5. 定义恢复语义

至少覆盖以下情况：

- 目标配置不存在或格式未知；
- 配置同时被用户或目标产品修改；
- 写入中断或验证失败；
- 用户要断开 Apexnova AI Hub 但保留其他 Provider；
- 备份来自不同产品版本；
- 凭证已经撤销或过期。

恢复操作应只撤销 Connect 管理的字段，不覆盖用户在之后添加的无关配置。

## 6. 测试

每个 integration 必须通过 `packages/integration-testing` 的 `describeIntegrationContract`，否则不得超出 `research` 状态。**五档状态各自的判定条件见 [ADR 0023](decisions/0023-integration-status-ladder.md)**；其中 `stable` 的必要条件里可机检的两条由 `tests/integration-status.test.ts` 强制——声称的每个平台 × 每个协议都要有非 `unknown` 的实测结论，且缺口表与实际不符时测试会失败。只做检测的 integration 传 `readOnly: true`，套件会转而要求每个会修改状态的入口明确拒绝。

除此之外还应提供：

- 公共 contract tests；
- 支持版本的脱敏配置 fixtures；
- 不支持版本和损坏配置的负向测试；
- change plan 快照；
- apply、verify、rollback 的临时目录测试；
- 假凭证和 mock API，不访问个人账号或生产服务。

## 7. 文档

Integration README 应说明支持状态、安装方法、能力矩阵、受管理的配置、重启要求、已知限制、断开和恢复步骤，以及对应的官方扩展文档。

**「已知限制」不得为空，也不得过时**——它是 `stable` 的第五条判定条件（[ADR 0023](decisions/0023-integration-status-ladder.md) 第 3 节）。前四条都可以在只跑顺利路径的情况下满足；一个已知限制为空的 Integration，说明没有人认真用过它。

这一节不是形式要求。2026-09-13 的逐条判定里，四个 Integration 有两个在这里出了问题：`opencode` 的 README 停在 M1（写着 manifest 还是 `planned`），`hermes` 的 README 声称一个已从 manifest 移除的协议。**README 不参与构建也不参与测试**，所以除非有人对着标准逐条读，它只会越漂越远。
