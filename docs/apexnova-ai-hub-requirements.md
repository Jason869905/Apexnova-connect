# Apexnova AI Hub 对接需求与 API 契约

> 状态：M0 跨仓评审稿
> Hub 实现基线：`C:\D\project\ApeXagent`，审计于 2026-09-03，基线提交 `b996c50`
> 目标读者：Apexnova AI Hub 产品、后端、计费、安全和 SRE 团队
> 客户端：Apexnova-connect（独立开源仓库）

## 1. 文档目的

本文定义 Apexnova AI Hub 为 Apexnova-connect 提供的服务端能力、API、数据边界和验收条件。设计已经结合 ApeXagent 当前代码，不再假设 Hub 是空白系统。

首个目标 H1 是让 Connect M1 安全完成：设备登录、读取账号和余额、获取一致的模型目录、签发 Agent 可使用的短期运行凭证，并通过 Hub 现有推理入口调用模型。

双方以 OpenAPI 3.1、JSON Schema、脱敏 fixtures 和自动化契约测试作为跨仓事实来源。本文描述产品契约；Hub 仓库中的实施计划负责数据库迁移、文件位置和发布顺序。

## 2. 当前实现盘点

| 能力 | ApeXagent 当前实现 | H1 处理 |
| --- | --- | --- |
| Web 登录 | NextAuth JWT、本地账号、Google、组织 OIDC SSO | 保留；作为设备批准页面的登录态 |
| OAuth Device Flow | 未实现；现有 OIDC 代码是“客户端”而非授权服务器 | 新增 |
| API Key | 本地生成 `sk-`、SHA-256 存储、一次显示、可撤销/过期 | 复用为运行凭证基础 |
| Workspace 与权限 | 模型白名单、RPM/TPM、预算、组织隔离和成本中心 | 运行凭证必须继承 |
| 推理 | `/v1/responses`、`/v1/chat/completions`、`/v1/embeddings`、媒体端点和 `/anthropic/v1/messages` | 复用，不新增第二套推理路径 |
| 模型销售目录 | `ModelPricing`，含公开名称、能力、模态、卖价、展示元数据和端到端探针 | 建立公共目录投影 |
| 内部供给路由 | `ModelDeployment` + `Credential` + LiteLLM/直连 Provider，含买价、LB、Fallback | 严格保持私有 |
| 余额与促销 | `Balance`、`BalanceHold`、限定模型的 `PromoCredit` | 新增只读 API |
| 用量与计费 | `UsageLog`、`BillingAttempt`、requested/resolved model、最终内部 deployment | 新增安全投影 API |
| 推荐/兼容性 | 有能力标签和运行探针，尚无 Agent 兼容性证据模型 | H2–H4，不进入 H1 |

现有架构已经能承担大部分数据面和计费工作。H1 的主要新增量是授权服务器、设备生命周期、公共目录投影、控制面 API 和契约交付，而不是重写推理网关。

## 3. 系统边界

### 3.1 Hub 负责

- 账号、设备授权、OAuth 会话刷新、撤销与风控；
- Workspace、模型访问范围、短期运行凭证和组织权限；
- 公共 Model、Provider、Public Deployment、价格、状态和协议目录；
- 上游凭证、内部供应线路、路由、推理、用量计量和账单；
- 服务端可用性探测、限流、审计和滥用防护；
- 后续阶段的兼容性证据、场景推荐和显式路由策略。

### 3.2 Connect 负责

- 在用户设备发现 Agent 和读取其公开配置；
- 生成、预览、审批、执行和恢复本地配置变更；
- 将 OAuth 会话和运行凭证保存在操作系统安全存储；
- 将 Hub 公共目录转换为目标 Agent 能理解的配置；
- 展示推荐依据、服务 Provider、最终公共模型和计费来源。

### 3.3 禁止跨越的边界

- Hub 内部 `Credential`、`ModelDeployment`、`upstreamModel`、`apiBase`、`litellmModelId`、买价和 LB 权重不得进入公共 API；
- Connect 不接收或保存 Hub 的上游 Provider 密钥；
- Hub 不要求上传本地项目路径、源码、Agent 配置全文或凭证明文；
- 默认不得把 prompt、response、工具参数或源码写入分析日志；
- Hub 不远程修改用户 Agent 配置；
- 路由故障不得自动重放可能产生副作用的 Agent 工具调用。

## 4. H1 已冻结的架构决定

### 4.1 公共 Deployment 与内部供应线路分离

Connect 中的 `ModelDeployment` 表示客户可选择的公共服务产品。对 Apexnova AI Hub 而言，它由 `ModelPricing` 投影，Provider 固定为 `provider.apexnova-ai-hub`。

Hub 仓库中的内部 `ModelDeployment` 是供应侧线路，可能随 LiteLLM 负载均衡、凭证和容灾调整，不是公共对象。两者不得共用 ID 或直接序列化。

公共模型的原厂归属使用 `publisher` 字段，例如 OpenAI、Anthropic 或 DeepSeek；它不等同于本次调用的服务 Provider。若 Hub 未承诺暴露上游实际线路，客户端只能显示“由 Apexnova AI Hub 提供”。

### 4.2 运行凭证复用 ApiKey 安全链路

Agent 常只接受 API-key 形态。Hub 应扩展现有 `ApiKey`，而不是建立第二套计费身份：

```text
kind                user | runtime
oauthDeviceId       runtime 凭证所属设备
allowedPublicDeployments[]
allowedProtocols[]
expiresAt           runtime 必填
```

运行凭证建议使用 `anrt_` 前缀，明文只返回一次，数据库仍只保存 SHA-256。它必须继承 Workspace 的模型白名单、RPM/TPM、预算、组织隔离、私有模型授权、IP 白名单、审计和计费。

### 4.3 控制面和推理面分离

- OAuth access token：只访问账号、设备、目录、余额、用量和运行凭证等控制面；
- `sk-` 用户 API Key：继续访问现有推理面；
- `anrt_` runtime credential：供 Connect 配置到 Agent，访问被授权的推理协议。

H1 不让 OAuth access token 直接调用推理。否则必须为它另造 Workspace、预算和 `apiKeyId` 归属，容易形成第二套限额与计费路径。

### 4.4 复用现有推理入口

```text
https://api.<domain>/v1/responses
https://api.<domain>/v1/chat/completions
https://api.<domain>/v1/embeddings
https://api.<domain>/anthropic/v1/messages
```

不新增 `/inference/*` 路径。具体 base URL 由公共目录 `protocols[].baseUrl` 返回，Connect 不硬编码域名。

### 4.5 保留 OpenAI `/v1/models`

现有 `/v1/models` 是 OpenAI SDK 使用的扁平列表，必须保持兼容。完整领域目录使用：

```text
/v1/catalog/snapshot
/v1/catalog/providers
/v1/catalog/models
/v1/catalog/model-deployments
```

## 5. 分阶段交付

| Hub 阶段 | 能力 | 阻塞的 Connect 里程碑 |
| --- | --- | --- |
| H1 | Device Flow、设备、账号、公共目录、余额、用量、估价、运行凭证、推理头、OpenAPI | M1 |
| H2 | Agent/Scenario 注册表、兼容性证据查询 | M3 |
| H3 | 可解释推荐 API | M4 |
| H4 | 显式策略路由和切换审计 | M5 |
| H5 | 托管 Agent workspace、队列、构建、测试和部署 | M6 以后单独立项 |

组织、Workspace、RBAC、预算和审计在 Hub 已有基础。H1 可以让组织成员按当前权限使用 Connect，但不要求新增组织级设备管理 UI；团队统一设备策略留到后续阶段。

## 6. 通用 API 规范

- 控制面基路径为 `/v1`，OAuth 标准端点除外；
- HTTPS + UTF-8 JSON；时间使用 RFC 3339 UTC；
- 金额使用十进制定点字符串和 ISO 4217 币种；不得使用浮点金额；
- ID 永久稳定且不复用；显示名称和模型 alias 不得充当永久身份；
- 列表使用 cursor pagination：`items`、`nextCursor`；
- 有副作用的业务请求支持 `Idempotency-Key`；
- 控制面响应返回 `X-Apexnova-Request-Id`；调用方可传 `X-Request-Id`；
- 限流返回 `429`、`Retry-After` 和明确的限流范围；
- 发布 OpenAPI 3.1、非生产 mock、脱敏 fixtures 和 changelog；
- 破坏性变更发布新 API 主版本，字段只能以兼容方式增加。

控制面统一错误：

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

OAuth 端点使用 RFC 错误格式。推理端点保持 OpenAI/Anthropic 兼容错误体，只增加稳定错误码和 Request ID 响应头，不包成控制面格式。

## 7. OAuth Device Flow 与设备

### 7.1 端点

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/.well-known/oauth-authorization-server` | 授权服务器元数据 |
| POST | `/oauth/device/code` | RFC 8628 设备授权 |
| POST | `/oauth/token` | Device Code 与 Refresh Token grant |
| POST | `/oauth/revoke` | RFC 7009 撤销 |
| GET | `/v1/me` | 当前账号、套餐和资源上下文摘要 |
| GET | `/v1/devices` | 当前用户设备列表 |
| DELETE | `/v1/devices/{deviceId}` | 撤销设备、会话与运行凭证 |

若 issuer 使用 `https://api.<domain>`，现有 nginx 必须显式放行 `/.well-known/oauth-authorization-server` 和 `/oauth/*`；当前 api virtual host 的兜底是 `404`，不能宣称“无需 nginx 改动”。验证页面可以位于 console 子域，但 issuer、端点元数据和实际 token issuer 必须一致。

### 7.2 Scope

H1 是 OAuth 2 授权服务器，不宣称 OpenID Connect，因此不使用 `openid`、`profile` 或 ID Token：

```text
account:read catalog:read billing:read usage:read
devices:read devices:revoke runtime-credentials:write
api-keys:write api-keys:read api-keys:revoke
```

设备批准页面必须展示请求 scope、设备名称、平台和将使用的账号。未知 scope 必须拒绝，不能静默忽略。

### 7.3 安全要求

- access token 建议 10 分钟；refresh token 建议 30 天且每次使用轮换；
- refresh token 旧值复用时，以事务/CAS 撤销整个 token family；
- device code 和 token 只保存不可逆摘要；user code 必须限速、限制尝试次数并短期有效；
- 批准/拒绝动作要求有效 NextAuth 会话和 CSRF 防护；
- device code 单次使用，轮询支持 `authorization_pending`、`slow_down`、`access_denied` 和 `expired_token`；
- token、device code、runtime credential 不得进入 URL、普通日志、trace 和分析事件；
- 账号停用、用户离开组织、Workspace 权限变化时，后续控制面和推理鉴权必须重新校验当前权限；
- 撤销设备时级联撤销 refresh/access token 与该设备的 runtime credential。

## 8. 公共模型目录

### 8.1 公共投影

Hub 输出：

- `ProviderProfile`：H1 至少包含 `provider.apexnova-ai-hub`；
- `ModelProfile`：抽象模型身份、publisher、家族、模态和能力；
- `ModelDeployment`：Apexnova 面向客户的稳定公共模型产品、协议、卖价和状态。

严禁输出内部 Credential、供应线路、买价或路由拓扑。

公共 ID 建议使用持久化 `publicId`，或基于不变的 `ModelPricing.id` 生成；不得直接以可改名的 `modelName` 作为永久 ID。`modelName` 作为 inference alias 单独返回。

### 8.2 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/catalog/snapshot` | 当前账号/Workspace 可见的原子目录快照 |
| GET | `/v1/catalog/providers` | Provider 集合 |
| GET | `/v1/catalog/models` | Model 集合 |
| GET | `/v1/catalog/model-deployments` | Public Deployment 集合 |
| GET | `/v1/catalog/model-deployments/{id}` | 单个 Public Deployment |

访问控制必须复用现有 `published`、`ModelAccessGrant`、Workspace 模型白名单和套餐权限。未授权私有模型按不存在处理。

### 8.3 版本与缓存

- `catalogVersion` 对规范化后的“可见语义数据”做内容哈希；
- 哈希输入不得包含每次请求都会变化的 `generatedAt`、`expiresAt` 或 request ID；
- 相同权限、数据和有效价格状态必须产生相同版本与 ETag；
- 促销窗口、探针有效期或授权变化会改变有效投影时，应更新版本；
- 返回 `Cache-Control: private`，避免账号私有模型目录被共享缓存；
- `If-None-Match` 命中返回 `304`。

快照：

```json
{
  "schemaVersion": "0.1",
  "catalogVersion": "cat_4dc1f6e3b90a",
  "generatedAt": "2026-09-03T12:00:00Z",
  "expiresAt": "2026-09-03T12:15:00Z",
  "providers": [],
  "models": [],
  "deployments": []
}
```

### 8.4 能力和健康

- `ModelPricing.capabilities` 映射为稳定命名空间，例如 `tool.calling`、`structured-output.json`、`reasoning.supported`；
- 未知扩展使用 `x-apexnova.<name>`，与 Connect Schema 一致，不使用带冒号的 ID；
- 协议入口存在不等于某个模型已验证兼容；H1 只能声明 platform adapter support，M3 后再引用 Agent compatibility evidence；
- 公共可用性以 `ModelPricing.e2eStatus/e2eProbedAt` 为主，内部 deployment 探针只用于聚合；
- `enabled=false` 的模型默认从当前目录移除。要发布 `retired` 必须另有退役保留期和替代模型字段，不能一边过滤一边声明 retired。

## 9. 余额、促销、估价与用量

### 9.1 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/billing/balance` | 正常余额、冻结金额和促销额度 |
| GET | `/v1/billing/usage` | 按时间、模型、Key、Workspace 聚合或分页查询 |
| POST | `/v1/pricing/estimate` | 按模型与计费维度计算非约束估价 |

### 9.2 余额语义

ApeXagent 的余额不是简单的 `cash + credits`：

- `Balance` 是可通用使用的正常余额；
- `BalanceHold` 会降低当前可花余额；
- `PromoCredit` 可能只适用于指定模块或模型，并有过期时间；
- 个人和组织通过 `BillingAccount` 解析实际付款主体。

因此不带 `model` 时不得返回误导性的统一 `availableTotal`。建议响应：

```json
{
  "currency": "USD",
  "normalBalance": "18.420000",
  "held": "2.000000",
  "normalAvailable": "16.420000",
  "promoCredits": [
    {
      "id": "promo_public_id",
      "remaining": "5.000000",
      "eligibleModelAliases": ["model-x"],
      "expiresAt": "2026-10-01T00:00:00Z"
    }
  ],
  "asOf": "2026-09-03T12:00:00Z"
}
```

当请求带 `?model=<publicDeploymentId>` 时，可以额外返回该模型当前的 `eligiblePromo` 和 `effectiveAvailable`，其计算必须复用 `getEffectiveBalance`。

### 9.3 估价和用量

估价必须复用实际计费策略，支持 token、cached token、image item/size、video duration 等现有维度，并返回假设、价格版本和 `estimateOnly: true`。它不是锁价 quote。

用量投影可返回 requested model、resolved public model、public deployment、Workspace、输入/输出/缓存用量、促销抵扣、正常余额抵扣、币种和金额；不得返回内部 deployment、买价、毛利和上游凭证信息。

### 9.4 用量聚合查询

`GET /v1/billing/usage` 在现有 `requestId` 单查基础上扩展为支持按 key、时间、模型、Workspace 聚合与分页。这是 Connect `apexnova usage --key` 和"这个工具用了多少"的前置条件。

查询参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `requestId` | string | 单条精确查（保留，向后兼容） |
| `apiKeyId` | string | 按 user key / runtime credential 过滤 |
| `workspaceId` | string | 按 Workspace 过滤 |
| `model` | string | 按 public deployment id 或 inference alias 过滤 |
| `from` | RFC3339 | 起始时间（含） |
| `to` | RFC3339 | 结束时间（含） |
| `granularity` | enum `hour\|day\|month` | 聚合粒度；省略时返回逐条记录 |
| `cursor` | string | 上一页返回的 `nextCursor` |
| `limit` | int | 每页条数，默认 100，上限 500 |

聚合响应（`granularity` 非空时）：

```json
{
  "schemaVersion": "0.1",
  "granularity": "day",
  "from": "2026-09-01T00:00:00Z",
  "to": "2026-09-06T23:59:59Z",
  "items": [
    {
      "bucketStart": "2026-09-06T00:00:00Z",
      "apiKeyId": "cm8qr4cngr000dn1q69bbrl1vw",
      "apiKeyName": "opencode on laptop",
      "publicDeploymentId": "deployment.apexnova.cm123example",
      "requestedModel": "glm-5.2",
      "resolvedModel": "glm-5.2",
      "requestCount": 142,
      "inputTokens": 18432,
      "outputTokens": 41280,
      "cachedTokens": 0,
      "normalCost": "0.042100",
      "promoCost": "0.000000",
      "currency": "USD"
    }
  ],
  "nextCursor": null,
  "asOf": "2026-09-06T12:00:00Z"
}
```

逐条响应（`granularity` 省略时）每条记录新增字段：`apiKeyId`、`apiKeyName`、`apiKeyKind`（`user`/`runtime`），其余字段保持现有 `HubUsageRecord`。

要求：

- 不得返回内部 `ModelDeployment.id`、`litellmModelId`、买价、毛利、上游凭证、prompt/response 内容；
- `apiKeyId` 过滤时只能看到当前账号/设备有权访问的 key；跨 Workspace 需 `workspaceId` 显式指定且有权限；
- 时间区间最大跨度 90 天，超限返回 `400 range_too_large`；
- 聚合口径必须与 `UsageLog`/`BillingAttempt` 最终计费一致（requested/resolved model、公共 deployment、促销抵扣、正常余额抵扣）；
- 复用现有 cursor pagination（`items` + `nextCursor`）、`X-Apexnova-Request-Id`、限流 `429`+`Retry-After`；
- OAuth scope 已有 `usage:read` 覆盖，不新增。

## 10. Runtime Credential

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/runtime-credentials` | 为当前设备创建短期 Agent 凭证 |
| GET | `/v1/runtime-credentials` | 只列当前设备可见的凭证元数据 |
| DELETE | `/v1/runtime-credentials/{id}` | 立即撤销 |

创建请求：

```json
{
  "name": "OpenCode on laptop",
  "workspaceId": "workspace_public_id",
  "protocols": ["openai-responses"],
  "publicDeploymentIds": ["deployment.apexnova.cm123example"],
  "expiresIn": 86400
}
```

要求：

- 默认和最大 TTL 均为 24 小时，Connect 可在 OAuth 会话有效时自动轮换；
- secret 只在创建响应返回一次；
- runtime credential 不占普通用户 API Key 数量配额，但每设备必须有独立的活动数量上限和签发限流；
- 创建时通过现有可选 Workspace/RBAC 逻辑校验，组织成员凭证绑定当前组织与 Workspace；
- 每次推理校验协议、请求模型和 Workspace；
- 若服务端 fallback 最终命中不在 `allowedPublicDeployments` 的模型，必须 fail closed，或在签发时把整条允许链显式加入；
- 删除、过期、设备撤销、账号停用、成员移除或 Workspace 失权都必须导致鉴权失败；
- Connect 只把 secret 放入 OS credential store，通过环境变量、本地 Gateway 或目标 Agent 的安全凭证机制引用。

## 10A. 长期 User API Key

Connect 简化 UX 后，`apexnova opencode` 默认为每个 Agent 创建/复用一个长期 key，并支持 `--key <id>` 绑定已有 key 做按工具计费追踪。runtime credential 的 24h TTL 和设备绑定不适合此默认路径，因此新增账号级长期 API Key。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/api-keys` | 为当前账号创建长期 API Key |
| GET | `/v1/api-keys` | 列当前账号可见的 key 元数据（不含 secret） |
| GET | `/v1/api-keys/{id}` | 单个 key 元数据 |
| PATCH | `/v1/api-keys/{id}` | 更新 name / allowedPublicDeployments / allowedProtocols / expiresAt（不改 secret） |
| DELETE | `/v1/api-keys/{id}` | 立即撤销 |

创建请求：

```json
{
  "name": "opencode on laptop",
  "workspaceId": "workspace_public_id",
  "protocols": ["openai-responses", "anthropic-messages"],
  "publicDeploymentIds": ["deployment.apexnova.cm123example"],
  "expiresIn": null,
  "scopes": ["inference"]
}
```

创建响应：

```json
{
  "id": "cm8qr4cngr000dn1q69bbrl1vw",
  "name": "opencode on laptop",
  "prefix": "sk_abcd...wxyz",
  "secret": "sk-xxxxxxxxxxxxxxxxxx",
  "kind": "user",
  "workspaceId": "workspace_public_id",
  "protocols": ["openai-responses", "anthropic-messages"],
  "publicDeploymentIds": ["deployment.apexnova.cm123example"],
  "expiresAt": null,
  "createdAt": "2026-09-06T12:00:00Z",
  "lastUsedAt": null
}
```

要求：

- 复用现有 `ApiKey` 表与安全链路（SHA-256 存储、明文只返回一次），`kind=user`；与 `kind=runtime`（`anrt_`）共享推理鉴权/计费路径，不另造第二套限额；
- `expiresIn` 为 `null` 时永不过期；为整数时按秒计算过期时间（允许长于 24h，如 90d/365d）；过期后鉴权失败；
- 不绑定设备（区别于 runtime credential 的 `oauthDeviceId`），账号级凭据，可在任何机器使用；撤销由账号主动发起；
- 继承当前 Workspace 的模型白名单、RPM/TPM、预算、组织隔离、私有模型授权、IP 白名单、审计和计费；
- `publicDeploymentIds`/`protocols` 为空或省略时继承 Workspace 全部授权范围；非空时每次推理校验协议与请求模型是否在允许集，fallback 命中不在集内的模型必须 fail closed（与 runtime credential §10 一致）；
- 占用普通用户 API Key 数量配额（区别于 runtime credential 不占配额）；每账号活动 key 数量有上限，超限返回 `409 api_key_quota_exceeded`；
- 列表/单个接口只返回 `prefix`（前 8 + 后 4 字符），不返回 `secret`；`secret` 仅 `POST` 响应出现一次；
- `lastUsedAt` 由推理路径回写，用于 `apexnova usage` 展示 key 活跃度；
- 撤销、过期、账号停用、成员移除、Workspace 失权都必须导致鉴权失败；撤销操作写审计事件；
- token、secret 不得进入 URL、普通日志、trace、分析事件和 fixtures（脱敏为 `sk_****`）；
- OAuth scope 使用 §7.2 新增的 `api-keys:write` `api-keys:read` `api-keys:revoke`；未知 scope 拒绝。
- **重新授权要求**：三个新 scope 不在已签发的 access/refresh token 中。旧 token 调用 `/v1/api-keys` 会收到 `403 insufficient_scope`（错误码 `insufficient_scope`）。Connect 检测到此错误时提示用户重新 `apexnova login`；Hub 批准页面必须展示新增 scope 并要求明确同意。

与 runtime credential 的分工：

| | `kind=user`（`sk_`） | `kind=runtime`（`anrt_`） |
| --- | --- | --- |
| 默认 TTL | 永久 / 用户指定 | 24h 上限 |
| 设备绑定 | 否 | 是 |
| 占 key 配额 | 是 | 否 |
| Connect 用途 | 默认模式，`apexnova opencode` | `--rotating` 模式 |
| 自动轮换 | 不轮换 | Connect 在 OAuth 会话内自动续期 |

Connect 侧行为：默认 `POST /v1/api-keys`（永久）；`--rotating` 走现有 `POST /v1/runtime-credentials`；`--key <id>` 跳过创建，直接绑定已有 key。secret 只存 OS credential store，不写进 opencode 配置明文。

## 11. 推理入口补充契约

现有推理代码继续作为唯一数据面。H1 需要补：

1. `sk-` 与 `anrt_` 最终归一到现有 ApiKey/Workspace/计费路径；
2. 对 runtime credential 执行协议和公共模型范围校验；
3. 非流式、流式和错误响应都返回：

```text
X-Apexnova-Request-Id
X-Apexnova-Provider-Id: provider.apexnova-ai-hub
X-Apexnova-Requested-Model
X-Apexnova-Resolved-Model
X-Apexnova-Deployment-Id
```

`Deployment-Id` 是公共投影 ID，不是内部 `ModelDeployment.id` 或 `litellmModelId`。Fallback 后的 resolved model 和 deployment 必须与 `UsageLog` 的最终计费口径一致。

流式要求：

- 客户端断开向上游传播取消；
- 当前已有的中断账本和用量捕获继续生效；
- 响应头在首字节前已经确定；无法确定最终 fallback 时，不能伪造具体上游 Provider，可把最终 resolved 信息放在协议允许的流尾元数据或后续用量查询中；
- 未知是否产生副作用的 Agent 工具请求不得自动重试。

## 12. H2–H5 预留

### H2：兼容性

提供 Agent/Scenario 注册表、不可变 Evidence、版本化测试套件和 Verdict 查询。Hub 当前端到端探针只能证明服务可调用，不能代替 Agent 工具调用、结构化输出和会话行为测试。

### H3：推荐

`POST /v1/recommendations` 读取 Agent、场景、预算、区域和能力约束，输出候选、排除原因、Evidence、价格版本、置信度和显式商业推广标记。

### H4：显式路由

路由只为尚未发送的新请求选择公共 Deployment。实际响应必须揭示公共 Provider/Model/Deployment，不绕过用户的 Workspace、预算或模型策略。

### H5：托管 Agent

托管代码执行需要独立的 Repository Authorization、Workspace Sandbox、任务队列、构建、测试、部署凭证和供应链安全设计。普通 OAuth access token 或 runtime credential 不得直接获得源码仓库和部署权限。

## 13. 非功能要求

- 上游密钥进入现有加密 Credential/secret 管理链路，绝不进入公共目录；
- token 和 runtime credential 在日志、trace、错误响应和 fixtures 中自动脱敏；
- 账号、设备、凭证和组织相关操作写审计事件；
- 默认只记录计量元数据，不记录 prompt/response；
- 防护 SSRF、超大负载、流式连接耗尽、user code/token 枚举和重放；
- OAuth、目录、账单和推理分别定义 SLO；
- 目录快照可以安全缓存，但必须按授权主体隔离；
- 控制面错误明确 `retryable`，推理是否重试由客户端结合工具副作用决定。

## 14. Hub 仓库交付物

1. `openapi/apexnova-hub-v1.yaml`；
2. OAuth discovery 的 staging 地址；
3. account、catalog、billing、runtime credential、api-keys 和 inference 的脱敏 fixtures；
4. 可本地启动的 mock server 或稳定 staging；
5. API changelog、版本和弃用策略；
6. 测试账号及取消、过期、token 复用、零余额、私有模型、组织权限、限流、维护和上游错误场景；
7. 双方 CI 都能运行的 contract test suite；
8. nginx 路由、数据库迁移、回滚和安全评审记录。

## 15. H1 推荐实施顺序

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1 | OAuth/Device 数据模型、ApiKey runtime 字段和迁移 | 迁移实跑、约束测试、类型检查 |
| P2 | Device Flow、批准页、设备与 `/v1/me` | pending/slow_down/拒绝/过期/轮换/复用检测/撤销 |
| P3 | 公共目录投影、稳定 ID、ETag | 私有模型隔离、版本稳定、304、促销/授权变化 |
| P4 | 余额、促销、用量和估价 | 与现有计费函数和账本一致 |
| P5 | Runtime Credential、推理校验和公共响应头 | 设备登录→签发→流式 Responses→扣费→撤销 401 |
| P6 | OpenAPI、mock、fixtures 和跨仓 contract tests | Connect CI 可直接消费 |

## 16. H1 验收清单

- [ ] Device Flow 完成批准、拒绝、过期、`slow_down`、刷新轮换和旧 token 复用检测；
- [ ] api 子域正确路由 OAuth metadata 与 `/oauth/*`；
- [ ] 撤销设备后 access/refresh token 和该设备 runtime credential 立即失效；
- [ ] Runtime Credential 继承 Workspace、组织、模型、协议、限额与计费约束；
- [ ] `POST /v1/api-keys` 创建的 `sk_` key 可立即调用推理，响应头与 `anrt_` 一致；
- [ ] `expiresIn: null` 的 key 不过期，`expiresIn` 到期后鉴权失败；
- [ ] `GET /v1/api-keys` 与 `GET /v1/api-keys/{id}` 不返回 `secret`；
- [ ] `GET /v1/billing/usage?apiKeyId=...&granularity=day` 聚合金额与逐条求和一致；
- [ ] 按 key 用量不泄露内部 deployment、买价、prompt/response；
- [ ] `/v1/catalog/snapshot` 不泄露内部供应线路、买价或私有模型；
- [ ] 相同可见目录产生相同 catalogVersion/ETag；
- [ ] `/v1/models` 保持 OpenAI 兼容，完整目录只使用 `/v1/catalog/*`；
- [ ] 余额正确区分 normal、hold 和受模型限制的 PromoCredit；
- [ ] 估价与实际账单在相同输入和价格版本下口径一致；
- [ ] 一个真实模型可通过 `anrt_` 流式调用 Responses，响应揭示公共请求/最终模型和 Request ID；
- [ ] 日志、trace、错误响应和 fixtures 中不存在 secret、prompt、源码、买价或内部路由拓扑；
- [ ] OpenAPI、mock/staging 和跨仓契约测试可供 Connect CI 使用。

H1 全部通过后，Connect 才从 mock/contract 环境切换到 Hub staging；生产接入仍需单独的安全、计费和发布验收。

Connect 侧具体的 staging 解锁顺序和 contract test 见 [`hub-h1-integration-checklist.md`](hub-h1-integration-checklist.md)。

## 17. Connect M1 收口联调要求（2026-09-05）

Connect 已开始把独立 H1 probe 收入正式 CLI。当前不要求 Hub 新增端点，但下列现有契约成为 M1 发布阻塞项：

1. `POST /v1/pricing/estimate` 对固定 token 假设返回 `deploymentId/model/currency/billingMode/listAmount/amount/priceVersion/estimateOnly`，且与实际结算使用同一计价实现；
2. `POST /v1/runtime-credentials` 成功后，新的凭据必须立即出现在 `GET /v1/runtime-credentials`，并准确返回 `protocols` 与 `publicDeploymentIds`，供无费用续期确认使用；
3. OpenAI Responses 与 Chat Completions 的成功响应必须始终带 `X-Apexnova-Request-Id`、`X-Apexnova-Provider-Id`、`X-Apexnova-Requested-Model`、`X-Apexnova-Resolved-Model`、`X-Apexnova-Deployment-Id`；fallback 后也必须反映实际结果；
4. `/oauth/revoke` 必须幂等，并能在首次访问、冷启动和进程重启附近可靠完成。开发容器曾在该路由首次编译时触发内存阈值重启，导致客户端收到网络失败；Connect 会重试，但 staging 仍应消除该不稳定因素；
5. staging 必须至少提供一个可计费的 `openai-responses` Deployment，完成非流式、流式、撤销后 401、余额不足 402 和公共响应头 contract test；
6. 上述端点与字段变化必须同步更新 OpenAPI、fixtures 和双方 CI 使用的 contract tests。

Connect 的安全策略保持不变：估价使用 OAuth access token；真实推理只使用受 Deployment/协议约束的 runtime credential；自动续期不会为了验证凭据而偷偷产生一次推理费用。

### M1-HUB-01：请求级硬消费上限（新增，高优先级）

本机验收请求 `523d9ab3-0839-4b58-989a-c66bd596033f` 发送 `max_output_tokens: 8`，但 GLM 5.2 的账单记录为 17 input / 87 output tokens，实际 `0.000191 USD`，高于按 64 input / 8 output 假设得到的 `0.000080 USD` estimate。reasoning token、协议翻译或上游实现可能使客户端输出参数无法成为可靠的费用上限。

因此：

- Connect M1 只把 `/v1/pricing/estimate` 展示为非约束估价，并改用 64 input / 256 output 的保守假设；
- Hub 需要调查 Responses bridge 与上游对 `max_output_tokens` 的映射、usage 口径是否符合公开契约；
- 若产品需要“本次验证最多花 X”，Hub 必须提供服务端原子执行的请求级 hard spend cap（或等价的一次性预算凭据），在调用前预留、结算后释放，超过上限直接拒绝；客户端 header 或参数本身不能被当作安全边界；
- 在 hard spend cap 交付前，CLI 不提供 `--max-cost`，也不得使用“最高费用”“最多扣费”等承诺性文案。

Windows OpenCode 1.18.29 的真实 Agent 调用进一步验证了这个需求：用户消息仅要求返回固定短串，但 Agent 自身系统上下文使 Hub 最终计量达到 6964 input / 7 output tokens，实扣 `0.006978 USD`；同时 OpenCode 因自定义 Provider 没有静态价格元数据而在本地事件中报告 `cost: 0`。因此 Hub 的余额和 `/v1/billing/usage` 必须始终是费用事实来源，后续 Connect UI/CLI 应按 `X-Apexnova-Request-Id` 查询实际用量，不得照抄 Agent 的本地 cost 字段。该现象不要求 H1 新增端点，但会把用量查询与请求 ID 对账列为 M1 staging contract test 的必测项。
