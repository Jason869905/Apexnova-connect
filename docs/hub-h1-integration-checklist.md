# Hub H1 联调清单

本清单定义 Apexnova-connect 从 Developer Preview 进入稳定 Hub staging 的入口条件。未通过前，相关能力只能在显式配置的开发/测试环境中使用，不得作为生产可用能力发布。

## 服务端交付物

- OpenAPI 3.1 文档，覆盖 OAuth metadata、device flow、revoke、`/v1/me`、余额、原子目录和 runtime credential；
- 与 OpenAPI 同版本的脱敏成功/失败 fixtures 和非生产 staging 地址；
- OAuth client ID、issuer、允许 scope、access/refresh token TTL 与轮换规则；
- 控制面统一错误码、HTTP 状态、`retryable`、`Retry-After` 和 `X-Apexnova-Request-Id` 规则；
- staging 测试账号、Workspace 和至少一个同时支持 OpenAI Responses 或 Chat Completions 的公共 Deployment；
- runtime credential 的创建响应、单次 secret 字段、撤销、过期和设备级联撤销行为。

## Connect 已冻结的客户端假设

| 能力 | 客户端路径/字段 |
| --- | --- |
| Device flow | `POST /oauth/device/code`、`POST /oauth/token`，RFC 8628 字段 |
| 当前账号 | `GET /v1/me`，`accountId/userId/displayName/plan/defaultCurrency/context/device/scopes` |
| 余额 | `GET /v1/billing/balance`，十进制字符串金额和 `promoCredits` |
| 原子目录 | `GET /v1/catalog/snapshot`，`providers/models/deployments` 共用 `catalogVersion`；Deployment 使用 `inferenceAlias`、`availability.status` 和 `protocols[].protocol` |
| Runtime credential | `POST /v1/runtime-credentials` 返回 `{ credentialId, secret, expiresAt, workspaceId?, deviceId? }`；`DELETE /v1/runtime-credentials/{id}` |
| 推理入口 | `protocols[].baseUrl` 为无 credentials/query/fragment 的 HTTPS 协议端点；OpenCode adapter 在本地推导兼容 base URL |

如果 H1 OpenAPI 与以上投影不同，应在 `packages/hub-client` 的解析边界适配；不得把服务端临时字段直接扩散到 CLI 或 Agent Integration。

## staging contract test

1. discovery/issuer/endpoint 同源且全部 HTTPS；
2. pending、slow_down、批准、拒绝、过期和 refresh rotation 均符合 RFC 8628；
3. access token 只能访问控制面，不能直接访问推理；
4. `/v1/me`、余额和 catalog 的成功、401、403、429、5xx 与畸形响应映射正确；
5. 相同可见目录产生稳定 `catalogVersion`/ETag，权限或有效价格改变后版本变化；
6. runtime secret 只出现一次，日志、JSON 信封、异常和 fixtures 均不泄露；
7. runtime credential 限定协议、Deployment、Workspace 和 24 小时最大 TTL；
8. 撤销 credential、撤销设备、移除 Workspace 权限后推理立即失败；
9. OpenCode 配置应用成功后，最小非流式和流式请求返回公共请求/模型/Deployment 响应头；
10. 配置并发修改、验证失败和进程中断时 rollback/restore 可恢复，且 credential 被撤销。

## 解除功能门的顺序

1. `[mock passed]` OAuth discovery、`login/whoami/balance/models`；
2. `[mock passed]` runtime credential 创建、SecretValue 边界和立即撤销；
3. `[local passed]` OS credential store 抽象、`connect` apply + configuration verify + rollback + launcher；
4. `staging` read-only 控制面、真实 OS credential backend 和 runtime credential 推理鉴权；
5. 最小 live verify 和 credential 自动轮换；
6. Windows/Linux 真实环境验收；
7. OpenCode Integration 从 `planned` 升为 `experimental`。

## M2 现网验收记录（2026-09-07，Windows 11 与 Linux/WSL2，`api.apexnova-consulting.com`）

用发布产物（`dist/apexnova.mjs`，内置生产 Hub 地址）在 Windows 侧完成。三个 Agent 各自跑完整生命周期，结束后全部恢复到连接前状态，配置文件逐字节一致。

- `[passed]` 凭证后端实测：`doctor` 的 credential-backend 检查真实写入探针值、读回、删除，Windows Credential Manager 通过；
- `[passed]` 目录：46 个 deployment，文本类全部同时暴露 `openai-responses` / `openai-chat` / `anthropic-messages`；
- `[passed]` **OpenCode 1.18.29**：`connect --dry-run` → `connect --yes` → 配置级 `verify` → `verify --live --yes`（请求 `c7c9c4d9-f10a-461e-9382-3e9fd92edb45`，9 input / 23 output，实扣 `0.000008 USD`）→ `switch` 到 glm-5.2 → 逆序 `restore` 两次；乱序 restore 被 `RESTORE_ORDER_CONFLICT` 拒绝，switch 的恢复重新签发了上一目标的凭据；
- `[passed]` **Codex 0.147.0**：`connect --yes` → `verify --live --yes`（请求 `1c7aa4e9-8d3c-47d4-9d8d-f25d30948295`，实扣 `0.000007 USD`）→ `restore`。写入内容与 dry-run 预览逐字节一致；3351 字节、90 行的用户 `config.toml` 只多出顶层两行与 `[model_providers.apexnova]` 一段，restore 后与连接前完全一致（`model = "gpt-5.6-sol"` 复原）；
- `[passed]` **Claude Code 2.1.233**：首次真实走通 `anthropic-messages`——runtime credential 按该协议签发，`/anthropic/v1/messages` 调用成功（请求 `cf0d50b0-655a-4372-a596-2322709e09b2`，实扣 `0.000007 USD`）。5958 字节、225 行的用户 `settings.json` 只多出一个 `env` 块；
- `[passed]` Claude Code 两种凭据模式：默认注入模式，以及 `--api-key-helper`（写入指向本 CLI 的 `apiKeyHelper`，`credential print` 输出 48 字符单行、无任何多余内容，符合 Claude Code 对 helper 的要求）；再次以默认模式 `connect` 时，自己写的 `apiKeyHelper` 被删除、标记回到 `managed`；逆序 restore 三次后文件逐字节还原；
- `[passed]` 计费对账：三次真实推理合计 `0.000022 USD`（余额 60.313920 → 60.313898），无残留 hold；结束后 `doctor` 全项 pass。

### Linux/WSL 补充验收（同日）

WSL 上 `org.freedesktop.secrets` 激活超时的原因是 keyring daemon 挂在另一条会话总线（`/tmp/dbus-*`）上，指向该总线后 Secret Service 可用；`doctor` 的 credential-backend 探针随即通过。

- `[passed]` **Hermes Agent v0.21.0**：`connect --dry-run` → `connect --yes`（`openai-responses` → `api_mode: codex_responses`）→ `verify --live --yes`（请求 `20a9479c-a4af-4372-b34d-d499abccbed1`，实扣 `0.000007 USD`）→ `switch --protocol anthropic-messages` 到 glm-5.2（`base_url` 变为 `/anthropic`、`api_mode: anthropic_messages`）→ `verify --live --yes`（请求 `839db2fb-dc22-42b5-8a50-897a568b0744`，实扣 `0.000263 USD`）→ 逆序 `restore` 两次。6188 字节的真实 `config.yaml` 只改动 `model` 块的五个键，restore 后逐字节一致（`provider: auto` / OpenRouter 复原）；
- `[passed]` Hermes 三种 `api_mode` 中的两种（`codex_responses`、`anthropic_messages`）经过真实推理验证；
- `[passed]` Linux 的凭证存储（Secret Service）与事务恢复流程。

未覆盖：macOS 全部流程（无实机，Keychain 后端只有 mock command runner 测试）；Hermes 的 `chat_completions` 模式未做真实推理。

## 本机 Docker 验证记录（2026-09-05）

Compose 项目 `apexagent` 的真实服务已完成以下验证：

- `[passed]` `web` 健康检查，以及 PostgreSQL/Redis 依赖健康检查；
- `[passed]` OAuth discovery、Device Authorization、token exchange；
- `[passed]` `/v1/me`、余额与原子 catalog snapshot；
- `[passed]` runtime credential 签发、推理面 Bearer 鉴权入口和成功后的自动撤销；
- `[passed]` 指定 `glm-5.2` 的最小 `openai-chat` 真实推理返回 HTTP 200；请求 `319f02cd-44c2-4326-a9d8-4c2ee76566f9` 记录为 17 input / 93 output tokens，实扣 `0.000203 USD`；
- `[passed]` 正式 CLI 经 Windows Credential Manager 完成登录、目录查询、`connect --dry-run`、`connect --yes`、配置验证、`switch`、配置事务逆序 `restore` 与 `logout`；`switch` 恢复时重新签发上一目标凭据的语义已由自动化 contract test 覆盖，仍待 staging 实测；
- `[passed with follow-up]` 正式 CLI 的 `verify opencode --live --yes` 经 `openai-responses` 调用 `glm-5.2` 成功，请求 `523d9ab3-0839-4b58-989a-c66bd596033f` 的公共路由头完整，账单为 17 input / 87 output tokens、`0.000191 USD`。实际费用高于原 64 input / 8 output 估价，已转为非约束估价并登记 `M1-HUB-01` 请求级硬消费上限需求；
- `[passed with follow-up]` Windows OpenCode CLI `1.18.29` 已完成真实 Agent 进程验收：Connect 保留用户现有 Provider，临时加入现行 `provider/npm/options` 配置，通过 launcher 仅在子进程环境注入 runtime credential；`opencode models apexnova` 识别 `apexnova/glm-5.2`，随后真实 Responses 请求返回精确文本 `APEXNOVA_OK`；Hub 请求 `55978fdf-a840-4673-b6a5-8f3e237cae6f` 归因到本次 runtime credential，记录 6964 input / 7 output tokens、实扣 `0.006978 USD`；
- `[passed]` 上述 OpenCode 配置事务已逆序恢复，恢复后文件 SHA-256 与测试前一致；runtime credential 已撤销，OAuth access/refresh token 均已服务端撤销。本次 `logout` 保留无活动 token 的设备审计记录，不影响授权安全；
- `[fixed]` OpenCode 官方现行配置使用单数 `provider`、`npm`、`options` 和模型覆写字段 `id`；此前按失效的 v2 文档实现的 `providers/package/settings/modelID` 已更正，并增加真实配置保留与回归测试；
- `[fixed]` Windows npm 安装的 `opencode.cmd` 不能被 Node `spawn(..., shell:false)` 直接启动；launcher 现在从 PATH 安全解析 npm shim 背后的原生 `opencode.exe`，不通过 shell 拼接 Agent 参数；
- `[passed with recovery]` runtime credential 与 access token 自动撤销；Hub 开发容器在首次编译 `/oauth/revoke` 时触发内存阈值重启，导致 refresh token 的第二次撤销未执行。本次设备已手工撤销，probe 已改为优先撤销 refresh token family、瞬态失败重试，再兜底撤销 access token。

本地编排还暴露出三个 Hub 侧开发环境问题：

1. `apexagent-nginx-1` 因宿主机 80 端口占用无法启动，直接访问 `web:3000` 会绕过 `/oauth` 与 `/v1` 的公开路径重写；
2. 非标准端口代理必须保留原始 Host 端口，否则 discovery 会把 `localhost:PORT` 错报为 `localhost`；
3. SaaS catalog 在本地生成 `api.localhost`，Windows Node DNS 不一定解析该特殊域名；live probe 允许用显式 `APEXNOVA_HUB_LOOPBACK_HOST_ALIAS=localhost` 仅在 loopback 测试中覆盖解析。

本机计费 live verify 与 Windows OpenCode 真实 Agent 流程均已通过，临时配置和活动凭据已清理。OpenCode 自身对未配置静态价格的自定义 Provider 报告 `cost: 0`，但 Hub 实际扣费 `0.006978 USD`；M1 必须继续把 Hub 余额/用量作为计费事实来源，不能展示 OpenCode 的本地 cost 为实际费用。后续发布门槛剩余稳定 staging contract test 与 Linux 真实环境验收，并须再次确认所有临时凭据撤销；不得通过修改余额、跳过计费或使用控制面 token 调推理来绕过该门槛。

## Linux 现网验收记录（2026-09-06）

在 WSL Ubuntu 上经 Hub 现网 `https://api.apexnova-consulting.com` 完成全流程验收。凭证后端为 `libsecret-tools` + `gnome-keyring-daemon`（D-Bus session bus），OpenCode `1.18.29` 为 Linux 原生 npm 安装（`~/.npm-global/bin/opencode`）。

- `[passed]` `detect opencode` 识别 Linux 原生 OpenCode `1.18.29`，配置路径 `/home/wanke/.config/opencode/opencode.jsonc`；
- `[passed]` OAuth device flow 登录现网，scope 含 `account:read catalog:read billing:read usage:read devices:read devices:revoke runtime-credentials:write`；
- `[passed]` `whoami`（`testpro@test.com`，personal plan）、`balance`（`26.592538 USD`）、`models`（原子目录含 GLM-5.2 等 30+ deployment）；
- `[passed]` `connect opencode --deployment glm-5.2 --dry-run` 与 `--yes`：runtime credential 签发、OpenCode 配置写入、配置验证均成功；
- `[passed]` `verify opencode --live --yes`：经 `openai-responses` 调用 `glm-5.2` 真实推理返回 HTTP 200，请求 `1984d5b9-83fe-44da-859c-9222c6d6daff`；**requestId 精确对账命中**——`GET /v1/billing/usage?requestId=1984d5b9...` 返回实扣 `0.000166 USD`（17 input / 70 output tokens），非约束估价为 `0.000608 USD`（64 input / 256 output assumed），两者差异证明对账的必要性；
- `[passed]` `restore --list` 与 `restore --yes`：配置事务逆序恢复成功；
- `[passed]` `logout`：本地会话删除，服务端 token 撤销（`serverRevoked: true`）；
- `[fixed]` `secret-tool lookup` 对不存在的条目返回 exit code 1（而非 0 + 空输出），`LinuxSecretServiceBackend.get` 之前将其当作后端故障抛出，导致首次 `connect`（无历史 binding）时 `RuntimeBindingStore.load` 失败。已修正：exit code 1 视为 not-found 返回 `null`，`delete` 同理容忍 exit code 1。

本机计费 live verify 与 Linux 真实环境验收均已通过，临时配置和活动凭据已清理。M1 发布门槛剩余稳定 staging contract test。
