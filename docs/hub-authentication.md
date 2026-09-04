# Apexnova AI Hub Authentication

## 当前客户端契约

`@apexnova-connect/hub-client` 使用 OAuth 2.0 Device Authorization Grant。桌面端或 CLI 只有在用户明确点击登录后才发起授权，不在应用启动时自动创建 device code。

默认请求：

```text
POST /oauth/device/code
Content-Type: application/x-www-form-urlencoded

client_id=...&scope=...
```

H1 首批 scope：

```text
account:read catalog:read billing:read usage:read
devices:read devices:revoke runtime-credentials:write
```

H1 只提供 OAuth 2 授权服务器，不宣称 OpenID Connect，因此不请求 `openid`、`profile` 或 ID Token。

轮询请求：

```text
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:device_code
&device_code=...
&client_id=...
```

刷新请求复用 token endpoint，使用 `grant_type=refresh_token`。Apexnova AI Hub 可以调整端点路径，但客户端只接受以 `/` 开头的同源路径，避免 device code 或 refresh token 被发送到其他 origin。

## 轮询规则

- 服务端没有返回 `interval` 时，从 5 秒开始；
- `authorization_pending` 保持当前间隔；
- `slow_down` 将本次及后续间隔增加 5 秒；
- 网络或超时错误使用指数退避，最高 60 秒；
- `access_denied`、`expired_token` 和其他 OAuth 错误立即终止；
- 本地到达 `expiresAt` 后不再请求 token endpoint。

应用 UI 可以显示 `user_code`、`verification_uri`、`verification_uri_complete` 和有效期。`device_code` 只存在于 `SecretValue`，不会传给 UI prompt。

## 会话存储

access token、refresh token 和相关 token 元数据序列化为一个版本化文档，再整体存入操作系统凭证存储。这样避免两个凭证分别更新造成明显的不一致窗口。refresh 响应未返回新 refresh token 时保留旧值；返回新值时覆盖旧值。

同一 profile 的并发刷新会合并成一个请求，降低 refresh token 旋转时的竞争风险。H1 完成后，正常 `logout()` 应先 best-effort 调用 `/oauth/revoke`，再删除本地会话；用户还可以通过设备 API 撤销该设备的全部会话和运行凭证。

OAuth access token 只用于控制面。Agent 推理使用 Hub 签发的短期 `anrt_` runtime credential，由 Connect 存入操作系统安全存储。这样可以复用 Hub 现有 ApiKey、Workspace、限额、组织权限和计费链路，避免 OAuth token 形成第二套推理身份。

## 服务端已确定项

- Device Authorization、Token 和 Revoke 路径分别为 `/oauth/device/code`、`/oauth/token`、`/oauth/revoke`；
- 授权服务器公开 metadata；若 issuer 使用 api 子域，nginx 必须显式暴露 metadata 与 `/oauth/*`；
- access token 仅控制面使用，推理使用 `sk-` 或 `anrt_`；
- refresh token 轮换，旧 token 复用会撤销整个 token family；
- 设备撤销级联撤销 access/refresh token 与 runtime credential。

## 仍待 Hub OpenAPI 冻结

- OAuth first-party public client ID；
- access/refresh token 最终 TTL 与 token 最大尺寸；
- `/v1/me`、设备和 runtime credential 的最终响应字段；
- staging issuer 与 production issuer。

实现依据：[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) 和 [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html)。
