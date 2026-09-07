# Hermes Agent Integration

把 [Hermes Agent](https://github.com/NousResearch/hermes-agent)（Nous Research）指向 Apexnova AI Hub，走它自己的 custom OpenAI 兼容端点机制。

状态：`experimental`。

## 实机核实记录（2026-09-07，Hermes Agent v0.21.0 / 2026.8.31，git 安装，Linux/WSL2）

公开文档站描述的 `providers.<id>.{base_url, api_key, models[]}` 结构**与实际不符**，以下以实机源码与 `hermes config` 输出为准：

| 项目 | 核实结果 | 依据 |
| --- | --- | --- |
| 配置文件 | `~/.hermes/config.yaml`，可由 `HERMES_HOME` 覆盖 | `hermes config path`；`hermes_cli/env_loader.py:319` |
| 凭据文件 | `~/.hermes/.env` | `hermes config env-path` |
| 自定义端点字段 | 顶层 `model:` 块下的 `provider` / `base_url` / `api_key` / `api_mode` / `default` | 官方向导 `hermes_cli/model_setup_flows_custom.py:153-161` |
| `provider` 取值 | 自定义端点固定为 `custom` | 同上；`model_switch.py` 的 `direct_alias_runtime_request` 对带 URL 的 alias 一律按 `custom` 路由 |
| `api_mode` 取值 | `chat_completions`、`codex_responses`、`anthropic_messages`，留空为自动探测 | `hermes_cli/main_provider_setup.py:359-369` |
| 凭据间接方式 | `api_key: "${VAR}"`，优先级 `api_key: "${VAR}"` > 字面量 `api_key` > `key_env` | `model_switch.py:302` |
| `${VAR}` 解析来源 | `os.environ`，因此**进程环境变量有效** | `hermes_cli/config.py:1546` `_env_ref_lookup` |
| 生效方式 | 配置在启动时读取，需要重启 | — |

### 一个必须知道的例外

`~/.hermes/.env` 是用 **`override=True`** 加载的（`hermes_cli/env_loader.py:350`），也就是说 **`.env` 里的同名变量会覆盖启动器注入的进程环境变量**。这与文档站声称的“环境变量 → `.env` → 配置默认值”相反。

因此本集成：

- **不写 `~/.hermes/.env`**，凭据只由 `apexnova run hermes` 注入进程环境；
- `inspect` / `doctor` 会扫描 `.env` 的**变量名**（不读取、不输出任何值），发现里面定义了 `APEXNOVA_API_KEY` 就明确警告：那一份会覆盖注入的凭据，必须先删掉。

## 支持范围

| 项目 | 值 |
| --- | --- |
| 产品 | Hermes Agent `>=0.21.0` |
| 平台 | macOS、Linux（Hermes 官方支持 Linux/macOS/WSL2，未提供原生 Windows 版） |
| 配置文件 | `$HERMES_HOME/config.yaml`，默认 `~/.hermes/config.yaml` |
| 协议 | openai-responses、openai-chat-completions、anthropic-messages |
| 凭据 | `APEXNOVA_API_KEY`，由 `apexnova run hermes` 注入进程环境 |
| 生效方式 | 需要重启 Hermes |

## 受管理的字段

只写顶层 `model:` 块下的五个键，YAML 的注释、缩进和其他所有设置逐字保留：

```yaml
model:
  default: <deployment inferenceAlias>
  provider: custom
  base_url: <Hub protocols[].baseUrl 推导出的根>
  api_key: ${APEXNOVA_API_KEY}
  api_mode: chat_completions | codex_responses | anthropic_messages
```

`api_key` 写的是变量引用，不是密钥本身。`managed` 的判定就是 `api_key` 恰好引用 `APEXNOVA_API_KEY`——不需要额外的标记键。

## 已知限制

- **直接运行 `hermes` 不会带上凭据。** 凭据只存在于 `apexnova run hermes` 启动的进程里，`${APEXNOVA_API_KEY}` 解析不到时 Hermes 会保留字面占位符并报错。
- **不写 `custom_providers`。** 官方向导会额外往 `custom_providers` 列表里写一条，让连接出现在 `hermes model` 菜单里。本集成不写，受管理字段越少、恢复越干净；代价是这条连接不出现在那个菜单中。
- **不接管 `fallback_model`。** Hermes 的故障转移配置由用户自己掌握。
- **`.env` 优先级见上。**

## 断开与恢复

```bash
apexnova restore --list
apexnova restore <transaction-id> --dry-run
apexnova restore <transaction-id> --yes
```

恢复只回滚 Connect 写入的五个键并撤销对应凭据。
