# 0035 凭证文件后端：显式选择才有，绝不自动降级

- 状态：已接受，部分被 [ADR 0036](0036-file-backend-becomes-the-linux-default.md) 取代（第 2 节的「只能显式选择」在 Linux 上已改为默认；其余各条仍然有效）
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0024](0024-narrow-platform-claims.md)（收窄平台声明）、[ADR 0027](0027-m2-exit-condition-two-platforms.md)（两个平台的退出条件）
- 结论：新增 `FileCredentialBackend`，只能由 `apexnova init --credential-store file` 或 `APEXNOVA_CREDENTIAL_STORE=file` 点名启用；「后端不可用不自动降级」这条规则原样保留

## 1. 要解决的问题

Linux 上唯一的后端是 Secret Service，它要求两件事同时成立：装了 `secret-tool`，并且 D-Bus 后面有一个 keyring daemon 在应答。桌面发行版默认满足，**容器、CI、headless SSH 和 WSL 默认都不满足**，而这三类恰好是本项目最常见的运行环境。

于是安装路径变成了：装 CLI（一行）→ `sudo apt-get install libsecret-tools gnome-keyring` → `dbus-launch` → `gnome-keyring-daemon --start --components=secrets` → 空口令解锁 → 才能 `login`。中间任何一步没做，用户看到的是设备授权**批准之后**才失败的 `BACKEND_UNAVAILABLE`。

## 2. 为什么不是"自动降级"

原来的非目标写的是「不提供明文文件或环境变量自动降级」。这条继续有效，一个字都没放松：

- keyring 装了但没应答，仍然 `BACKEND_UNAVAILABLE`，不会改写文件；
- `UNSUPPORTED_PLATFORM` 仍然抛出，只是消息里多了一句还有哪条路可选。

被允许的只有一件事：**用户自己说要用文件**。理由和 ADR 0024 拒绝 macOS 时是同一条——stderr 上的一行告警不是同意；反过来，配置文件里写下的一行、或者命令行上打出来的一个 flag，是。

## 3. 不加密，以及为什么

headless 机器上没有任何操作系统秘密可以派生密钥。任何"加密"都必须把密钥放在密文旁边，那是混淆穿上了密码学的外衣——它唯一可靠的效果是让用户以为自己被保护着。所以这个后端按原文存放秘密，用它真正能提供的东西保护：0700 目录、0600 文件、属主是当前用户。这句话写在 `doctor` 的每次输出里、`init` 的警告里、README 和指南里。

配套的三条边界，都是"宁可停下也不要悄悄继续"：

- **权限被放宽（如 0644）时拒绝读取，而不是 `chmod` 修好**。文件一旦世界可读，秘密已经暴露过了，正确动作是吊销重发；自动收窄权限只会把这个事件藏起来。
- **解析失败时不重写文件**。不是 JSON 的文件是没人理解其内容的文件，覆盖它会毁掉用户仅存的会话。
- **写入走同目录临时文件 + rename，并用 `.lock` 对其他进程加锁**（30 秒过期）。运行时凭据续期和另一个终端里的 `login` 是同一个文件上的读—改—写，丢一次更新就是掉一个会话。

## 4. 存放位置刻意不和 `config.json` 同目录

凭证走 `$XDG_DATA_HOME/apexnova-connect/credentials.json`（默认 `~/.local/share/...`），而不是 `~/.config/apexnova-connect/`。`config.json` 是用户出问题时会截图、会贴进 issue 的那个文件，秘密不该躺在它旁边。

## 5. 安装脚本只提示，不动系统

`install.sh` 在 Linux 上检测 `secret-tool` 与 D-Bus 会话，缺失时打印两条路（装 keyring，或选文件后端），**不执行任何一条**：一行安装脚本不该在用户没要求的情况下 `sudo apt-get`，也不该替用户做这个安全取舍。

## 6. 覆盖

- `packages/credential-store`：文件读写、权限拒绝、损坏文件不覆盖、默认不选中、拼错的后端名拒绝、无系统后端的平台可用；
- `apps/cli`：`init --credential-store file` 写入配置并给出警告、`doctor` 在真实文件后端上跑通探针并附带 `credential-protection` 警告、环境变量覆盖配置文件、非法值按用法错误退出。
