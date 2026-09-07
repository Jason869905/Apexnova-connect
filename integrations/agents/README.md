# Agent Integrations

AI Agent、Coding Agent、命令行助手和 Harness 的适配器目录。每个子目录对应一个外部产品，不共享产品特有配置代码；共享的只有 `schemas` 的契约、`sdks` 的投影和 `packages` 的公共能力。

| Integration | 状态 | 配置文件 | 协议 | 备注 |
| --- | --- | --- | --- | --- |
| [`opencode`](opencode/) | `experimental` | `opencode.json(c)` | openai-responses、openai-chat-completions | M1 已完成真实环境验收 |
| [`codex`](codex/) | `experimental` | `~/.codex/config.toml` | 仅 openai-responses | 待真实环境验收 |
| [`claude-code`](claude-code/) | `experimental` | `~/.claude/settings.json` | anthropic-messages | 待真实环境验收，且 Hub 的 anthropic 面尚未实测 |
| [`hermes`](hermes/) | `experimental` | `~/.hermes/config.yaml` | 三种协议全支持 | 配置面已在 v0.21.0 实机核实，待真实环境验收 |
| [`deepseek-harness`](deepseek-harness/) | 待调研 | — | — | 未开始 |

每个 Integration 都必须通过 `packages/integration-testing` 的公共 Contract Test 才能超出 `research` 状态。
