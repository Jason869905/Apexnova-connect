# Apexnova AI Hub Authentication

## 当前客户端契约

`@apexnova-connect/hub-client` 使用 OAuth 2.0 Device Authorization Grant。桌面端或 CLI 只有在用户明确点击登录后才发起授权，不在应用启动时自动创建 device code。

默认请求：

```text
POST /oauth/device/code
Content-Type: application/x-www-form-urlencoded

client_id=...&scope=...
```

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

同一 profile 的并发刷新会合并成一个请求，降低 refresh token 旋转时的竞争风险。当前没有实现服务端 token revoke；`logout()` 只删除本地凭证，不能代替设备撤销。

## 服务端待冻结项

- OAuth public client ID 与允许的 scopes；
- device authorization 和 token endpoint 最终路径；
- 是否保证颁发 refresh token，以及 rotation/reuse 规则；
- `account_id` 等 Apexnova AI Hub 扩展字段；
- token 最大尺寸与过期策略；
- 设备列表、单设备撤销和全局登出接口；
- OAuth Authorization Server Metadata/discovery 是否开放。

实现依据：[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) 和 [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html)。
