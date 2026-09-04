# Hub H1 联调清单

本清单定义 Apexnova-connect 从 mock contract 切换到 Hub staging 的唯一入口条件。未通过前，CLI 保持 `connect` 写入、`switch`、live verify 和 runtime credential 自动轮换关闭。

## 服务端交付物

- OpenAPI 3.1 文档，覆盖 OAuth metadata、device flow、revoke、`/v1/me`、余额、原子目录和 runtime credential；
- 与 OpenAPI 同版本的脱敏成功/失败 fixtures 和非生产 staging 地址；
- OAuth client ID、issuer、允许 scope、access/refresh token TTL 与轮换规则；
- 控制面统一错误码、HTTP 状态、`retryable`、`Retry-After` 和 `X-Apexnova-Request-Id` 规则；
- staging 测试账号、Workspace 和至少一个同时支持 OpenAI Responses 或 Chat Completions 的公共 Deployment；
- runtime credential 的创建响应、单次 secret 字段、撤销、过期和设备级联撤销行为。

## Connect 已冻结的客户端假设

| 能力 | 客户端路径/字段 |
| --- | --- |
| Device flow | `POST /oauth/device/code`、`POST /oauth/token`，RFC 8628 字段 |
| 当前账号 | `GET /v1/me`，`accountId/userId/displayName/plan/defaultCurrency/context/device/scopes` |
| 余额 | `GET /v1/billing/balance`，十进制字符串金额和 `promoCredits` |
| 原子目录 | `GET /v1/catalog/snapshot`，`providers/models/deployments` 共用 `catalogVersion`；Deployment 使用 `inferenceAlias`、`availability.status` 和 `protocols[].protocol` |
| Runtime credential | `POST /v1/runtime-credentials` 返回 `{ credentialId, secret, expiresAt, workspaceId?, deviceId? }`；`DELETE /v1/runtime-credentials/{id}` |
| 推理入口 | `protocols[].baseUrl` 为无 credentials/query/fragment 的 HTTPS 协议端点；OpenCode adapter 在本地推导兼容 base URL |

如果 H1 OpenAPI 与以上投影不同，应在 `packages/hub-client` 的解析边界适配；不得把服务端临时字段直接扩散到 CLI 或 Agent Integration。

## staging contract test

1. discovery/issuer/endpoint 同源且全部 HTTPS；
2. pending、slow_down、批准、拒绝、过期和 refresh rotation 均符合 RFC 8628；
3. access token 只能访问控制面，不能直接访问推理；
4. `/v1/me`、余额和 catalog 的成功、401、403、429、5xx 与畸形响应映射正确；
5. 相同可见目录产生稳定 `catalogVersion`/ETag，权限或有效价格改变后版本变化；
6. runtime secret 只出现一次，日志、JSON 信封、异常和 fixtures 均不泄露；
7. runtime credential 限定协议、Deployment、Workspace 和 24 小时最大 TTL；
8. 撤销 credential、撤销设备、移除 Workspace 权限后推理立即失败；
9. OpenCode 配置应用成功后，最小非流式和流式请求返回公共请求/模型/Deployment 响应头；
10. 配置并发修改、验证失败和进程中断时 rollback/restore 可恢复，且 credential 被撤销。

## 解除功能门的顺序

1. `[mock passed]` OAuth discovery、`login/whoami/balance/models`；
2. `[mock passed]` runtime credential 创建、SecretValue 边界和立即撤销；
3. `[local passed]` OS credential store 抽象、`connect` apply + configuration verify + rollback + launcher；
4. `staging` read-only 控制面、真实 OS credential backend 和 runtime credential 推理鉴权；
5. 最小 live verify 和 credential 自动轮换；
6. Windows/Linux 真实环境验收；
7. OpenCode Integration 从 `planned` 升为 `experimental`。
