# Domain Model

## 文档状态

- 阶段：M0
- 状态：Draft
- 目标：冻结跨客户端、Registry、Match 与 Apexnova AI Hub 共享的核心术语和不变量

## 建模原则

- Integration 描述“如何连接一个外部产品”，不描述模型质量；
- Agent 描述使用模型完成任务的运行主体，不限定为 Coding Agent；
- Model 描述抽象模型版本，Deployment 描述 Provider 实际提供的可调用线路；
- Capability Statement 描述能力，Evidence 描述为什么相信该能力；
- Scenario 描述任务需求，Recommendation 描述一次可解释选择；
- 所有跨进程和跨仓库对象使用稳定 ID、Schema Version 和明确时间戳。

## 核心实体

### IntegrationManifest

现有 `integration-manifest.schema.json` 的职责保持不变：

- Integration 身份和版本；
- 适配的产品与平台；
- 交付方式；
- 已实现的 Integration Capability；
- 所需本地权限。

它不应包含：

- 模型质量分；
- 场景推荐权重；
- Provider 实时健康；
- 用户余额和商业排名。

### AgentProfile

描述一个 Agent 或 Agent Runtime 对模型和环境的稳定要求。

核心字段：

- `id`、`displayName`、`versionRange`；
- `domains`：例如 `coding`、`research`、`automation`；
- `protocolRequirements`；
- `capabilityRequirements`；
- `configurationModes`；
- `runtimeConstraints`；
- `links`。

AgentProfile 不保存用户安装路径、用户密钥或当前模型。这些属于 DetectionResult 或 ConnectionProfile。

### ProviderProfile

描述提供模型调用服务的组织或服务端：

- Provider 身份；
- 支持的协议；
- 认证方案；
- 可用地区和数据政策声明；
- 服务文档和状态页；
- 是否为 Apexnova AI Hub 托管、BYOK 或本地服务。

### ModelProfile

描述抽象模型家族中的可识别版本：

- 模型所有者、家族、版本和发布日期；
- 厂商声明的上下文、多模态和协议能力；
- 已知版本别名和弃用关系；
- 不包含某个 Provider 特有的价格、延迟和可用性。

### ModelDeployment

描述一个 Provider 在特定区域和协议入口提供的具体模型线路。Recommendation 和 ConnectionProfile 最终选择的是 Deployment，而不是抽象 Model。

核心字段：

- `id`、`modelId`、`providerId`；
- `region`；
- `protocols` 与服务端模型 ID；
- `availability`；
- `pricing`；
- `capabilityOverrides`；
- `endpointRefs`；
- `observedAt` 与 `expiresAt`。

同一个模型由不同 Provider、不同区域或不同协议入口提供时，必须是不同 Deployment。

#### 托管 Provider 的双平面边界

对于 Apexnova AI Hub 这类托管网关，Connect 看到的 ModelDeployment 是面向客户的稳定公共产品，不是 Hub 内部某一条上游供应线路。一个公共 Deployment 可以由多条内部线路、凭证、负载均衡和容灾策略承载。

- 公共 `providerId` 表示用户向谁购买和调用服务，例如 `provider.apexnova-ai-hub`；
- 模型原厂使用 ModelProfile 的 `publisher` 表达，不冒充服务 Provider；
- Hub 内部 deployment ID、上游模型名、凭证、买价和 LB 拓扑不得进入公共 Schema；
- 托管线路切换不改变公共 Deployment 身份；跨公共模型 Fallback 则必须返回最终公共 Deployment 并按其计费。

### CapabilityDefinition

定义可复用能力的语义、类型和单位。首版命名空间：

```text
protocol.*
tool.*
modality.*
context.*
reasoning.*
streaming.*
structured-output.*
caching.*
latency.*
reliability.*
privacy.*
region.*
cost.*
domain.*
```

Capability 不能全部简化为布尔值。定义需要声明值类型，例如 boolean、integer、number、enum 或 structured metric。

### CapabilityRequirement

由 AgentProfile 或 ScenarioProfile 声明：

- `capabilityId`；
- `level`：`required`、`preferred`、`avoided`；
- `operator`：例如 `eq`、`gte`、`lte`、`in`；
- `value`；
- `weight`，只对软约束有意义；
- `reason`。

### CapabilityStatement

由 ModelProfile、ModelDeployment 或 Evidence 派生：

- `capabilityId`；
- `support`：`supported`、`partial`、`unsupported`、`unknown`；
- `value` 与 `unit`；
- `sourceType`；
- `evidenceRefs`；
- `observedAt`、`expiresAt`；
- `confidence`。

### ScenarioProfile

描述某类任务的能力需求和运营偏好：

- `id`、`domain` 和版本；
- 必需能力；
- 加权偏好；
- 默认的成本、延迟、区域和隐私限制；
- 适用和不适用条件；
- 评分规则版本。

首批 Coding 场景：

- `coding.quick-question`；
- `coding.repository-edit`；
- `coding.code-review`；
- `coding.long-running-agent`；
- `coding.vision-debugging`；
- `automation.cost-sensitive-batch`。

### CompatibilityEvidence

一份不可变测试或观测记录，证明特定组合在特定时间的行为：

```text
AgentProfile + Integration Version + ModelDeployment
              + Platform + Test Suite Version
```

Evidence 只记录事实，不直接承担商业推荐。

### CompatibilityVerdict

由一个或多个有效 Evidence 计算：

- `compatible`：所有必需能力有新鲜且通过的证据；
- `compatible-with-limits`：可以运行，但存在明确限制；
- `incompatible`：至少一个必需能力有可复现失败；
- `unverified`：证据不足、过期或冲突。

### ConnectionProfile

描述用户希望某个 Agent 如何连接某个 Deployment：

- 目标 Agent Installation；
- Integration ID 和版本；
- Provider 与 Deployment；
- 协议和模型映射；
- `credentialRef`，不得包含密钥值；
- Gateway 或 direct 模式；
- 重启、验证和恢复策略；
- 用户选择的路由政策。

ConnectionProfile 是生成 Change Plan 的输入之一，不等同于第三方产品的原始配置文件。

### DetectionResult

一次本地发现结果：

- Agent ID、产品版本和平台；
- 可执行文件与配置位置；
- 检测置信度；
- 当前 Provider、模型和协议；
- 支持的 Integration 与 Capability；
- 警告和诊断信息。

路径属于本地敏感元数据，默认不上传 Registry 或 Hub。

### Recommendation

描述一次选择结果：

- Agent、Scenario 和用户约束；
- 被排除的候选及原因；
- 推荐 Deployment；
- 备选 Deployment；
- 硬约束判定；
- 分项评分；
- Evidence 引用；
- 置信度和有效期；
- 商业推广标记。

### DiagnosticResult

统一表示 Detect、Inspect、Connect、Verify、Switch、Restore 和 Doctor 的结果。必须包含机器可读 `code`、严重级别、用户可读说明和可选修复建议，不得包含秘密。

## 关系图

```text
IntegrationManifest ── operates on ──► Agent Installation
        │                                  │
        └── implements                     └── described by AgentProfile

ProviderProfile ── offers ──► ModelDeployment ── instantiates ──► ModelProfile
                                      │
                                      ├── supported by CompatibilityEvidence
                                      └── selected by Recommendation

AgentProfile ── requirements ─┐
ScenarioProfile ─ preferences ├──► Match ──► Recommendation
User Policy ─ constraints ────┘

Recommendation + CredentialRef + Integration ──► ConnectionProfile
ConnectionProfile ──► ChangePlan ──► Apply / Verify / Rollback
```

## 匹配语义

### 第一阶段：硬约束过滤

以下任一条件失败时不得进入评分：

- Agent 必需协议不可用；
- 必需 Capability 明确不支持；
- 用户区域、隐私或模型白名单不允许；
- Deployment 已停用或证据证明不兼容；
- 价格或上下文超过硬限制。

证据缺失时默认 `unverified`，是否允许继续由用户政策决定。

### 第二阶段：软约束评分

对剩余候选按 Scenario 权重计算质量、成本、速度、稳定性和隐私等分项分数。不得只输出无法解释的总分。

### 第三阶段：证据置信度修正

评分必须考虑：

- 来源等级；
- 样本量；
- Evidence 新鲜度；
- 模型、Provider 和 Agent 版本是否精确匹配；
- 冲突证据是否已经解决。

## 身份与版本

- 所有公共 ID 使用小写稳定标识，不把展示名称作为主键；
- Model ID 必须包含可识别版本，浮动别名只作为 alias；
- Deployment ID 必须区分 Provider、区域和协议入口；
- 公共 Deployment ID 不以可改名的服务模型 alias 作为永久主键；
- Scenario 和 Test Suite 必须版本化；
- Evidence 创建后不可修改，纠错通过新 Evidence 和 supersedes 关系表达；
- Schema 破坏性变更必须提升 Schema Version。

## 数据所有权

| 数据 | 默认所有者 | 默认是否上传 |
| --- | --- | --- |
| Agent 安装路径 | 本地设备 | 否 |
| 长期凭证 | 系统凭证存储 | 否 |
| Change Plan 与备份 | 本地设备 | 否 |
| 公共 Agent/Model/Scenario 元数据 | Registry | 是 |
| 脱敏兼容性 Evidence | Registry/Hub | 用户或 CI 明确提交 |
| 使用量和账单 | Hub | 是 |
| 提示词、代码和工具参数 | 用户环境 | 默认否 |

## 不变量

1. `credentialRef` 永远不是密钥值。
2. Recommendation 选择 Deployment，不直接选择模糊模型别名。
3. 未验证不等于不兼容，不兼容也不能被静默降级为未知。
4. 厂商声明不能自动升级为 Apexnova Verified。
5. ConnectionProfile 的应用必须经过 Change Plan。
6. Provider 切换不能覆盖用户未交由 Connect 管理的配置。
7. Compatibility 与 Recommendation 必须可追溯到版本化 Evidence 和规则版本。
