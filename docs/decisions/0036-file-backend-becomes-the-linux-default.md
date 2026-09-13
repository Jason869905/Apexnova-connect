# 0036 Linux 默认后端改为凭证文件：放弃 keyring 作为前置条件

- 状态：已接受
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0035](0035-explicit-file-credential-backend.md)（文件后端，当天早些时候，显式选择才有）
- 结论：Linux 默认后端从 Secret Service 改为凭证文件；Windows 不变；「后端不可用不自动切换」原样保留

## 1. 为什么当天就改

ADR 0035 把文件后端做成了显式选项，理由是「用户没要求的降级不算同意」。那条推理本身没错，但它默认了一个前提：**keyring 是常态，没有 keyring 是例外**。这个前提在本项目的实际运行环境里不成立。

Secret Service 需要装 `libsecret-tools` 并有一个 daemon 挂在 D-Bus 上。桌面发行版满足，而本 CLI 真正在跑的地方是：容器、CI runner、headless SSH、WSL——**四类里没有一类默认满足**。于是「默认」这条路在多数机器上的实际形态是：

```
装 CLI（一行） → sudo apt-get install → dbus-launch → gnome-keyring-daemon --start → 空口令解锁 → login
```

五条命令，两条要 sudo，而且失败点在**设备授权批准之后**——用户已经开了浏览器、输了码、点了同意，才看到 `BACKEND_UNAVAILABLE`。

坚持这个默认换来的保护是：0。因为这些机器上根本没有 keyring，用户要么照着走完五条命令，要么放弃。没有人因为这个默认而更安全。

## 2. 改了什么

- Linux 默认后端 = 凭证文件（`~/.local/share/apexnova-connect/credentials.json`，目录 0700、文件 0600）；
- Windows 默认后端 = Credential Manager，**不变**：它在每个 Windows 会话里都在、已经验收过（[ADR 0032](0032-windows-verification.md)），拿它换便利是纯亏；
- macOS 默认仍是 `system`，这样 [ADR 0024](0024-narrow-platform-claims.md) 的拒绝照常触发，而不是被悄悄绕过去；
- 其他平台仍然抛 `UNSUPPORTED_PLATFORM`，消息里说明可以选文件后端。

安装脚本里那段 keyring 提示随之删除：默认路径已经不需要它，再印就是噪音。

## 3. 没有改的那条规则

**默认不是回退。** 点名了 `system`（`apexnova init --credential-store system` 或 `APEXNOVA_CREDENTIAL_STORE=system`）而 keyring 不应答时，命令照样报 `BACKEND_UNAVAILABLE` 并停下，绝不改写到文件。

理由不是洁癖：秘密在两个后端之间悄悄移动，会让一台机器一半凭证在 keyring、一半在文件里，而用户对此一无所知——「我的会话去哪了」比一个说明白的错误难查得多。默认可以是软的，切换必须是硬的。

## 4. 说清代价这件事，反而更重要了

文件后端只靠文件权限保护秘密，而现在它是多数用户会落到的那条路。所以提醒不是一次性的：

- `apexnova init` 每次都把「只受文件权限保护」写进 warnings，包括用户什么都没选、直接吃默认的情况；
- `apexnova doctor` 每次输出 `credential-protection` 警告，并说明怎么切回 `system`；
- README、CLI 指南、本文件都写明保护边界，不提供加密的假象（为什么不加密见 ADR 0035 第 3 节）。

## 5. 升级影响

从 v0.5.2 升上来的 Linux 用户，旧凭证在 keyring 里，新默认读文件，表现为「没登录」。重新 `apexnova login` 即可，或 `apexnova init --credential-store system` 继续用 keyring。**不做自动迁移**：迁移要么读 keyring 写文件（把秘密复制到保护更弱的地方，而用户没被问过），要么按后端探测决定用哪个（回到第 3 节那个「一半一半」的状态）。两个都比让用户重登一次糟。这个项目处于 pre-alpha，重登一次的代价是可以接受的；如果将来不可接受，正确做法是显式的 `apexnova migrate-credentials` 命令，而不是一次静默的读写。

## 6. 覆盖

- `packages/credential-store`：Linux 默认解析为 file、Windows 默认解析为 system、两个方向都可显式选择、点名 `system` 而 helper 缺失时仍抛 `BACKEND_UNAVAILABLE`、不支持平台不被悄悄塞文件后端；
- `apps/cli`：什么都不配的 Linux 会话 `doctor` 报 `credential-backend.file` + `credential-protection.file.built-in`，`init` 不带任何 flag 也会给出保护边界警告。
