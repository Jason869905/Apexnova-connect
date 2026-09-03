# Credential Storage

## 边界

Apexnova-connect 的普通配置只保存稳定的凭证引用，不保存 access token、refresh token、设备密钥或 API key。实际秘密交给操作系统凭证设施保存，integration 通过 `CredentialStore` 接口访问。

凭证键由以下三部分组成：

- `integrationId`：使用凭证的 integration；
- `accountId`：Apexnova AI Hub 账号或设备的稳定标识；
- `kind`：例如 `access-token`、`refresh-token`、`device-key` 或 `api-key`。

三部分使用 UTF-8 Base64URL 独立编码，形成版本化 account name，避免分隔符碰撞。默认 service name 是 `io.apexnova.connect`。

## 平台后端

| 平台 | 后端 | 当前状态 |
| --- | --- | --- |
| Windows | Windows Credential Manager（Win32） | 已实现，需交互式桌面会话验收 |
| Linux | Secret Service（`secret-tool`） | 已实现，需桌面 keyring 与真实平台验收 |
| macOS | Keychain | 尚未实现 |

系统 helper 以 `shell: false` 启动，秘密通过 stdin 传输，不出现在进程参数中。helper 的 stdout/stderr 有大小限制，调用有超时；错误不会包含秘密或 helper 原始输出。

Windows Credential Manager 与当前用户的登录会话绑定。没有 credential set 的服务账号、网络登录或隔离运行环境会返回 `BACKEND_UNAVAILABLE`；应用不得因此降级到明文存储。

实现依据：[Microsoft CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)、[Microsoft CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) 和 [libsecret secret-tool](https://manpages.ubuntu.com/manpages/jammy/man1/secret-tool.1.html)。

## 非目标

- 不从其他客户端抓取 Claude、OpenAI 或第三方订阅 token；
- 不提供明文文件或环境变量自动降级；
- 不在凭证包中实现 Apexnova AI Hub 登录协议；
- 不声称 JavaScript 运行时可以可靠清零不可变字符串。

设备授权和 token 刷新属于 `hub-client`。它们后续只依赖 `CredentialStore` 契约，不直接依赖 Windows、Linux 或 macOS 的具体实现。
