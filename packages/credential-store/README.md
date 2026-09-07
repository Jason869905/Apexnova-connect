# Credential Store

操作系统安全凭证存储抽象。调用方只使用逻辑 credential reference，不把长期密钥写入普通配置、日志或命令行参数。

当前实现包含：

- `SystemCredentialStore`：统一的命名空间、凭证键校验与 `SecretValue` 脱敏边界；
- Windows Credential Manager 后端，通过 PowerShell 固定脚本调用 Win32 API，秘密只经 stdin 输入；
- Linux Secret Service 后端，通过 `secret-tool` 调用桌面钥匙串，秘密只经 stdin 输入；
- `MemoryCredentialBackend`：仅供测试和开发注入，不允许作为生产降级方案。

macOS Keychain 后端基于 `security` 命令实现，但尚未在真实 macOS 上验收，只有 mock command runner 测试覆盖。`createDefaultCredentialStore()` 在不支持的平台会明确抛出 `UNSUPPORTED_PLATFORM`，不会把秘密写入明文文件。Windows 需要交互式用户登录会话关联的 credential set；Linux 需要系统已安装 `secret-tool` 且存在可用的 Secret Service 会话。缺少这些条件时返回 `BACKEND_UNAVAILABLE`。

`SecretValue` 的字符串和 JSON 表示始终为 `[REDACTED]`，只有显式调用 `reveal()` 才能取得内容。这能减少误记日志的风险，但 JavaScript 字符串无法保证在内存中被立即清零。
