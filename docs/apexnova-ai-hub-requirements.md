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

H2 追加 `compatibility:read`、`compatibility:write`、`compatibility:revoke`（见 12A.6 与 12C.4）。Connect 把它们放在**可选 scope**里：授权服务器的 `scopes_supported` 没有宣告时不请求，因此不会提前向用户弹出一个还不存在的权限。

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

提供 Agent/Scenario 注册表、不可变 Evidence、版本化测试套件和 Verdict 查询。Hub 当前端到端探针只能证明服务可调用，不能代替 Agent 工具调用、结构化输出和会话行为测试。具体接口需求见 [12A](#12a-h2-兼容性证据接口阻塞-m3-收口)。

### H3：推荐

`POST /v1/recommendations` 读取 Agent、场景、预算、区域和能力约束，输出候选、排除原因、Evidence、价格版本、置信度和显式商业推广标记。

### H4：显式路由

路由只为尚未发送的新请求选择公共 Deployment。实际响应必须揭示公共 Provider/Model/Deployment，不绕过用户的 Workspace、预算或模型策略。

### H5：托管 Agent

托管代码执行需要独立的 Repository Authorization、Workspace Sandbox、任务队列、构建、测试、部署凭证和供应链安全设计。普通 OAuth access token 或 runtime credential 不得直接获得源码仓库和部署权限。

## 12A. H2 兼容性证据接口（阻塞 M3 收口）

Connect 已经在本地跑通了完整链路：版本化能力测试套件、不可变 Evidence、TTL 与过期、Verdict 计算、公开矩阵生成、录制回放。2026-09-08 已对现网 4 个 Deployment × 2 个 Agent 完成首批真实采集，记录见 [Hub 联调清单](hub-h1-integration-checklist.md)。本节是把这批本地能力接到 Hub 所需的服务端交付，按 [ADR 0004](decisions/0004-m3-scope-and-evidence-path.md)「本地先行、后同步」的顺序，接口需求由真实记录反推而来。

数据形状已经冻结在 [`compatibility-evidence.schema.json`](../schemas/compatibility-evidence.schema.json)，Hub 不需要重新设计，只需要接收、存储、查询与发布。

### 12A.1 端点

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/v1/compatibility/evidence` | 提交一条 Evidence |
| `GET` | `/v1/compatibility/evidence` | 按 subject 维度查询，cursor 分页 |
| `GET` | `/v1/compatibility/evidence/{evidenceId}` | 取单条 |
| `POST` | `/v1/compatibility/evidence/{evidenceId}/revoke` | 撤回（不删除） |
| `GET` | `/v1/compatibility/test-suites` | 已登记的测试套件与版本 |
| `POST` | `/v1/compatibility/test-suites` | 登记一个套件版本 |

查询参数：`agentId`、`agentVersion`、`integrationId`、`integrationVersion`、`deploymentId`、`protocol`、`platform`、`suiteId`、`suiteVersion`、`sourceType`、`includeExpired`（默认 `false`）、`includeRevoked`（默认 `false`）、`cursor`、`limit`。

### 12A.2 不可变与更正

- Evidence 的 `id` 是内容哈希，提交幂等：同 `id` 同内容返回 `200` 与既有记录。**「同 `id` 不同内容」在实现里拿到的是 `400 evidence_hash_mismatch`，不是 `409 evidence_immutable`**——id 就是内容哈希，内容一变哈希必变，Hub 在校验阶段就拒了；`409` 只作为重放兜底存在（见 12C.3）；
- 记录一经接收**不可修改**。纠错只能提交新记录并填 `supersedes`，被指向的记录仍然可查；
- 撤回写 `revokedAt` 与原因，不删除历史。撤回后不得支撑当前 Verdict，但仍可按 ID 查到；
- Hub 不得改写提交内容中的任何字段（包括 `observedAt`、`expiresAt`），只能追加自己的接收元数据（`receivedAt`、提交主体、签名校验结果）。

### 12A.3 过期与版本

- 过期以记录自带的 `expiresAt` 为准，并且**逐条 capability statement 的 `expiresAt` 独立生效**——90 天的协议结论不因为同批 30 天的流式结论过期而作废；
- 测试套件按 `id` + semver 登记，登记时附能力定义摘要与 TTL 表。**套件 major 变化使旧记录不再支撑当前 Verdict**（仍可查询）；
- Agent 版本、Integration 版本、Deployment、协议、平台任一不同即为不同 subject，Hub 不得跨 subject 合并；
- Deployment 的实现发生变化（模型版本、Endpoint、上游供应线路）必须能使相关 Evidence 过期——这依赖 12A.5(a) 的指纹。

### 12A.4 Verdict 与发布

- Hub 可以提供服务端 Verdict 查询，但每个 Verdict 必须列出其依据的 Evidence ID 与规则版本，允许调用方自行重算；
- **`sourceType: provider-claim` 与实测记录必须分开存储且在 API 中可区分**。只有厂商声明时 Verdict 为 `unknown`，不得因为声明而变成 `compatible`；
- 公开矩阵只能来自已发布且未撤回的 Evidence；
- 社区提交（`community-test`）必须带签名与环境摘要，且默认不能单独让高风险能力达到最高置信度。

### 12A.5 现场实测暴露的服务端缺口

以下每条都来自 2026-09-08 的真实采集，是 M3 继续推进的实际阻塞项：

**(a) 公共目录不暴露上游 Provider 身份。** 现网 46 个 Deployment 全部报告 `providerId: provider.apexnova-ai-hub`。（原文另称 `providers` 数组为空，**该处有误**：那是 Connect 的 `models --json` 没有透出该字段，Hub 的目录恒返回一条 `provider.apexnova-ai-hub`，已更正，见 12B.5。）后果是 Evidence 的 `subject` 只能记「Apexnova」，**同一个 Deployment 换了上游供应线路，既有 Evidence 不会因此过期**，公开的兼容性结论会静默失真。
需求：公共投影暴露稳定的上游身份或不可逆的实现指纹（例如 `implementationFingerprint`，在模型版本、Endpoint 或上游线路变化时改变），并提供其变更时间点可查询。若上游身份属于商业机密，指纹方案即可满足需求。

**(b) 推理错误响应缺少 Request ID。** 观测到 `401` 与 `502` 响应不带 `x-apexnova-request-id`（例：`anthropic-messages` 上三次 502 无 ID、无用量记录，无法追踪也无法对账）。那三次 502 的归属未定——Hub 已确认应用层出口一律带该头，来源可能是 nginx；判别法与后续见 12B.5。Hub 同时确认「上游连不上的 502 不写用量记录」是真缺陷。
需求：**所有**推理响应（含 4xx/5xx）都返回该响应头，与成功路径一致。

**(c) 中断请求的计费口径不一致。** 12 轮采集中，客户端 abort 的流式请求有 11 轮在用量里查不到（数小时后仍然查不到，例如 `44c55922-3161-4620-881f-13cc514eeb98`），1 轮正常计费。
需求：明确中断的计费语义（按已产出 token 计费 / 不计费），并一致执行。

**(d) 用量查询无法区分「未结算」与「不计费」。** `GET /v1/billing/usage?requestId=` 对两者都返回空，客户端只能猜。Connect 因此一度把未结算显示成 `0.000000 USD`。
需求：对 Hub 已知的 requestId 返回明确状态（`pending` / `settled` / `not-billable`），不要用空结果表达三种含义。

**(e) `openai-responses` 路径上 `text.format.json_schema` 不生效。** 4 个 Deployment 全部如此，其中 `deepseek-v4-pro-0813` 与 `qwen3.8-flash` 在目录里明确声明了 `structured-output.json`。请求返回 `200`，内容是散文，不报任何字段错误；同批模型在 `anthropic-messages` 上用 tool 承载 schema 则 3/4 通过。
Hub 已核实**翻译层无误**（已翻成 `response_format.json_schema` 并写进上游请求体），忽略发生在上游且上游不报错，因此「透传后确认」不可行。真正的问题因此变成目录里那条 `structured-output.json` 的证据等级——处置见 12B.5 与 §J(e)。

**(f) 目录无法表达「支持 tools 但不支持强制 `tool_choice`」。** `qwen3.8-flash` 对 `tool_choice: required` 与 `tool_choice: {type:"tool"}` 一律返回 `400 litellm.BadRequestError`，但普通 tool 调用完全正常。
需求：能力声明区分「可调用工具」与「可强制指定工具」，否则调用方只能靠试错发现。

**(g) `discountRate` 的来源与有效期不透明。** 同一批 Deployment 的折扣率不同（`glm-5.2` 为 `0.5`，其余为 `1`），该字段目前只出现在估价响应里。
需求：在目录或估价响应中明确其来源、适用范围与有效期。

### 12A.6 Scope 与非功能

- 新增 `compatibility:read`（查询）与 `compatibility:write`（提交）。采集者身份写入记录，`compatibility:write` 不得下放给普通用户 token；
- 撤回需要单独权限（Hub 已实现为 `compatibility:revoke`），且写审计事件；
- Evidence 不得包含 prompt/response 原文。Connect 侧只提交结构化描述与内容哈希，Hub 应对提交内容做同样的拒绝性校验（凭据模式、体积上限）；
- 单条 Evidence 体积上限与提交速率限制需明确，超限返回明确错误码而非截断。

### 12A.7 交付物与验收

1. `POST/GET /v1/compatibility/*` 的 OpenAPI 3.1 定义与脱敏 fixtures；
2. 幂等提交、`supersedes` 链、撤回、过期过滤、`provider-claim` 与实测分离的 contract test；
3. 12A.5 中 (b)、(d) 两项作为 H2 的硬性前置——它们不修好，Evidence 的对账与追踪在服务端同样不成立；
4. Connect 侧对应实现为 `apexnova compatibility sync`（尚未开工，等本节接口冻结）。

## 12B. 对 Hub 回执的答复（2026-09-08）

针对 Hub 在 `infra/docs/hub-h1-connect-handoff.md` §H–§L（commit `f76251a`）的回复。**§H 四处全部确认，(c) 的口径已表态**，Connect 侧的改动已随本次提交落地。

### 12B.1 H-1 协议 id：按 Hub 的目录词表改，且只保留一种拼写

`protocolId` 枚举已加入 `openai-chat`、`openai-embeddings`、`openai-images`、`apexnova-media-images`、`apexnova-media-videos`。目录返回什么就是什么，不要求 Hub 改。

同时定死一条规则，避免出现「同一个协议两种拼写」把 subject 劈成两行：**`subject.protocol` 一律填目录返回的原值**。Connect 内部的 `openai-chat → openai-chat-completions` 归一化只用于 Agent/Integration 的能力声明（那套词表早于目录词表存在），不再进入 Evidence。首批 4 个 Deployment 用的是 `openai-responses` 与 `anthropic-messages`，两套词表下拼写相同，因此**既有记录无需迁移**。

### 12B.2 H-2 `id` 形制：接受 `ev.sha256.<64hex>`

已改为该形制并写进 schema 的 `pattern`。schema 同时保留识别 `evidence.<32hex>`——那是本形制定下之前已经写在本地库里的 12 条记录，它们不可变，只能被识别而不能被改写。Hub 侧按 `ev.sha256.<64hex>` 做主键校验即可；如果收到 `evidence.<32hex>`，那一定是补传的历史记录，可以按「无法服务端重算」处理或直接拒收，我们不依赖它们上行。

### 12B.3 H-3 canonical JSON：照单接受，向量已给

四步规则**逐字接受**，与 Connect 现有实现一致（此前只是没写下来，这一条 Hub 提得对）。规则已写进 `schemas/compatibility-evidence.schema.json` 的 `id.description`。

三条跨语言测试向量在 [`schemas/fixtures/evidence-canonical-vectors.json`](../schemas/fixtures/evidence-canonical-vectors.json)，机器可读，每条含 `input`、`canonical`（规范化后的字符串）、`sha256`、`id`：

| 向量 | 钉的是什么 |
| --- | --- |
| `minimal-record` | `id` 与 `signature` 被剔除；键递归排序 |
| `nested-arrays-keep-order` | 逐层排序，**数组顺序保持不动** |
| `unicode-and-escapes` | UTF-8 编码后哈希；引号、反斜杠、制表符、中文、星平面 emoji |

Connect 侧已在 contract test 里钉住（`packages/capabilities/tests/canonical-vectors.test.ts`）；请 Hub 直接读同一份 fixture，不要各自抄一遍常量。任一侧改动导致向量对不上，都应当按契约问题处理，而不是更新快照。

### 12B.4 H-4 指纹：进 `subject`，不走接收元数据

**选 `subject`**，与 Hub 的建议相反，理由是本地优先这条路会因为另一种选择而断掉：

1. **离线可验证**。Evidence 的公开价值在于任何人拿着记录就能重算、就能判断它测的是哪一版实现。指纹只存在于 Hub 的接收元数据里时，记录本身不自足；
2. **本地 Verdict 需要它**。按 ADR 0004，Connect 的矩阵与过期判定在本地完成、不依赖 Hub。指纹不在记录里，本地就永远无法因为实现变更而过期，只能等同步回来——那正是 12A.3 要解决的洞；
3. **「提交前多一次目录查询」对我们不成立**。`compatibility run` 本来就要拉目录来解析 deployment 和协议，指纹是同一次响应里的字段，零额外成本。

代价是解冻 schema，但这是**兼容的加法**：`subject.implementationFingerprint` 为可选，既有记录照常有效——它们只是无法因实现变更而过期，这一点如实反映了当时目录没有指纹的事实。`compatibility-evidence.schema.json` 与 `HubCatalogDeployment` 都已加好，Hub 的 P3 一上线，Connect 无需再改代码就会开始记录。

指纹进 `subject` 意味着它进内容哈希：同一 Deployment 换了实现，采到的就是另一条记录、另一个 id，而不是同 id 不同内容的冲突。

Hub 计划里的 `received.implementationFingerprint` 与 `derived.staleReason` 我们照常消费——对**不是我们采集的**记录（社区提交、历史记录），那是唯一的判据。两者不冲突：`subject` 是采集时的自证，接收元数据是服务端的旁证。

### 12B.5 §I 三条更正：两条我们认，一条待复现

1. **`providers` 为空是我们的错，已更正。** 原因是我读了 `apexnova models --json` 的输出，而那条命令**只输出 `deployments`**——hub-client 一直在解析 `providers`，是 CLI 没有透出来。我拿自己的输出形状当成了 Hub 的目录。已修：`models --json` 现在把 `providers` 一并输出；[ADR 0004](decisions/0004-m3-scope-and-evidence-path.md) 与 [Hub 联调清单](hub-h1-integration-checklist.md) 里的措辞已更正为「公共投影不暴露上游身份」，不再声称数组为空。**核心诉求不变**，Hub 也已确认，走 (a) 的指纹方案。

2. **502 的归属待复现，判别法已接受。** 我们没有保留那三次响应的响应体，所以现在无法归属；清单里的措辞已从「Hub 返回 502 且不带 request-id」改为「来源未定，判别法见下」。套件的失败详情本来就会记录网关错误消息的前 120 字节，`{"error":…}` 与 `<html>…502 Bad Gateway` 一眼可分——下次复现会带着这段进 Evidence。感谢确认「上游连不上那条 502 不写用量记录」是真缺陷。

3. **`json_schema` 的锅不在翻译层，已更正。** 清单原话是「疑似忽略」，现改为：Hub 的 responses bridge 已正确翻成 `response_format.json_schema`，忽略发生在上游，且上游不报错，因此**「透传后确认」这条路不存在**。这恰好印证了 M3 的前提：目录里的 `structured-output.json` 是厂商声明，不是实测——所以 §J 里 (e) 用 `capabilityStatements[]` 加证据等级、把没实测过的一律标 `provider-claim`，与我们的 Verdict 规则完全对齐（`provider-claim` 永不产生 `supported`，只有声明时读作 untested）。

### 12B.6 §J(c) 中断计费：同意 Hub 的倾向

**选「保留计费 + 补 `status=aborted, cost=0` 记录」。** 理由与 Hub 一致：上游已经完成生成并报了成本，那笔钱确实花了；客户端选择不读，不构成不该付。

我们原本的抱怨从来不是「不该计费」，而是**同一种请求有时查得到有时查不到**——(d) 修好之后每一轮都有明确状态，这个抱怨自然消失。财务正确加可查询，优于口径整齐但与实际成本脱节。

一个附带要求：`aborted` 记录请**带 requestId 且可按 requestId 查到**。Connect 的对账是逐 requestId 做的，只要它可查，`cost=0` 与 `cost>0` 都能如实呈现。

### 12B.7 §K 两件事的回应

1. **重新授权**：明白，不提前发。Connect 侧会在 `compatibility sync` 一起做；在 Hub 部署前不会向用户提示新 scope。
2. **`compatibility:write` 的采集者账户**：由维护者在带外提供给 Hub admin，本文不写账号。设备批准阶段就拒绝（而不是 token 阶段静默剔除）的做法我们赞成——静默剔除会让采集端一路跑到提交才失败，那时凭据已经签发、请求已经发出。

### 12B.8 我们这侧的下一步

- (b)(d) 上线后，Connect 会把「未结算 / 不计费」按 `settlementStatus` 如实呈现，替换现在「重试三次后仍未结算就报未结算」的近似做法；
- `compatibility sync` 等 §H 四处冻结、Evidence 端点可用后开工；
- M3 保持开启，直到 (b)(d) 落地并跑通一次真实同步——评审见 [ADR 0005](decisions/0005-m3-milestone-review.md)。

## 12C. Hub 第二次回执的处置（2026-09-09）

针对 Hub 在 `infra/docs/hub-h1-connect-handoff.md` §H–§Y 的回复：§H 四处 Hub 全部接受（与 12B 一致，无需再改），12A.5 的七条缺口全部上线，六个 Evidence 端点可用。本节只记两件事——**Hub 的实现与本文哪里不一致**，以及 **Connect 这侧因此改了什么**。

### 12C.1 三处与本文不一致，以 Hub 的实现为准

1. **冲突码是 `400 evidence_hash_mismatch`，不是 `409 evidence_immutable`。** 理由成立：`id` 就是内容哈希，内容一变哈希必变，「同 id 不同内容」在校验阶段就被拒，走不到不可变性检查。12A.2 已改；`409` 留作重放兜底。`compatibility sync` 的冲突分支挂在 400 上。
2. **`evidence.<32hex>` 返回 `400 evidence_legacy_id`。** 与 12B.2 一致（我们说过可以拒收）。那 12 条本地记录不上行，只在本地被识别；sync 不得重试这个错误码。
3. **撤回必须带 `reason`**，否则 `400`；重复撤回幂等返 `200` 且不覆盖第一次的理由。撤回入口按此实现，重复撤回不算失败。

响应的 `payload` / `received` / `derived` 三块严格分开，正合 12A.2 「Hub 不得改写提交内容」的要求：Connect 只把 `payload` 落进本地存储（那是我们自己的原文，逐字节可校验），`received` 与 `derived` 只用于展示和判断，不回写进 Evidence。`supportsCurrentVerdict` 我们自己重算——按 [ADR 0004](decisions/0004-m3-scope-and-evidence-path.md)，本地矩阵本来就不依赖服务端 Verdict，本轮 Hub 没做服务端 Verdict 也不构成阻塞。

「被 supersede 的记录默认不从列表过滤掉」与我们一致（12A.2：被指向的记录仍然可查）；「带签名的记成 `unverified` 而不是 `valid`」也与 12A.4 的社区证据口径一致。

### 12C.2 七条缺口的消费方式

| 缺口 | Hub 交付 | Connect 这侧 |
| --- | --- | --- |
| (a) 实现指纹 | `implementationFingerprint` + `implementationChangedAt`，`null` 合法 | 指纹参与 subject 身份；`compatibility refresh` 另按 `implementationChangedAt` 判断 |
| (b) request-id | 九个推理端点 + BYOK + 边缘全带；边缘错误 `source:"edge"`、`edge_` 前缀且查不到 | 对账阶段不查 `edge_` 开头的 id，单独列出 |
| (c) 中断计费 | 保留计费 + `abortedAt`，requestId 可查 | 我们要的可查询性到位，(c) 的抱怨消解 |
| (d) 结算状态 | `settlementStatus` + 未结算金额为 `null` | 替换「重试三次仍为空就报未结算」的近似做法 |
| (e) 证据等级 | `capabilityStatements[]`，目前全是 `provider-claim` | 无需改动，已核对：缺席读作 unknown |
| (f) 强制工具选择 | 新能力位 `tool.choice.forced`，目前为空 | 不读目录能力位下结论；探针另排 |
| (g) 折扣 | `discount{rate,source,appliesTo,expiresAt}` | 估价响应已解析 |

几条要展开的：

**(a) 我们这侧原本有个洞，已修。** 12B.4 把指纹放进了 `subject`，也就进了内容哈希，但本地的 `sameSubject` 与矩阵的 `subjectKey` 并不比较这个字段——结果是同一个 Deployment 换实现前后采到的两条记录仍会并成一行，指纹等于白记。现在指纹参与 subject 身份：换了实现就是另一个 subject，旧记录不再支撑新实现的 Verdict，矩阵里也按实现分行并显示指纹前 12 位。没有指纹的历史记录只代表它自己，不会被读成「覆盖了某个已知实现」——这正是 12B.4 说的「它们只是无法因实现变更而过期」。

Hub 提醒的另外两点都已落地：LB 权重/优先级变化不改指纹（那本来就不该使证据过期）；**同一个值可能再次出现但 `changedAt` 是新的**——实现回退到旧版本时指纹会和旧记录重新相等，所以 `refresh` 除了比指纹，还比 `implementationChangedAt` 是否晚于该 subject 的最近观测时间，晚于就判到期。为此 `compatibility refresh` 现在总要读一次目录（此前只在有记录临近过期时才读），因为「实现有没有变」只有目录能回答。

**(b) 边缘错误的 id 不进台账。** 采集跑完后逐 requestId 对账，`edge_` 开头的直接不查——问了也是三次超时加一条永远不消失的警告——改为单列一条「未进台账、无法对账」。鉴权前失败的请求同理带 id 但查不到，我们不做特殊识别（没有前缀可依），它会停在「未结算」，那是如实的。

**(d) 三义合一的空结果没有了。** 只有 `pending` 值得再问一次；`not-billable` 与 `failed` 各自成列，不再计入「未结算」；金额 `null` 不读成 `0.000000`。Hub 没有返回 `settlementStatus` 的旧路径仍按金额判断，行为与从前一致。

**(e) 我们没有「目录说没有 → 判 incompatible」的分支。** 已核对：`provider-claim` 只进 claims 桶，永不产生 `supported`；任何能力缺席读作 `unknown`。(f) 同理，我们不拿目录能力位下支持与否的结论。要把「能否强制指定工具」变成结论，需要一条新的 Capability Definition 加一个探针，那是套件版本的事，排在 sync 之后。

**(g)** 按时段促销的 `expiresAt` 是本时段结束而非活动期结束，估价缓存不得跨过它。

### 12C.3 非功能

单条 64KB（超限 `413`，不截断）、60 次/分钟（`429` + `Retry-After`）、凭据模式扫描（命中 `400` 并指出字段路径）。sync 实现时：不截断、不重试 `400`、按 `Retry-After` 退避。契约向量按 12B.3 的原话执行——对不上一律按契约问题处理，不更新快照。

### 12C.4 Hub 要求我们做的两件事

1. **重新授权。** `compatibility:read`、`compatibility:write`、`compatibility:revoke` 已加进 CLI 的可选 scope。可选 scope 只在授权服务器 `scopes_supported` 里宣告时才请求，所以 Hub 部署前不会向任何用户提示新权限，部署后也不需要为此再发一版。
2. **采集者账号。** 由维护者带外报给 Hub admin，本文不写账号。Hub 已补上开通入口，未开通时批准页会明说「该应用请求了采集者权限，而你的账号没有被授予」，而不是笼统的「码无效」——这正是 12B.7 赞成的做法。

### 12C.5 尚未开工

- `compatibility sync`：§H 已冻结、端点已上线、非功能已明确，不再有阻塞项；
- `tool.choice.forced` 的探针与对应 Capability Definition（套件 minor 版本）；
- M3 保持开启，直到跑通一次真实同步——评审见 [ADR 0005](decisions/0005-m3-milestone-review.md)。

## 12D. Hub 第二次答复的落地（2026-09-09）

12C.5 列的八个问题 Hub 全部答复，`compatibility sync` 因此开工并随本次提交落地。契约以 Hub 仓库的 `openapi/apexnova-hub-v1.json` 为准（另有 `openapi/fixtures/`、`mock-server.mjs`、`contract.test.ts`），本节只记结论与两处需要 Hub 更正的地方。

### 12D.1 Q1/Q2 指纹：两条保证都拿到了

**稳定性（书面确认）**：盐来自 `APEX_FINGERPRINT_SALT`（未配置时由平台主密钥按固定字符串派生），与请求、时间、进程、节点无关；指纹的输入只有每条 `enabled` 上游线路的 `{credentialId, provider, upstreamModel, apiBase}`，取集合排序后的 canonical JSON。`catalogVersion` bump、价格、availability、LB 权重/优先级/rpm/tpm 都不是输入。反向成立：指纹变则 `catalogVersion` 一定跟着变。

这条保证是 12B.4（指纹进 `subject`）与 12C.2(a)（指纹参与 subject 身份）成立的前提。**若它日后失效，同一实现会在每次采集下生成新 subject，矩阵碎成一行一条记录——那是契约问题，不是本地缺陷。**

**初值**：Hub 已改为「从未观测到变化时 `implementationChangedAt` 返回 `null`」，判据是历史表里有没有前序行，而不是首次见到该值的时间。我们 12C.2(a) 的规则不变（`changedAt` 晚于该 subject 最近观测 → 判到期），`null` 时天然不触发，既有记录不会被一次性判到期。

> **部署前不要跑 `compatibility refresh`。** 现网仍是旧行为（首次观测即写 `changedAt = now`），跑了会把全部 subject 列进重采计划。Hub 部署带 `implementationChangedAt` 修复的版本之后再跑。

### 12D.2 Q3 契约：两处 OpenAPI 与实现不一致

1. **`Estimate` schema 里没有 `discount` 对象**，但 `fixtures/pricing-estimate.json` 里有，且 `appliesTo` / `expiresAt` 可为 `null`。我们按 fixture 实现（整块可选，null 容忍）。**请把它补进 schema**，否则 Hub 自己的契约测试与实际响应对不上。
2. **`UsageRecord.status` 可为 `null`**（`pending` / `failed` 时尚不知道成败）。OpenAPI 写清楚了，是我们的解析器原先要求它必须是 `success | error`——**这是 Connect 的缺陷，已修**。未修之前，结算完成前按 requestId 查询会报 `INVALID_RESPONSE`。

错误码表照单接受：400 系（`invalid_evidence`、`evidence_hash_mismatch`、`evidence_legacy_id`、`evidence_contains_secret`、`invalid_json` / `invalid_request` / `invalid_version`、`reason_required` / `reason_too_long`）、`413 evidence_too_large`、409（`evidence_immutable`、`suite_version_immutable`）、`404 evidence_not_found`、401/403 一律终态不重试；**只有 `429` 按 `Retry-After` 退避**。CLI 这条由既有的 `withRetry` 统一实现（只对 `RATE_LIMITED` 退避，最多 3 次、单次不超过 30 秒）。Hub 的 code 现在原样带到 CLI 输出（`HubClientError.apiCode`），不再被归一化成 `API_ERROR` 一个词。

查询参数与 12A.1 完全一致；`limit` 默认 50、上限 200，游标是上一页最后一条的 id 且只在同一组过滤下有效。

### 12D.3 Q4 套件登记：不是前置，但 sync 仍然先登记

Hub 确认直接 `POST evidence` 会照常接收（201），不拒绝也不自动登记。仍然先登记的理由是 Hub 自己给的：**不登记就没有 major，`derived.staleReason` 永远不会是 `suite-major-superseded`**，12A.3 要求的「套件 major 变化使旧记录不再支撑 Verdict」就落空一半。

`compatibility sync` 的第一步因此是登记 `apexnova.capability-suite` `0.2.0`，附 `CAPABILITY_DEFINITIONS_DIGEST` 与逐能力 TTL 表。登记失败不阻断提交，只警告；收到 `409 suite_version_immutable` 时按契约问题报出（有人用不同定义登记了同一版本，已经指向该版本的记录不再表示这份定义），不重试。

### 12D.4 Q5 签名：暂不签

Hub 澄清 `none`（没交签名）与 `unverified`（交了但未验）是分开的两档，12A.4 要的「厂商声明与实测分开」由 `sourceType` 满足，与签名无关。签名算法与密钥分发都未定，现在签只会得到 `unverified`，没有收益。**Connect 暂不签名**，等真有 `community-test` 来源时再一起定——那才是签名要解决的信任边界。

### 12D.5 Q6 限流与体积

60 次/分钟按账号、专用桶，与推理请求不共享（采集时的模型调用不会吃掉提交配额）；64KB 量的是解析后 `JSON.stringify` 的 UTF-8 字节数，含 `id` 与 `signature`，**不是** canonical 串（canonical 会剔掉那两个字段，只用于算哈希）。我们目前最大的记录约 3KB。

### 12D.6 Q7 验证环境

只有生产 `https://api.apexnova-consulting.com`。边缘错误的 `edge_` 前缀 Hub 已在生产实测（`429` + `application/json` + `source:"edge"`）；`settlementStatus` 与「未结算金额为 null」需要一条真实请求才看得到，排在 Hub 部署之后的第一轮真实采集里验。

### 12D.7 Q8 分工，写死

**公开矩阵由 Connect 仓库生成，Hub 只做存储、查询与派生判据。** 服务端没有也不打算有 `published` 状态或服务端 Verdict；`derived.supportsCurrentVerdict` 是 Hub 唯一的服务端判断，且判据（过期、撤回、被 supersede、stale）全部摊开，调用方可自行重算——这正是 12A.4 要求的。

[ADR 0005](decisions/0005-m3-milestone-review.md) 里「公开这件事还没有服务端支撑」据此结案：**不是等 Hub 补，而是 by-design 不在 Hub。** M3 的剩余条件因此只有一条：跑通一次真实同步。

### 12D.8 Connect 这次落地了什么

- **`compatibility sync`**：登记套件 → 提交本地记录 → 报告 Hub 的 `derived` 判断（`supportsCurrentVerdict`、`staleReason`、`fingerprint.match`、`signatureStatus`）。**只推不拉**：把别人的记录拉进本地库会直接影响我们生成的公开矩阵，而社区证据的信任规则依赖签名，签名方案还不存在（Q5）；
- **`compatibility revoke <id> --reason`**：撤回必须带理由，重复撤回幂等且保留第一次的理由；
- **登录**：Hub 不再因未授予的 scope 拒绝登录（`815f7ef`），CLI 如实报出「请求了但没拿到」的 scope，而不是等到第一次提交才失败；
- 那 12 条 `evidence.<32hex>` 记录在 sync 里被跳过并说明原因，不会反复撞 `400 evidence_legacy_id`。

### 12D.9 剩下的

- **跑通一次真实同步**（等 Hub 部署 + 采集者账号开通），M3 的最后一条退出条件；
- `tool.choice.forced` 的探针与 Capability Definition（套件 minor 版本）；
- 那 8 条 subject 用新 id 形制重采一遍，公开矩阵才在服务端有支撑。

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
