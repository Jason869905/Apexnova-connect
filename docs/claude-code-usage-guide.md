# Claude Code + Apexnova AI Hub 使用指南

> 适用版本：apexnova-connect v0.2.1 · Claude Code ≥2.0.0 <3.0.0
> 平台：Windows、macOS、Linux

安装、登录、Hub 地址、Key 模式、通用命令和环境变量见 [CLI 通用指南](cli-usage-guide.md)。本文只讲 Claude Code 特有的部分。

用的是 Claude Code 官方文档中的 [LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect) 机制，不抓取也不复用任何第三方订阅令牌。

## 快速开始

```bash
apexnova login
apexnova run claude-code
```

```bash
apexnova run claude-code --deployment deployment.apexnova.xxx
apexnova run claude-code -- --help    # -- 之后透传给 Claude Code
```

## 协议

Claude Code 走 `anthropic-messages`，对应 Hub 的 `/anthropic/v1/messages`。`apexnova models --agent claude-code` 只列出暴露该协议的 deployment。

## 受管理的字段

配置文件：`~/.claude/settings.json`（Windows 为 `%USERPROFILE%\.claude\settings.json`）。

只写 `env` 块下的三个键，文件里其他设置（`model`、`permissions`、`hooks`、注释等）逐字保留：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "<Hub protocols[].baseUrl 去掉 /v1/messages 后的根>",
    "ANTHROPIC_MODEL": "<deployment inferenceAlias>",
    "APEXNOVA_CONNECT": "managed"
  }
}
```

`APEXNOVA_CONNECT` 只是来源标记：让 `inspect` 和 `restore` 能区分「这条 gateway 配置是 Connect 写的」和「用户/管理员自己配的」，同时记录用的是哪种凭据模式。它不影响 Claude Code 的任何行为。

**配置文件里永远不写凭据。** Claude Code 的 settings `env` 块优先级**高于** shell 环境变量，凭据一旦写进文件就再也无法被启动器覆盖或轮换。

## 两种凭据模式

### 默认：启动器注入

凭据只存在于 `apexnova run claude-code` 启动的进程里。

> **注意副作用**：连接生效后 `ANTHROPIC_BASE_URL` 对**所有** Claude Code 会话生效，但凭据只在上面那个进程里。**直接跑 `claude` 会把请求发到 Hub 却没有凭据，被拒绝（401）**，而不是回退到你原来的登录。

### `--api-key-helper`：让 Claude Code 自己取

```bash
apexnova connect claude-code --deployment deployment.apexnova.xxx --api-key-helper --yes
```

额外写一个指向本 CLI 的顶层 `apiKeyHelper`：

```json
{ "apiKeyHelper": "\"<node>\" \"<apexnova.mjs>\" credential print claude-code --profile default" }
```

Claude Code 每隔 `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`（默认 5 分钟）调一次，`credential print` 只输出凭据本身，并在短期 credential 快过期时先续期。**这样直接运行 `claude` 也能用。**

代价：Apexnova-connect 可执行文件移动后 helper 会失效（Claude Code 会报 helper 失败）。

改回默认模式时，Connect 只删掉**自己写的** `apiKeyHelper`；用户自己配的那一个不会被动，`inspect` 会指出它优先级更高。

## 已知限制

- **Remote Control 与语音听写不可用。** base URL 指向非 Anthropic 主机时 Claude Code 会停用这两项功能。
- **不写项目级 `.claude/settings.json`。** 该文件会被提交进仓库并共享给所有克隆者。
- **settings 里已有凭据或第三方 `apiKeyHelper` 时会警告。** 它们优先级高于启动器注入的凭据；`inspect` 与 `doctor` 会指出来——**只报变量名，不读取也不输出值**。
- **需要重启 Claude Code。** 设置在启动时读取。
- **模型名直传。** `ANTHROPIC_MODEL` 写的是 Hub 的 `inferenceAlias`，由 Hub 解析到实际部署。

## 恢复

```bash
apexnova restore --list
apexnova restore <transaction-id> --dry-run
apexnova restore <transaction-id> --yes
```

只撤销 Connect 写入的键并撤销对应凭据。已在真实环境验证：一份 225 行的 `settings.json` 经过「连接 → 切 helper 模式 → 切回默认 → 逆序恢复三次」后，与连接前逐字节一致。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 直接跑 `claude` 报 401 | 默认模式下凭据只在 `apexnova run` 的进程里 | 用 `apexnova run claude-code`，或改用 `--api-key-helper`，或 `restore` |
| helper 失败 | Apexnova-connect 可执行文件被移动 | 重新 `connect --api-key-helper` 让它写入新路径 |
| `inspect` 警告 `ANTHROPIC_AUTH_TOKEN` 已在文件里 | settings 的 env 块优先级更高，会盖掉注入的凭据 | 从 settings.json 里删掉它 |
| `PROTOCOL_NOT_SUPPORTED` | 该 deployment 不暴露 `anthropic-messages` | 换一个，或用 `apexnova models --agent claude-code` 筛选 |
| `INVALID_CONFIG` | `settings.json` 不是合法 JSON | 修复语法；报错只给位置，不回显文件内容 |

官方文档：<https://code.claude.com/docs/en/llm-gateway-connect>
