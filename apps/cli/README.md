# CLI

M1 Developer Preview 的可执行 CLI。当前已实现：

```text
apexnova detect [opencode]
apexnova inspect opencode
apexnova login | logout | whoami | balance
apexnova models [--agent opencode] [--protocol openai-responses]
apexnova connect opencode --deployment <id> --dry-run
apexnova verify opencode
apexnova doctor [opencode]
apexnova restore [transaction-id] [--list] [--dry-run]
```

所有命令支持统一 `--json` 信封和规范化退出码；Agent 命令支持显式 `--config <path>`。OpenCode 的路径发现、版本探测、脱敏配置检查与 JSONC change plan 位于 Integration 包。

`connect --dry-run` 不写配置、不创建凭证，并且 JSON 输出只含操作摘要，不含用户配置内容。经 Hub H1 官方 mock contract 后，`connect --yes` 已能签发 runtime credential、写入系统凭证库、事务化应用配置并验证，`apexnova run opencode` 只在子进程环境中注入 secret；失败自动回滚和撤销。live verify 与自动轮换仍等待 staging。

为避免开发版本误连生产环境，Hub 命令目前要求显式设置 `APEXNOVA_HUB_BASE_URL` 和 `APEXNOVA_OAUTH_CLIENT_ID`；仓库不提供隐式生产默认值。
