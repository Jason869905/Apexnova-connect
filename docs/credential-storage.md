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
| Linux | 凭证文件（0700 目录 + 0600 文件） | **默认后端**（ADR 0036），见下方「凭证文件」 |
| Linux（显式选择 `system`） | Secret Service（`secret-tool`） | 已实现，需桌面 keyring 与真实平台验收 |
| macOS | Keychain（`security`） | 已实现，**从未在真实 macOS 上验收**，只有 mock command runner 测试。macOS 已按 [ADR 0024](decisions/0024-narrow-platform-claims.md) 移出支持范围，并自 [ADR 0027](decisions/0027-m2-exit-condition-two-platforms.md) 起**默认拒绝**（`UNSUPPORTED_PLATFORM`）。设 `APEXNOVA_ALLOW_UNVERIFIED_MACOS=1` 可显式启用，启用后它报告的一切按未验证对待。拒绝而非告警，是因为它处理的是秘密：一次半成功的写入会丢失或损坏凭据，而 stderr 上的一行告警不是同意 |

系统 helper 以 `shell: false` 启动，秘密通过 stdin 传输，不出现在进程参数中。macOS 的 `security add-generic-password` 只接受把密码作为命令行参数，因此写入走 `security -i` 交互模式，把整条命令（含密码）从 stdin 送入；读取与删除不涉及秘密，走普通参数。交互模式在单条命令失败后仍会返回 0，所以写入同时检查退出码与 stderr。helper 的 stdout/stderr 有大小限制，调用有超时；错误不会包含秘密或 helper 原始输出。

Windows Credential Manager 与当前用户的登录会话绑定。没有 credential set 的服务账号、网络登录或隔离运行环境会返回 `BACKEND_UNAVAILABLE`；应用不得因此降级到明文存储。

实现依据：[Microsoft CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)、[Microsoft CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) 和 [libsecret secret-tool](https://manpages.ubuntu.com/manpages/jammy/man1/secret-tool.1.html)。

## 凭证文件

Linux 的默认后端。不需要 `secret-tool`、D-Bus 或 sudo，装完 CLI 即可 `login`。Windows 默认仍是 Credential Manager。

```bash
apexnova init --credential-store system        # 改用操作系统凭证服务
APEXNOVA_CREDENTIAL_STORE=system apexnova ...  # 只对这个 shell 生效，优先级更高
```

文件位置：`$XDG_DATA_HOME/apexnova-connect/credentials.json`（默认 `~/.local/share/...`），Windows 为 `%APPDATA%\Apexnova\connect\credentials.json`。刻意不和 `config.json` 放在一起——后者是用户出问题时会贴进 issue 的那个文件。

关于这个后端必须说清楚的事：

- **秘密按原文存放，只靠文件权限保护**。headless 机器上没有任何操作系统秘密可以派生密钥，任何"加密"都得把密钥放在密文旁边，那是混淆而不是密码学保护。与其提供一个看起来更安全的假象，不如把真实保护边界写在这里：目录 0700、文件 0600、属主是当前用户。
- **默认不等于回退**。选了 `system` 而 keyring 不应答，仍然报 `BACKEND_UNAVAILABLE`，不会改写到文件：秘密在两个后端之间悄悄移动，会让一台机器一半凭证在这边、一半在那边。
- **权限被放宽时拒绝读取，而不是修好它**。文件一旦是 0644，秘密已经被机器上每个账号读过了，正确的动作是吊销重发，不是悄悄 `chmod` 然后继续。
- **解析失败时不重写文件**。不是 JSON 的文件是一个没人理解其内容的文件，覆盖它会毁掉用户仅存的会话。
- 写入走「同目录临时文件 + rename」，并用 `credentials.json.lock` 对其他 `apexnova` 进程加锁（30 秒过期），因为凭证续期和 `login` 是同一个文件上的读—改—写。
- `apexnova doctor` 在使用该后端时固定输出一条 `credential-protection` 警告：探针通过不等于安全。

## 非目标

- 不从其他客户端抓取 Claude、OpenAI 或第三方订阅 token；
- 不在凭证后端不可用时自动切换到另一个后端（Linux 的文件后端是**默认**，不是失败后的回退）；
- 不提供环境变量明文降级；
- 不在凭证包中实现 Apexnova AI Hub 登录协议；
- 不声称 JavaScript 运行时可以可靠清零不可变字符串。

设备授权和 token 刷新属于 `hub-client`。它们后续只依赖 `CredentialStore` 契约，不直接依赖 Windows、Linux 或 macOS 的具体实现。
