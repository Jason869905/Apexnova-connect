# Schemas

版本化的机器可读契约目录。

M0 包含两组职责不同的契约：

- `integration-manifest.schema.json`：Integration 身份、状态、交付方式、兼容性、协议、capability 和权限声明；
- 领域契约：`agent-profile`、`provider-profile`、`model-profile`、`model-deployment`、`scenario-profile`、`compatibility-evidence`、`recommendation`、`connection-profile` 和 `diagnostic-result`。

M2 增加 Agent Discovery Contract 的两个只读契约：

- `detection-result.schema.json`：目标产品是否安装、版本、配置位置与作用域、检测证据；
- `inspection-result.schema.json`：目标产品当前的 Provider 配置投影。`connection.environmentVariables` 只记录环境变量名，任何情况下都不得出现 secret；`status: "invalid"` 表示配置不可解析，此时不得猜测或改写。

领域契约当前 Schema Version 为 `0.1`，用于 M1 API 和 SDK 设计，进入 M1 实现后才能冻结为稳定版本。公共类型位于 `common-definitions.schema.json`，其他 Schema 使用相对 `$ref` 引用它。

Schema 变更必须说明向后兼容策略，未知 capability 应被安全忽略或明确拒绝，不得静默改变行为。

Manifest v1 允许使用 `x-<vendor>.<name>` 形式扩展类别、交付方式、平台、协议、capability 和权限类型。调研中或仅处于规划状态的 Integration 不允许声明已经实现的 capability 或所需运行权限。

ConnectionProfile 只能存储 `credentialRef`，禁止添加 secret、token 或上游 API key 字段。CompatibilityEvidence 是不可变观测；修订通过 `supersedes` 创建新记录。
