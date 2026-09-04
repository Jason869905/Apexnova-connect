# Apexnova AI Hub Client

Apexnova AI Hub 公共 API 客户端，包括设备认证、凭证刷新、余额、模型目录和标准化错误。商业路由、上游密钥和内部管理接口不属于本包。

当前已实现认证基础模块：

- RFC 8628 OAuth 2.0 Device Authorization Grant；
- `authorization_pending`、`slow_down`、拒绝、过期和网络退避语义；
- refresh token 刷新、可选旋转和同一 profile 的 single-flight 并发控制；
- 通过 `HubSessionStore` 把一个完整会话作为单个 secret 存入 `CredentialStore`；
- HTTPS-only、同源端点路径、禁止 HTTP 重定向、请求超时和响应大小限制；
- UI prompt 只包含 `user_code` 与验证 URI，不包含 `device_code`。
- 严格校验 `/v1/me`、`/v1/billing/balance` 和 `/v1/catalog/snapshot` 的控制面客户端；
- runtime credential 创建与撤销客户端，secret 只以 `SecretValue` 返回；
- 控制面 Request ID、认证、权限、限流、余额和网络错误映射；
- 拒绝目录中的 HTTP、URL credentials、query 和 fragment，且不保留未信任错误 details。

默认 OAuth 端点为 `/oauth/device/code`、`/oauth/token` 和 `/oauth/revoke`。控制面、设备登录、刷新、服务端注销与 runtime credential 已通过 Hub H1 官方 mock；OAuth discovery 和 staging 联调仍待完成。

协议和安全边界见 [`../../docs/hub-authentication.md`](../../docs/hub-authentication.md)。
