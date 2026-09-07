# Hermes Agent + Apexnova AI Hub 使用指南

> 适用版本：apexnova-connect v0.2.1 · Hermes Agent ≥0.21.0
> 平台：macOS、Linux（含 WSL2）——Hermes 没有原生 Windows 版

安装、登录、Hub 地址、Key 模式、通用命令和环境变量见 [CLI 通用指南](cli-usage-guide.md)。本文只讲 Hermes 特有的部分。

## 快速开始

```bash
apexnova login
apexnova run hermes
```

```bash
apexnova run hermes --deployment deployment.apexnova.xxx
apexnova run hermes --protocol anthropic-messages --deployment deployment.apexnova.xxx
```

在 Windows 上 `apexnova detect` / `doctor` 不会列出 Hermes——manifest 没有声明该平台。请在 WSL2 里使用。

## 三种协议都支持

Hermes 是四个 Agent 里唯一三种协议全支持的，通过 `model.api_mode` 选择：

| Hub 协议 | Hermes `api_mode` |
|---|---|
| `openai-responses` | `codex_responses` |
| `openai-chat-completions` | `chat_completions` |
| `anthropic-messages` | `anthropic_messages` |

不指定 `--protocol` 时按 deployment 暴露的顺序选第一个可用的。本集成**总是显式写出 `api_mode`**，不留给 Hermes 自动探测，避免 Responses 的部署被悄悄当成 chat completions。

## 受管理的字段

配置文件：`$HERMES_HOME/config.yaml`，默认 `~/.hermes/config.yaml`。

只写顶层 `model:` 块下的五个键，YAML 的注释、缩进和其他所有设置逐字保留：

```yaml
model:
  default: <deployment inferenceAlias>
  provider: custom
  base_url: <Hub protocols[].baseUrl 推导出的根>
  api_key: ${APEXNOVA_API_KEY}
  api_mode: chat_completions | codex_responses | anthropic_messages
```

这与 Hermes 官方 `hermes model` 向导写自定义端点时用的字段完全一致。`api_key` 写的是**变量引用**而不是密钥；`managed` 的判定就是它恰好引用 `APEXNOVA_API_KEY`，不需要额外的标记键。

先看看会改什么：

```bash
apexnova connect hermes --deployment deployment.apexnova.xxx --dry-run
```

## 关键：`.env` 会覆盖注入的凭据

`~/.hermes/.env` 是用 **`override=True`** 加载的，也就是说**它会覆盖启动器注入的进程环境变量**——这与 Hermes 文档站声称的优先级相反。

因此：

- 本集成**不写 `~/.hermes/.env`**，凭据只由 `apexnova run hermes` 注入进程环境；
- `inspect` 和 `doctor` 会扫描 `.env` 的**变量名**（不读取、不输出任何值），发现里面定义了 `APEXNOVA_API_KEY` 就明确警告：

  ```
  APEXNOVA_API_KEY is defined in ~/.hermes/.env, which Hermes loads over the process
  environment; it will override the credential the launcher injects. Remove it from .env.
  ```

如果你以前用 `hermes model` 向导配过 Apexnova 端点，很可能就在 `.env` 里留了一份——按上面的提示删掉。

## 已知限制

- **直接运行 `hermes` 不会带上凭据。** `${APEXNOVA_API_KEY}` 解析不到时 Hermes 会保留字面占位符并报错。
- **不写 `custom_providers`。** 官方向导会额外往那个列表写一条让连接出现在 `hermes model` 菜单里。本集成不写——受管理字段越少、恢复越干净；代价是这条连接不出现在该菜单中。
- **不接管 `fallback_model`。** 故障转移配置由你自己掌握。
- **需要重启 Hermes。** 配置在启动时读取。
- **会改动你的默认模型和 provider。** `model.default` 和 `model.provider` 都是被管理的键，`restore` 会原样改回去。

## 恢复

```bash
apexnova restore --list
apexnova restore <transaction-id> --dry-run
apexnova restore <transaction-id> --yes
```

已在真实环境验证：一份 250+ 行、含 36 行注释的 `config.yaml`，经过「连接（responses）→ 切换到 anthropic-messages → 逆序恢复两次」后，与连接前逐字节一致（`provider: auto` 和原来的 OpenRouter 地址都复原）。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| Windows 上 `detect` 看不到 Hermes | manifest 没有声明 windows | 在 WSL2 里使用 |
| Hermes 报凭据无效，但 CLI 显示已连接 | `.env` 里定义了 `APEXNOVA_API_KEY`，覆盖了注入值 | 从 `~/.hermes/.env` 删掉该变量 |
| Hermes 里看到 `${APEXNOVA_API_KEY}` 字面量 | 不是由 `apexnova run hermes` 启动的 | 用 `apexnova run hermes` 启动 |
| `INVALID_CONFIG` | `config.yaml` 不是合法 YAML，或 `model` 不是映射 | 修复语法；报错只给位置，不回显文件内容 |
| `inspect` 显示 `Managed: no` | 当前端点不是 Connect 写的（如 OpenRouter 默认值） | 正常；`connect` 后会变成 yes |

配置面的实机核实记录（v0.21.0，含每条结论的源码依据）见 [Integration README](../integrations/agents/hermes/README.md)。
