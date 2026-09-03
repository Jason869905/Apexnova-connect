# Architecture

## 目标

Apexnova-connect 需要支持扩展能力差异很大的产品：有些提供完整插件 API，有些只支持自定义 Provider，有些通过 Gateway 或环境变量接入，还有一些要求独立 Node 或 Model Provider 包。

架构因此围绕统一能力和可逆操作设计，而不是围绕某个客户端的配置文件设计。

## 分层

### Applications

CLI 和 Desktop 负责用户交互、权限确认与任务编排。它们通过 core 发现 integrations，不直接解析第三方产品配置。

### Core, schemas and SDKs

Core 定义领域状态、change plan 和规范化错误。`schemas` 是 manifest、capability 和交换数据的语言无关事实来源；`sdks` 为 TypeScript、Python 等运行时提供符合这些 Schema 的便利接口和公共测试工具。SDK 不得产生与 Schema 不一致的私有 contract。

### Integrations

Integration 是产品边界。它负责：

- 检测产品是否安装及其版本；
- 声明当前平台真实支持的 capabilities；
- 读取配置并生成 change plan；
- 验证修改结果；
- 描述是否需要重启、重载或手动操作；
- 提供断开、恢复和卸载语义。

Integration 不直接实现账户余额、计费策略或通用协议转换。

### Shared services

Apexnova AI Hub Client、Credential Store、Config Engine、Protocols 和 Gateway 是可组合能力。它们不导入具体 integration。

## 依赖规则

```text
apps ───────────────► core / shared packages
  │
  └───────────────► integrations ─────────► schemas / SDKs / shared packages

packages/core ─────► no product-specific integration
shared packages ──► no application or integration
SDKs ─────────────► schemas, not a specific integration
```

依赖违规应在项目建立构建系统后由静态检查阻止。

## Capability contract

Capability 表示经过实现和测试的行为，而不是产品愿望。建议的首版能力包括：

| Capability | 含义 |
| --- | --- |
| `authentication` | 可发起或连接 Apexnova AI Hub 设备授权 |
| `balance` | 可在该宿主界面或伴侣应用中展示余额 |
| `model-catalog` | 可获取并映射动态模型列表 |
| `provider-config` | 可配置目标产品调用 Apexnova AI Hub |
| `gateway` | 需要或支持本地 Gateway |
| `hot-switch` | 不重启当前任务即可切换模型或 Provider |
| `restart-required` | 应用变更需要重启或重新打开会话 |
| `backup-and-restore` | 可安全备份并恢复受管理配置 |

互斥或依赖关系应由 Schema 和 contract tests 验证。例如，integration 不应同时无条件声明 `hot-switch` 与 `restart-required`。

## 配置事务

所有会修改本地状态的 integration 应遵循同一流程：

```text
detect → inspect → plan → user approval → backup → apply → verify
                                               │
                                               └── failure → rollback
```

Change plan 必须包含目标文件、字段级或文本级差异、凭证引用、是否需要重启，以及明确的恢复信息。长期密钥不得出现在 plan 的序列化内容中。

TypeScript core 已实现该流程的第一版编排器：目标不可用时提前结束、没有操作时返回 no-op、执行前强制调用审批回调、receipt 与 plan 必须匹配，并在验证失败或抛出异常时调用 executor 回滚。

`FileConfigExecutor` 已实现允许目录限制、符号链接拒绝、内容哈希并发保护、权限受限备份、同目录原子替换和受保护回滚。transaction 元数据和备份会在修改目标前持久化，新进程可扫描备份目录、重建 receipt 并执行可重试恢复；SHA-256 校验用于发现损坏或意外篡改，不用于抵御拥有本机文件写权限的攻击者。执行器尚未接入 CLI，因此不会操作用户真实配置。

## 运行方式

Integration 可以有不同交付方式：

- **In-process adapter**：由 CLI/Desktop 加载并管理配置；
- **Native plugin**：运行在目标产品的官方插件系统中；
- **Provider package**：作为目标平台的模型 Provider 或节点发布；
- **Gateway adapter**：由本地 Gateway 提供协议兼容层。

这些形态共享 manifest、模型元数据和安全约束，但不要求共享进程模型。

## 信任边界

- 登录密码不进入 Connect；优先使用 OAuth PKCE 或设备授权；
- 长期凭证只通过 credential reference 传递；
- 第三方配置在修改前完成路径校验和备份；
- 自动 fallback 不重放可能具有文件、终端或网络副作用的请求；
- 外部 integrations 的签名、权限和沙箱策略需要在开放第三方安装前另行设计；
- Apexnova AI Hub 的计费、路由、风控和上游密钥始终位于 Apexnova-connect 仓库边界之外。
