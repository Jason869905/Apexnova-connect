# Codex + Apexnova AI Hub 使用指南

> 适用版本：apexnova-connect v0.2.1 · Codex CLI ≥0.20.0
> 平台：Windows、macOS、Linux

安装、登录、Hub 地址、Key 模式、通用命令和环境变量见 [CLI 通用指南](cli-usage-guide.md)。本文只讲 Codex 特有的部分。

## 快速开始

```bash
apexnova login
apexnova run codex
```

首次运行会让你选模型、创建 key、写配置并启动 Codex。之后直接启动。

```bash
apexnova run codex --deployment deployment.apexnova.xxx   # 指定模型
apexnova run codex --rotating                             # 用 24h 短期凭据
apexnova run codex -- --help                              # -- 之后透传给 Codex
```

## 只支持 Responses API

Codex 现在只接受 `wire_api = "responses"`，因此本集成**只声明 `openai-responses`**。只暴露 `openai-chat` 的 deployment 在 Codex 上不可用：

```
Error [PROTOCOL_NOT_SUPPORTED]: Codex only speaks the Responses API and cannot consume openai-chat-completions.
```

这是产品事实，CLI 不做协议转换。用 `apexnova models --agent codex` 只看能用的那些。

## 受管理的字段

配置文件：`$CODEX_HOME/config.toml`，默认 `~/.codex/config.toml`。

只写三处，其余内容（注释、其他 provider、profile、审批策略）逐字保留：

```toml
model = "<deployment inferenceAlias>"
model_provider = "apexnova"

[model_providers.apexnova]
name = "Apexnova AI Hub"
base_url = "<Hub protocols[].baseUrl 推导出的 /v1 根>"
env_key = "APEXNOVA_API_KEY"
wire_api = "responses"
```

写入是行级最小编辑：只替换根表的 `model` / `model_provider` 两行和 `[model_providers.apexnova]` 整段。写完会用 TOML 解析器重读一遍，值不符合预期就不生成计划。CRLF 文件保持 CRLF。

**配置文件里不会出现任何密钥。** `env_key` 只是变量名，密钥由 `apexnova run codex` 注入进程环境。

先看看会改什么：

```bash
apexnova connect codex --deployment deployment.apexnova.xxx --dry-run
```

## 已知限制

- **不写项目级配置。** 项目 `.codex/config.toml` 会被提交进仓库，且按 Codex 的规则也无法覆盖机器级 provider 设置，因此只写用户级文件；检测时会读它，但不会写。
- **不接管保留 provider id。** `openai`、`ollama`、`lmstudio` 是 Codex 内置 id，本集成固定用 `apexnova`。
- **无法安全编辑的布局会被拒绝。** 如果 `model_providers.apexnova` 是以内联表等形式写的，返回 `UNSUPPORTED_LAYOUT` 而不是猜测改写：

  ```
  Error [UNSUPPORTED_LAYOUT]: The Codex configuration declares model_providers.apexnova in a layout
  this integration cannot edit safely; move it to a [model_providers.apexnova] table or remove it.
  ```

- **需要重启 Codex。** 配置在启动时读取。
- **直接运行 `codex` 不会带上凭据。** 凭据只在 `apexnova run codex` 启动的进程环境里。
- **会改动你的默认模型。** `model` 是根表的键，连接会把它换成绑定的 deployment；`restore` 会原样改回去。

## 恢复

```bash
apexnova restore --list
apexnova restore <transaction-id> --dry-run
apexnova restore <transaction-id> --yes
```

只回滚 Connect 写入的内容并撤销对应凭据，之后你自己加的配置不受影响。已在真实环境验证：一份 90 行的 `config.toml` 连接后再恢复，与连接前逐字节一致（包括原来的 `model` 值）。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `PROTOCOL_NOT_SUPPORTED` | 该 deployment 只有 `openai-chat` | 换一个暴露 `openai-responses` 的 |
| `UNSUPPORTED_LAYOUT` | `model_providers.apexnova` 用了无法安全编辑的写法 | 改成 `[model_providers.apexnova]` 表或删掉 |
| `INVALID_CONFIG` | `config.toml` 不是合法 TOML | 修复语法；报错只给位置，不回显文件内容 |
| `AGENT_NOT_FOUND`（启动时） | Windows 上 PATH 里没有原生 `codex.exe` | 确认安装方式，npm 的 `.cmd` shim 无法直接 spawn |
| `detect` 显示 installed 但没有版本 | `codex --version` 没能正常完成 | 多见于缺少平台二进制的安装，重装即可 |

官方配置文档：<https://learn.chatgpt.com/docs/config-file/config-reference>
