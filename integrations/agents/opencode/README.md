# OpenCode Integration

把 OpenCode 的 Provider 配置接到 Apexnova AI Hub 上的模型。这是本项目的第一个 Integration，也是 `apexnova run opencode` 这条一命令路径的对象。

## 支持范围

| 项目 | 值 |
| --- | --- |
| 产品 | OpenCode `>=1.18.29 <2.0.0` |
| 平台 | Windows、Linux（macOS 不在支持范围内，见 [ADR 0024](../../../docs/decisions/0024-narrow-platform-claims.md)） |
| 配置文件 | 按序查找：`--config` 指定的路径 → 工作目录下的 `opencode.jsonc`／`.json` → `$XDG_CONFIG_HOME/opencode/` → `~/.config/opencode/` → Windows 另加 `%APPDATA%\opencode\` |
| 协议 | `openai-responses`、`openai-chat-completions`（**同一个 Provider 计划里不能混用两者**） |
| 凭据 | `APEXNOVA_API_KEY`，只由 `apexnova run opencode` 注入子进程环境 |
| 生效方式 | 需要重启 OpenCode |

## 受管理的字段

只写 `provider.apexnova` 这一个分支，以及顶层 `model` 默认值：

```jsonc
{
  "provider": {
    "apexnova": {
      "name": "Apexnova AI Hub",
      "env": ["APEXNOVA_API_KEY"],
      "npm": "@ai-sdk/openai",
      "options": { "apiKey": "{env:APEXNOVA_API_KEY}", "baseURL": "…/v1" },
      "models": { "<alias>": { "name": "…", "limit": { "context": …, "output": … } } }
    }
  },
  "model": "apexnova/<alias>"
}
```

**配置里写的是 `{env:APEXNOVA_API_KEY}` 这个占位符，不是凭据本身**；真实凭据只存在于启动器注入的子进程环境里。JSONC 的注释与其余配置逐字保留。

## 已知限制

- **直接运行 `opencode` 不会带上凭据。** 凭据只存在于 `apexnova run opencode` 启动的进程里；自己跑 `opencode` 时 `{env:APEXNOVA_API_KEY}` 解析不到，请求会被拒。
- **OpenCode 自带 provider，因此"配置没被读到"不会表现为报错。** 它内置了 `opencode/*` 一组模型；如果我们写的配置不在它实际读取的位置，OpenCode 会照常作答、退出 0，**而请求走的是别人的账**。2026-09-13 实测过一次：`--config` 指向隔离路径时，网关记录到的请求数是 0，而 OpenCode 答得好好的（[ADR 0029](../../../docs/decisions/0029-launch-must-honour-the-configured-file.md)）。用 `apexnova audit` 的逐请求归属，或经 `--gateway` 运行，才能确认请求真的走了这条连接。
- **`--config` 只能指向 XDG 形状的路径。** OpenCode 认 `XDG_CONFIG_HOME`，但那是个目录变量，所以只有 `<目录>/opencode/opencode.jsonc`（或 `.json`）这种路径能被指过去；其他路径启动器会以 `LAUNCH_CONFIG_UNREACHABLE` 拒绝，而不是启动到另一份配置上。
- **Windows 上必须有 `opencode.exe`。** `.cmd` 无法以 `shell: false` 启动，本项目不使用 shell。同机存在多份安装时，检测与启动都以 PATH 上第一个 `.exe` 为准（[ADR 0033](../../../docs/decisions/0033-probe-what-the-launcher-starts.md)）。
- **WSL 里只有 Windows 安装时会被拒绝。** 只有 `/mnt/<盘符>/` 下的安装可用时，启动器报 `AGENT_NOT_FOUND` 并说明原因：那份安装读的是 Windows 用户的配置，而 Connect 配置的是 Linux 侧的——配置一份、启动另一份正是 M4 那次事故。
- **不支持旧的复数 `providers/package/settings` 配置。** 检测到会安全拒绝并要求迁移，不做猜测改写。
- **同一个 Provider 计划不能混用 Responses 与 Chat Completions。** 两者的 `npm` 适配器不同。

## 断开与恢复

`apexnova connect`／`run` 每次写入都会建立一个事务。`apexnova restore --list` 列出事务及其写过的文件路径，`apexnova restore <事务 id>` 逐字节还原并吊销这次签发的凭据。用 `--config` 建的事务，恢复时要带同样的 `--config`。

实现依据：[OpenCode Provider 文档](https://opencode.ai/docs/providers/)。
