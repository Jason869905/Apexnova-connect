# CLI

M1 Developer Preview 的可执行 CLI。当前已实现：

```text
apexnova init [--hub-url <url>] [--client-id <id>] [--path-prefix <p>]
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

Hub 地址按 环境变量 > 配置文件 > 构建内置默认值 的顺序解析：

- 环境变量：`APEXNOVA_HUB_BASE_URL`、`APEXNOVA_OAUTH_CLIENT_ID`、`APEXNOVA_HUB_PATH_PREFIX`；
- 配置文件：`apexnova init` 写入的 `~/.config/apexnova-connect/config.json`（Windows 为 `%APPDATA%\Apexnova\connect\config.json`）；
- 内置默认值：仅由 `pnpm bundle` 产出的发布产物携带。

为避免开发版本误连生产环境，从源码构建的 CLI 不含内置默认值：三个来源都没有值时，Hub 命令以 `HUB_NOT_CONFIGURED`（退出码 2）失败并提示运行 `apexnova init`。`apexnova doctor` 的 `hub-endpoint` 检查会显示当前地址及其来源。

`--timeout` 是整个命令的期限，不是单次 HTTP 请求的期限（默认 120 秒）。失败后的补偿操作（撤销刚签发的凭据）使用独立期限，不会因为主操作已超时而被跳过。

版本号的唯一来源是 `apps/cli/package.json`；发布产物在打包时注入，源码构建时回读该文件，release workflow 会校验 git tag 与之一致。
