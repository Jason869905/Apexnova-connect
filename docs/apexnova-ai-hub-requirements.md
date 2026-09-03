# Apexnova AI Hub 对接需求与 API 契约

> 状态：M0 契约草案
> 目标读者：Apexnova AI Hub 产品、后端、计费、安全和 SRE 团队
> 客户端：Apexnova-connect（独立开源仓库）

## 1. 文档目的

本文是交付给 Apexnova AI Hub 独立仓库的服务端需求。它定义 Hub 为 Apexnova-connect 提供的能力、API、数据边界和分阶段验收条件。Hub 团队可以独立实现，但双方应以 OpenAPI 3.1、JSON Schema 和自动化契约测试作为共同事实来源。

首个目标不是一次建成企业级 Agent 平台，而是让 Apexnova-connect M1 能安全完成：设备登录、查询账号与余额、获取一致的模型目录、取得可供 Agent 使用的短期运行凭证，并通过 Hub 调用模型。

## 2. 系统边界

### 2.1 Hub 必须负责

- 账号、设备授权、会话刷新、撤销与风控；
- Provider、Model、Deployment、价格、可用区域和维护状态；
- 上游 Provider 密钥保管、模型请求代理、用量计量和账单；
- 服务端可用性探测、限流、审计和滥用防护；
- 后续阶段的兼容性证据注册表、场景推荐和 Provider 路由；
- Pro/团队版的组织、预算、策略和审计能力。

### 2.2 Connect 必须负责

- 在用户设备上发现 Agent 和读取其公开配置；
- 生成、预览、审批、执行和恢复本地配置变更；
- 把刷新令牌和运行凭证保存在操作系统安全存储；
- 将 Hub 数据转换为目标 Agent 能理解的配置；
- 在本地展示推荐依据、实际 Provider、价格和计费来源。

### 2.3 禁止跨越的边界

- Connect 不接收或保存 Hub 的上游 Provider 密钥；
- Hub 不要求上传本地项目路径、源码、Agent 配置全文或凭证明文；
- 默认不得把 prompt、response、工具参数或源码写入分析日志；
- Hub 不远程修改用户 Agent 配置；
- 路由故障不得自动重放可能产生副作用的 Agent 工具调用。

## 3. 交付优先级

| 阶段 | Hub 能力 | 阻塞的 Connect 里程碑 |
| --- | --- | --- |
| H1 | OAuth Device Flow、设备撤销、账号信息 | M1 |
| H1 | 原子模型目录、Deployment、价格与状态 | M1 |
| H1 | 短期运行凭证、推理入口、用量与余额 | M1 |
| H2 | Agent/Scenario 注册表、兼容性证据查询 | M3 |
| H3 | 可解释推荐 API | M4 |
| H4 | 显式策略路由和切换审计 | M5 |
| H5 | 组织、预算、策略、审计导出和托管运行环境 | Pro/企业阶段 |

H1 是当前服务端实施范围；后续接口先保留领域边界，不要求同步完成。

## 4. 通用 API 规范

- 公共业务 API 基路径为 `/v1`，OAuth 标准端点除外；
- HTTPS + UTF-8 JSON；时间使用 RFC 3339 UTC；
- 金额使用十进制定点字符串和 ISO 4217 币种，不得使用浮点金额；
- ID 永久稳定且不复用；名称和模型别名不得充当主键；
- 列表使用 cursor pagination：`items`、`nextCursor`；
- 目录支持 `ETag` / `If-None-Match`，并返回单调递增或内容寻址的 `catalogVersion`；
- 每个响应包含或响应头返回 `requestId`；调用方可传 `X-Request-Id`；
- 有副作用的业务请求支持 `Idempotency-Key`；
- 限流返回 `429`、`Retry-After` 和明确的限流范围；
- 发布 OpenAPI 3.1 文档、非生产 mock server、脱敏 fixtures 和 changelog；
- 破坏性变更必须发布新 API 主版本，字段只能以向后兼容方式增加。

统一业务错误格式：

```json
{
  "error": {
    "code": "catalog_version_expired",
    "message": "The requested catalog version is no longer available.",
    "retryable": true,
    "requestId": "req_01J...",
    "details": {}
  }
}
```

OAuth 端点仍使用 RFC 定义的 `error` 与 `error_description`，不能包装为上述格式。

## 5. H1：身份、设备与会话

### 5.1 OAuth 要求

Hub 必须实现 RFC 8628 Device Authorization Grant，客户端是无法安全持有 client secret 的 public client。

必须提供：

- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/device/code`
- `POST /oauth/token`
- `POST /oauth/revoke`
- 浏览器用户确认页面 `verification_uri`

建议首批 scope：

```text
openid profile offline_access catalog:read billing:read inference
devices:read devices:revoke runtime-credentials:write
```

安全要求：

- access token 建议有效期 5–15 分钟；
- refresh token 必须轮换并检测旧令牌复用；
- device code 单次使用、短期有效、足够熵，轮询遵循 `authorization_pending`、`slow_down` 和 `expired_token`；
- token、device code、runtime credential 不得出现在 URL、分析事件和普通日志；
- 撤销设备时同时撤销其 refresh token 与运行凭证；
- OAuth 元数据中的 issuer、token endpoint 与实际响应必须严格匹配，客户端不得跟随跨域 token endpoint 重定向。

### 5.2 账号和设备 API

| 方法 | 路径 | Scope | 用途 |
| --- | --- | --- | --- |
| GET | `/v1/me` | `profile` | 当前账号和套餐摘要 |
| GET | `/v1/devices` | `devices:read` | 已授权设备列表 |
| DELETE | `/v1/devices/{deviceId}` | `devices:revoke` | 撤销指定设备及其凭证 |

`GET /v1/me` 最小响应：

```json
{
  "accountId": "acct_01J...",
  "displayName": "Wakee",
  "plan": { "id": "free", "name": "Free" },
  "defaultCurrency": "USD",
  "createdAt": "2026-09-03T12:00:00Z"
}
```

设备列表不得返回 token，只返回 `deviceId`、用户可识别名称、平台、创建时间、最近使用时间和撤销状态。

## 6. H1：模型目录与 Deployment

Hub 必须区分：

- **Provider**：经营或承载服务的一方；
- **Model**：与承载位置无关的模型身份和能力；
- **ModelDeployment**：某 Provider、区域、协议、价格和可用性的实际调用入口。

同一 Model 可有多个 Deployment。Connect 的选择、计费展示和验证都必须使用 `deploymentId`，不能只使用模型别名。

### 6.1 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/catalog/snapshot` | 取得一个原子、一致的目录快照 |
| GET | `/v1/providers` | Provider 列表或增量查询 |
| GET | `/v1/models` | Model 列表，支持 capability 过滤 |
| GET | `/v1/model-deployments` | Deployment 列表，支持协议、区域、状态过滤 |
| GET | `/v1/model-deployments/{deploymentId}` | 单个 Deployment 详情 |

客户端优先使用 `/v1/catalog/snapshot`，避免分别请求三个集合时看到不一致版本。快照最小结构：

```json
{
  "schemaVersion": "0.1",
  "catalogVersion": "cat_2026-09-03T12:00:00Z_8f3a",
  "generatedAt": "2026-09-03T12:00:00Z",
  "expiresAt": "2026-09-03T12:15:00Z",
  "providers": [],
  "models": [],
  "deployments": []
}
```

Deployment 至少包含：

- 稳定 `id`、`providerId`、`modelId`、显示名称和显式 aliases；
- `protocols` 及每个协议的 Hub base URL；
- context/input/output 限制、流式输出、工具调用、结构化输出、图像/音频等声明；
- 区域、数据处理说明和账号可见性；
- `available | degraded | maintenance | unavailable | retired` 状态；
- 输入、输出、缓存、推理附加项的定价和计价单位；
- 能力声明的来源、观测时间和过期时间；
- 退役时间、替代 Deployment 和迁移提示（如适用）。

未知 capability 必须以稳定命名空间字符串表达，不能因为客户端版本较旧而改变已有字段含义。

## 7. H1：余额、估价与用量

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/billing/balance` | 可用余额、赠送额度和预算摘要 |
| GET | `/v1/billing/usage` | 按时间和 Deployment 查询聚合用量 |
| POST | `/v1/pricing/estimate` | 根据 token/媒体数量获得非约束估价 |

余额示例：

```json
{
  "currency": "USD",
  "available": "18.420000",
  "cash": "12.000000",
  "credits": "6.420000",
  "asOf": "2026-09-03T12:00:00Z"
}
```

账单记录必须标出实际 `providerId`、`modelId`、`deploymentId`、协议、输入/输出用量、币种和金额。不得依赖 Connect 上报的模型名称作为计费事实。

## 8. H1：运行凭证与推理入口

### 8.1 为什么需要运行凭证

一些 Agent 只接受 API-key 形态，不能执行 OAuth 刷新。Hub 因此需要从已授权设备会话签发受限、可撤销、短期的 opaque runtime credential；它不是上游 Provider key，且只在创建时返回一次。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/runtime-credentials` | 创建限定设备、协议和 Deployment 范围的短期凭证 |
| GET | `/v1/runtime-credentials` | 只列元数据和状态 |
| DELETE | `/v1/runtime-credentials/{credentialId}` | 撤销运行凭证 |

创建请求：

```json
{
  "name": "OpenCode on laptop",
  "protocol": "openai-responses",
  "deploymentIds": ["deployment.apexnova.model-x.eu"],
  "expiresIn": 86400
}
```

创建响应：

```json
{
  "credentialId": "rtcred_01J...",
  "secret": "anrt_...",
  "expiresAt": "2026-09-04T12:00:00Z"
}
```

要求：

- 默认最长 24 小时；服务端可按套餐缩短但不能静默延长；
- 限定账号、设备、协议和允许的 Deployment；
- secret 仅创建响应返回，数据库只保存不可逆校验材料或等价安全表示；
- 支持立即撤销、过期和设备级级联撤销；
- Connect 只把 secret 放入 OS credential store，通过环境注入或本地 Gateway 使用。

### 8.2 推理协议

Hub 至少提供一个已在目录中声明的 OpenAI Responses 兼容入口；其他协议按 Deployment 发布。推荐入口形式：

```text
POST /inference/openai/v1/responses
POST /inference/openai/v1/chat/completions
POST /inference/anthropic/v1/messages
```

要求：

- 支持流式响应、客户端断开后的取消传播和明确超时；
- 鉴权接受 scope 足够的 OAuth access token 或 runtime credential；
- 请求指定稳定 `deploymentId`，模型 alias 仅作为兼容层；
- 响应头返回 `X-Apexnova-Provider-Id`、`X-Apexnova-Model-Id`、`X-Apexnova-Deployment-Id`、`X-Apexnova-Request-Id`；
- 成功响应或流尾提供规范化 usage；最终账单以 Hub 计量为准；
- 不可用、超限、余额不足、上下文超长、内容策略和上游错误必须有可区分的稳定错误码；
- Hub 内部若切换 Deployment，必须符合用户策略并明确返回实际 Deployment；
- 对未知是否已产生副作用的请求不得由网关自动重试。

## 9. H2：兼容性注册表和证据

M3 前提供：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/registry/agents` | AgentProfile 注册表 |
| GET | `/v1/registry/scenarios` | ScenarioProfile 注册表 |
| GET | `/v1/compatibility` | 按 agent、deployment、版本查询 verdict |
| GET | `/v1/evidence/{evidenceId}` | 查询可公开的证据元数据 |
| POST | `/v1/evidence-submissions` | CI/维护者提交签名测试证据 |

证据必须不可变；纠错通过 `supersedes` 关联新证据。提交端点使用维护者或 CI service identity，不能让普通用户 token 伪装成官方验证。公开接口默认不包含 prompt、response、源码、用户名、本地路径和凭证。

verdict 必须绑定 Agent 版本范围、Deployment、协议、测试套件版本、环境和有效期。能力声明不能代替真实兼容性证据。具体字段以 [兼容性证据规范](compatibility-evidence.md) 和仓库 Schema 为准。

## 10. H3：可解释推荐

`POST /v1/recommendations` 输入 Agent、场景和约束，输出有证据引用的候选排序。

```json
{
  "agentId": "agent.opencode",
  "scenarioId": "scenario.coding.repository-change",
  "constraints": {
    "region": ["eu"],
    "maxInputPricePerMillion": "5.00",
    "requiredCapabilities": ["tool-calling"]
  },
  "priorities": ["compatibility", "quality", "cost"]
}
```

响应必须包含 `recommendationId`、`catalogVersion`、`ruleVersion`、主候选、备选、被排除项及原因、证据引用、价格快照、置信度和过期时间。商业推广不得伪装成技术排序；如存在必须使用 `sponsored: true` 单独标识。给定相同版本和输入时结果应可复现。

## 11. H4：显式路由

M5 前提供 `POST /v1/routes/resolve`。它只为一个尚未发送的新模型请求选择 Deployment，不负责恢复 Agent 会话或重放工具调用。

路由请求应包含允许候选、必需能力、区域、成本/延迟偏好、会话粘性和故障策略。响应包含被选 Deployment、理由、策略版本、有效期和签名 route token。推理响应始终揭示实际 Deployment；任何降级不得绕过用户禁止的 Provider、区域或预算策略。

## 12. H5：Pro 与团队能力预留

后续版本可增加：

- organization、member、role、service account；
- 团队预算、项目配额、Provider/Model allowlist 和数据区域策略；
- 审计导出、SSO/SCIM、密钥自带和专属网关；
- 托管 Agent workspace、队列、构建、测试和部署。

这些能力不应侵入 H1 个人账号契约。托管代码执行必须采用独立的沙箱、项目授权和供应链安全设计，不能复用普通推理 token 直接获得代码仓库或部署权限。

## 13. 非功能要求

### 13.1 安全与隐私

- 上游密钥进入专用 secret manager，并采用最小权限与轮换；
- token 与 runtime credential 在传输和静态存储中受保护，日志自动脱敏；
- 账号、计费与凭证相关操作写入不可篡改审计事件；
- 目录和推荐 API 不返回用户敏感信息；
- 默认只记录模型请求的计量元数据，不记录内容；内容保留必须显式 opt-in 并说明期限；
- 对 SSRF、请求走私、超大负载、流式连接耗尽、token 枚举和重放攻击设置防护。

### 13.2 可靠性与可观测性

- H1 API 提供正式 SLA/SLO 前，至少公开状态页和维护状态；
- OAuth、目录、账单与推理分别定义可用性和延迟指标；
- 所有跨服务调用贯穿 request ID，但不把 credential 写入 trace；
- 目录快照在短暂后端故障时应可缓存读取；
- 推理错误明确 `retryable`，但是否重试由客户端结合请求语义决定。

## 14. 契约交付物

Hub 仓库需要向 Connect 提供：

1. `openapi/apexnova-hub-v1.yaml`；
2. OAuth discovery 的 staging 地址；
3. catalog、billing、runtime credential、inference 的脱敏 fixtures；
4. 可本地启动的 mock server 或稳定 staging；
5. API changelog 和弃用策略；
6. 测试账号及零余额、无权限、过期 token、限流、维护、上游错误等测试场景；
7. 从 OpenAPI 生成或手写的 TypeScript client 兼容性说明；
8. 双方 CI 都能运行的 contract test suite。

## 15. H1 验收清单

- [ ] Device Flow 能完成授权、取消、过期、`slow_down`、刷新轮换和撤销；
- [ ] 撤销设备后，该设备 refresh token 与 runtime credential 均立即失效；
- [ ] `/v1/catalog/snapshot` 在单个 `catalogVersion` 下自洽，并支持 ETag；
- [ ] 一个真实 OpenAI Responses Deployment 可通过 runtime credential 流式调用；
- [ ] 响应揭示实际 Provider/Model/Deployment，错误码稳定且可诊断；
- [ ] 余额、估价和最终用量在约定精度内一致；
- [ ] 日志、trace、错误响应和 fixtures 中不存在 secret、prompt 或源码泄漏；
- [ ] OpenAPI、mock/staging 和契约测试可供 Connect CI 使用；
- [ ] 完成安全评审、限流测试和凭证撤销演练。

H1 全部通过后，Apexnova-connect 才能把 M1 从 mock/contract 环境切换到 Hub staging；生产接入还需要单独的发布和安全验收。
