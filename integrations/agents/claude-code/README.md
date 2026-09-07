# Claude Code Integration

通过 Claude Code 官方文档中的 LLM gateway 配置，把 Claude Code 指向 Apexnova AI Hub。只使用官方允许的认证和 Gateway 能力，不抓取或复用第三方订阅令牌。

状态：`experimental`。

## 支持范围

| 项目 | 值 |
| --- | --- |
| 产品 | Claude Code `>=2.0.0 <3.0.0` |
| 平台 | Windows、macOS、Linux |
| 配置文件 | `~/.claude/settings.json`（Windows 为 `%USERPROFILE%\.claude\settings.json`） |
| 协议 | `anthropic-messages`（Hub 的 `/anthropic/v1/messages`） |
| 凭据 | `ANTHROPIC_AUTH_TOKEN`，只由 `apexnova run claude-code` 注入子进程环境 |
| 生效方式 | 需要重启 Claude Code |

## 受管理的字段

只写 `env` 块下的三个键，文件里的其他设置（`model`、`permissions`、`hooks`、注释等）逐字保留：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "<Hub protocols[].baseUrl 去掉 /v1/messages 后的根>",
    "ANTHROPIC_MODEL": "<deployment inferenceAlias>",
    "APEXNOVA_CONNECT": "managed"
  }
}
```

`APEXNOVA_CONNECT` 只是一个来源标记：它让 `inspect` 和 `restore` 能区分“这条 gateway 配置是 Connect 写的”和“用户/管理员自己配的”，不影响 Claude Code 的任何行为。

**配置文件里永远不写凭据。** Claude Code 的 settings `env` 块优先级高于 shell 环境变量，凭据一旦写进文件就再也无法由启动器覆盖或轮换。

## 已知限制

- **直接运行 `claude` 会失败。** 连接生效后 `ANTHROPIC_BASE_URL` 对所有 Claude Code 会话生效，但凭据只存在于 `apexnova run claude-code` 启动的进程里。自己直接跑 `claude` 会把请求发到 Hub 却没有凭据，被拒绝。要回到原状态请 `apexnova restore`。
- **Remote Control 与语音听写不可用。** base URL 指向非 Anthropic 主机时 Claude Code 会停用这两项功能。
- **不写项目级 `.claude/settings.json`。** 该文件会被提交进仓库并共享给所有克隆者。
- **settings 里已有凭据或 `apiKeyHelper` 时会警告。** 它们优先级高于启动器注入的凭据；`inspect` 与 `doctor` 会指出来（只报变量名，不读取也不输出值）。
- **模型名直传。** `ANTHROPIC_MODEL` 写的是 Hub 的 `inferenceAlias`，由 Hub 负责解析到实际部署。

## 断开与恢复

```bash
apexnova restore --list
apexnova restore <transaction-id> --dry-run
apexnova restore <transaction-id> --yes
```

恢复只撤销 Connect 写入的三个键并撤销对应凭据，用户之后添加的其他设置不受影响。

官方文档：[Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)。
