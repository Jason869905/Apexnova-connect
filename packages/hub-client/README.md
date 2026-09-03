# Apexnova AI Hub Client

Apexnova AI Hub 公共 API 客户端，包括设备认证、凭证刷新、余额、模型目录和标准化错误。商业路由、上游密钥和内部管理接口不属于本包。

当前已实现认证基础模块：

- RFC 8628 OAuth 2.0 Device Authorization Grant；
- `authorization_pending`、`slow_down`、拒绝、过期和网络退避语义；
- refresh token 刷新、可选旋转和同一 profile 的 single-flight 并发控制；
- 通过 `HubSessionStore` 把一个完整会话作为单个 secret 存入 `CredentialStore`；
- HTTPS-only、同源端点路径、禁止 HTTP 重定向、请求超时和响应大小限制；
- UI prompt 只包含 `user_code` 与验证 URI，不包含 `device_code`。

默认端点为 `/oauth/device/code` 和 `/oauth/token`，可以配置为 Apexnova AI Hub 最终确定的同源路径。余额、模型目录、服务端注销/撤销与 OAuth discovery 尚未实现。当前测试全部使用 mock transport，不调用生产服务。

协议和安全边界见 [`../../docs/hub-authentication.md`](../../docs/hub-authentication.md)。
