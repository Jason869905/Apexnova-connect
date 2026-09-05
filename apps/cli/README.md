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

`connect --dry-run` 不写配置、不创建凭证，并且 JSON 输出只含操作摘要，不含用户配置内容。`connect --yes` 能签发 runtime credential、写入系统凭证库、事务化应用配置并验证，`apexnova run opencode` 只在子进程环境中注入 secret；失败自动回滚和撤销。

`verify opencode --live` 先显示固定用量假设下的 Hub 非约束估价，追加 `--yes` 后才执行真实推理并验证公共路由响应头；估价不是锁价或消费上限。`run opencode` 会在凭据剩余有效期不超过一小时时进行带跨进程锁的预续期；Agent 启动后的长会话热轮换不属于 M1。

`restore` 必须按事务逆序执行。恢复一次 `switch` 会为上一个 Deployment/协议重新签发短期凭据后再回滚配置；恢复最初的 `connect` 会撤销当前凭据并安全断开。恢复链只记录目标元数据，不保留旧 runtime secret。

为避免开发版本误连生产环境，Hub 命令目前要求显式设置 `APEXNOVA_HUB_BASE_URL` 和 `APEXNOVA_OAUTH_CLIENT_ID`；仓库不提供隐式生产默认值。
