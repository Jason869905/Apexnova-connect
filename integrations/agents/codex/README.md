# Codex Integration

Connects the [Codex CLI](https://github.com/openai/codex) to Apexnova AI Hub through Codex's own custom model provider mechanism.

状态：`experimental`。

## 支持范围

| 项目 | 值 |
| --- | --- |
| 产品 | Codex CLI `>=0.20.0` |
| 平台 | Windows、macOS、Linux |
| 配置文件 | `$CODEX_HOME/config.toml`，默认 `~/.codex/config.toml` |
| 协议 | 仅 `openai-responses` |
| 凭据 | `env_key = "APEXNOVA_API_KEY"`，由 `apexnova run codex` 注入进程环境 |
| 生效方式 | 需要重启 Codex |

## 受管理的字段

只写三处，其余内容（注释、其他 provider、profile、审批策略）原样保留：

```toml
model = "<deployment inferenceAlias>"
model_provider = "apexnova"

[model_providers.apexnova]
name = "Apexnova AI Hub"
base_url = "<Hub protocols[].baseUrl 推导出的 /v1 根>"
env_key = "APEXNOVA_API_KEY"
wire_api = "responses"
```

配置文件里不会出现任何密钥。写入是行级最小编辑：只替换根表的 `model` / `model_provider` 两行和 `[model_providers.apexnova]` 整段；写完会用 TOML 解析器重读一遍，值不符合预期就不生成计划。

## 已知限制

- **只支持 Responses API。** Codex 的 `wire_api` 现在只剩 `"responses"`，因此只暴露 `openai-chat` 的 Deployment 在 Codex 上不可用，`connect` 会返回 `PROTOCOL_NOT_SUPPORTED`，不做协议转换。
- **不写项目级配置。** 项目 `.codex/config.toml` 会被提交进仓库，且按 Codex 的规则也无法覆盖机器级 provider 设置，因此只写用户级文件。
- **不接管保留 provider id。** `openai`、`ollama`、`lmstudio` 是 Codex 内置 id，本集成固定使用 `apexnova`。
- **无法安全编辑的布局会被拒绝。** 如果 `model_providers.apexnova` 是以内联表等形式写的，集成返回 `UNSUPPORTED_LAYOUT` 而不是猜测改写。
- **直接运行 `codex` 不会带上凭据。** 凭据只在 `apexnova run codex` 启动的子进程环境里存在。

## 断开与恢复

```bash
apexnova restore --list          # 找到本次 connect/switch 的事务
apexnova restore <transaction-id> --dry-run
apexnova restore <transaction-id> --yes
```

恢复只回滚 Connect 写入的内容，并撤销对应凭据；之后手动添加的其他配置不受影响。
