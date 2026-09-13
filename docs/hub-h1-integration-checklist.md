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

未覆盖：macOS 全部流程（无实机，Keychain 后端只有 mock command runner 测试；**2026-09-12 已按 [ADR 0024](decisions/0024-narrow-platform-claims.md) 移出支持范围**）；Hermes 的 `chat_completions` 模式未做真实推理——**2026-09-12 已结清**：能力套件扩到该协议（0.4.0，[ADR 0025](decisions/0025-capability-suite-covers-chat-completions.md)），Hermes 四个 Deployment 已采集。

## M3 首批能力采集记录（2026-09-08，Linux/WSL2，`api.apexnova-consulting.com`）

首批四个 Deployment（见 [ADR 0004 修订](decisions/0004-m3-scope-and-evidence-path.md)）× 两个 Agent，共 11 轮（含两轮更正性重跑）。OpenCode 1.18.29 走 `openai-responses`，Claude Code 2.1.261 走 `anthropic-messages`。

| Deployment | 目录声明 | OpenCode / `openai-responses` | Claude Code / `anthropic-messages` |
| --- | --- | --- | --- |
| `glm-5.2` | tool.calling | `partial`（结构化输出不通过） | `compatible` |
| `glm-5.1` | 两项都不声明 | `partial`（结构化输出不通过） | `compatible` |
| `deepseek-v4-pro-0813` | tool.calling + structured-output.json | `partial`（结构化输出不通过） | `compatible` |
| `qwen3.8-flash` | tool.calling + structured-output.json | `partial`（结构化输出不通过） | `partial`（结构化输出不通过） |

以下为需要 Hub 侧处理或确认的结论：

- `[finding]` **`openai-responses` 路径上 `text.format.json_schema` 不生效：4 个 Deployment 全部不通过**，其中 `deepseek-v4-pro-0813` 与 `qwen3.8-flash` 在目录里明确声明了 `structured-output.json`。请求带 `text.format.json_schema` 且 `max_output_tokens: 256`，返回 HTTP 200 但内容是散文，未报任何字段错误。同一批模型在 `anthropic-messages` 上用 tool 机制承载 schema 则 3/4 通过，因此不是模型能力问题。**Hub 已核实翻译层无误**（已翻成 `response_format.json_schema` 写进上游请求体），忽略发生在上游且上游不报错，因此「透传后确认」不可行；真问题是目录里那条能力声明的证据等级——Hub 将新增 `capabilityStatements[]`，未实测的一律标 `provider-claim`；
- `[finding]` **`qwen3.8-flash` 拒绝一切形式的强制 `tool_choice`**：`litellm.BadRequestError: OpenAIException - The tool_choice parameter does not support being set to required or object`。它自身的 Tool Call 完全正常（不强制时两条协议都通过），但 `anthropic-messages` 的结构化输出必须靠强制指定 tool 承载 schema，因此该组合不可用；
- `[finding]` **被客户端 abort 的流式请求计费不一致**：12 轮采集里 11 轮的那条中断请求在用量里查不到，且数小时后仍然查不到（例如 `44c55922-3161-4620-881f-13cc514eeb98`、`0d14fcf7-eb31-4c82-88d2-20ea38eb9847`）；余下 1 轮该请求正常计费。不是「一律不计费」而是**同一种请求有时计费有时消失**，需要 Hub 明确中断的计费口径；
- `[finding]` **目录不暴露上游 Provider 身份**：46 个 Deployment 全部报告 `provider.apexnova-ai-hub`，公共投影不碰内部供应线路。Evidence 的 `subject` 因此只能记「Apexnova」，同一 Deployment 换了上游不会让既有 Evidence 过期。（原记录称 `providers` 数组为空，**系误记**：那是 Connect 的 `models --json` 未透出该字段，Hub 目录恒返回一条 `provider.apexnova-ai-hub`；已修 CLI 输出。Hub 将以带盐的 `implementationFingerprint` 补此洞。）
- `[observed]` `discountRate` 逐 Deployment 不同：`glm-5.2` 为 `0.5`，其余为 `1`；
- `[corrected]` 首轮（17:55）`glm-5.2` 在 `anthropic-messages` 上的 Tool Call、结构化输出和无效请求全部返回 HTTP 502（无 requestId、无用量记录），当时记为该组合不可用。**同一组合在 18:12 重跑得到 `compatible`（8/8 通过）**，因此那三次 502 是瞬时故障而非该 Deployment 的属性。两条 Evidence 都保留在库中，Verdict 取较新的一条——这正是不可变记录加时间序的意义。**归属已由 Hub 复核**：应用层所有错误早退都盖公共响应头，代码路径上不存在「返回 502 但不带 request-id」，最可能是 nginx 在 upstream 连不上时自己吐的。当时未保留响应体，无法回溯；下次复现按响应体前 200 字节判别（`{"error":…}` 为 Hub，`<html>…502 Bad Gateway` 为 nginx）。Hub 另确认「上游连不上的 502 不写用量记录」确为真缺陷，与 request-id 一并在 P1 修；
- `[fixed]` Connect 侧探针缺陷：`agent.single-tool-call` 原本发送强制 `tool_choice`，把「模型能否调用工具」测成了「端点是否支持强制指定工具」。`qwen3.8-flash` 因此被误记为不支持 Tool Call。已改为只声明工具不强制选择（Agent 真实的做法），套件版本升到 `0.2.0`，受影响的两轮已重跑更正；
- `[fixed]` Connect 侧计费缺陷：运行结束立即对账时 Hub 尚未结算，CLI 把未结算报成 `Billed: 0.000000 USD`。已改为重试后如实区分「已结算/未结算」并点名未结算的 requestId。

计费对账：当日 11 轮合计实扣 `0.008724 USD`，Hub 用量记录逐条吻合（成功请求计费，4xx/5xx 计 0，被中断的流式无记录）。每轮的 runtime credential 只作用于被测 Deployment，跑完即撤销。

## M3 服务端缺口的关闭记录（2026-09-09，Hub §H–§Y 回执）

12A.5 的七条缺口 Hub 已全部上线，六个 Evidence 端点可用，处置详见[需求 12C](apexnova-ai-hub-requirements.md)。逐条对照上一节的 finding：

- `[closed]` **(a) 实现指纹**：目录新增 `implementationFingerprint` 与 `implementationChangedAt`，`null` 为合法状态（未接上游），LB 权重/优先级变化不改指纹。Connect 侧同时修掉自己的一个洞：指纹此前进了 `subject` 和内容哈希，却没进本地的 subject 身份比较，换实现前后的记录仍会并成一行；现已参与身份，矩阵按实现分行。指纹回退到旧值的情形由 `implementationChangedAt` 兜住，`compatibility refresh` 因此每次都要读一次目录；
- `[closed]` **(b) request-id**：九个推理端点、BYOK 与边缘（nginx）全部带该头。边缘错误带 `source:"edge"` 与 `edge_` 前缀的 id，**那个 id 不在计费台账里**，对账阶段不再去查它，单列为「未进台账」。上一节那三次 502 的归属仍无法回溯（未留响应体），判别法照旧；
- `[closed]` **(c) 中断计费**：保留计费并补 `abortedAt`，requestId 可查——上一节「同一种请求有时查得到有时查不到」的抱怨随 (d) 一并消解；
- `[closed]` **(d) 结算状态**：`settlementStatus: pending/settled/not-billable/failed`，未结算时金额为 `null` 而非 `"0.000000"`。CLI 的「重试三次仍为空就报未结算」的近似做法已被替换：只有 `pending` 会再问，`not-billable` 与 `failed` 各自成列；
- `[closed]` **(e) 证据等级**：目录新增 `capabilityStatements[]`，目前全部为 `provider-claim`——`deepseek-v4-pro-0813` 与 `qwen3.8-flash` 那条 `structured-output.json` 声明因此如实降为厂商声明。**缺席即未知，不是 unsupported**；已核对 Connect 没有「目录说没有 → 判 incompatible」的分支；
- `[closed]` **(f) 强制工具选择**：新能力位 `tool.choice.forced`，目前存量模型无人勾选，短期内「没有」仍读作未知。`qwen3.8-flash` 的那条结论目前只来自我们自己的实测；把它变成一条可发布的能力结论需要新增 Capability Definition 与探针，排在 `compatibility sync` 之后；
- `[closed]` **(g) 折扣**：估价响应新增 `discount{rate,source,appliesTo,expiresAt}`，按时段促销的 `expiresAt` 是本时段结束而非活动期结束。

待办两项（Hub 要求，见需求 12C.4）：

- `[pending]` **重新授权**：`compatibility:read/:write/:revoke` 已加进 CLI 的可选 scope，授权服务器宣告后才会请求，因此不会提前向用户弹权限；Hub 部署后需要用户重新 `apexnova login` 才拿得到。Hub 已改为**丢弃未授予的 scope 而不是拒绝登录**，CLI 相应改为如实报出「请求了但没拿到」的 scope；
- `[pending]` **采集者账号**：`compatibility:write` / `:revoke` 需 Hub admin 服务端授予。账号已由维护者带外提供，等待开通，本清单不写账号。未开通时用户在批准页会看到明确的「采集者权限未授予」而非「码无效」。

## M3 同步链路就绪（2026-09-09，Hub 第二次答复）

Hub 答复了[需求 12C.5](apexnova-ai-hub-requirements.md) 提的八个问题，OpenAPI 与 fixtures 已在 Hub 仓库 `openapi/`。`compatibility sync` 与 `compatibility revoke` 据此实现，处置详见需求 12D。

> `[blocked]` **Hub 部署完成前不要跑 `apexnova compatibility refresh`。** 现网仍是「首次观测到指纹即写 `implementationChangedAt = now`」的旧行为，跑了会把全部 subject 判到期并列进重采计划（要 `--yes` 才会真的花钱，但计划本身是错的）。Hub 已修为「从未观测到变化则返回 `null`」，部署后即可正常使用。

- `[closed]` **指纹稳定性**：Hub 书面确认实现不变时指纹逐字节稳定，输入只有 enabled 上游线路的四元组集合；`catalogVersion`、价格、availability、LB 权重都不进指纹。这是指纹参与 subject 身份的前提；
- `[found]` **`Estimate` schema 缺 `discount` 对象**：`fixtures/pricing-estimate.json` 里有 `discount{rate,source,appliesTo,expiresAt}`，OpenAPI 的 `Estimate` 里没有。已按 fixture 实现（整块可选、容忍 null），请 Hub 补进 schema；
- `[fixed]` **`UsageRecord.status` 可为 `null`**：OpenAPI 写明未结算时为 null，我们的解析器原先要求 `success | error`——结算完成前按 requestId 查询会报 `INVALID_RESPONSE`。这是 Connect 的缺陷，已修；
- `[pending]` **一次真实同步**：`settlementStatus`、未结算金额为 `null`、以及提交链路本身都还没跑过真实请求。等 Hub 部署与采集者账号开通后跑一轮，那是 M3 的最后一条退出条件。

## M3 首次真实同步（2026-09-09，Linux/WSL2，`api.apexnova-consulting.com`）

采集者账号已开通，13 个 scope 全部授予。对 `glm-5.2` × OpenCode × `openai-responses` 跑一轮真实采集并上行，实扣 `0.002273 USD`。结论见[需求 12E](apexnova-ai-hub-requirements.md)。

- `[passed]` **提交链路成立**：记录被接收（`created: true`），`derived` 报 `supportsCurrentVerdict: true`、`fingerprint.match: "match"`、`signatureStatus: "none"`；重跑同一条返回 `created: false`，幂等如约；
- `[passed]` **指纹与初值**：46/46 deployment 带指纹，`implementationChangedAt` 全为 `null`，`compatibility refresh` 报「没有到期、也没有实现变更」；新采的记录 subject 带上了 `29870b6039ab19ad`；
- `[passed]` **`settlementStatus`**：4 条已结算、1 条 `not-billable`（被拒的无效请求）、未结算的金额为 `null`；
- `[observed]` **估价响应带 `discount{rate,source,appliesTo,expiresAt}`**（`0.5` / `promo` / `model` / `2026-09-30`），但 OpenAPI 的 `Estimate` schema 里没有这一块，请 Hub 补；
- `[corrected]` **「中断的流式请求查不到」是误判，已撤回**：台账行八条全在，`settlementStatus: not-billable`，两条带 `abortedAt`。我们的用量解析把 `promoCovered` / `balanceCovered` 的 `null` 当成错误，整条记录被吞，而对账又把解析失败归入「还没结算」。已修，(c) 与 (d) 关闭，详见[需求 12E.1](apexnova-ai-hub-requirements.md)；
- `[closed]` **套件登记不幂等**：同一份定义第二次登记返回 `409 suite_version_immutable`。Hub 侧的等值比较缺陷（jsonb 键序），已修部署，重登记验证返回 `200 already registered`；生产库里存的本来就是我们的真实定义，无需清理；
- `[fixed]` **目录的 `capabilityStatements` 我们没解析**：Hub 无条件下发，是 `control-plane-client.ts` 的白名单解析器里没有这个字段。已加，现网 43/46 个 Deployment 有值且全部 `provider-claim`。与 `promoCovered` 是同一类洞，处置见[需求 12F](apexnova-ai-hub-requirements.md)：Hub 的 fixtures 已收进 `schemas/fixtures/hub/` 并逐个喂进解析器；
- `[expected]` 鉴权前失败（401）的 requestId 查不到，与 Hub 说明一致。套件现在单独标出它，不再计进「未结算」；
- `[fixed]` Connect 侧两个洞：目录 `null` 解析会让整份目录读不了（`ea6e05e`）；`compatibility explain` 的 subject 键漏了指纹，换实现前后的记录会并成一行。

M3 的最后一条退出条件（跑通一次真实同步）**已满足**。

### 剩余 7 条 subject 的重采（同日 15:24–15:29）

`glm-5.2` × OpenCode 之外的 7 条全部重采并上行，本批实扣 `0.007382 USD`，当日合计 `0.009655 USD`。8 条记录现在都在 Hub 上（7 条 `created`、1 条重复提交返回 `existing`），逐条 `supportsCurrentVerdict: true`、`fingerprint.match: "match"`、`signatureStatus: "none"`。公开矩阵已重新生成。

- `[passed]` **结论与 9 月 8 日首批逐条一致**：Claude Code 在 `glm-5.2`/`glm-5.1`/`deepseek-v4-pro-0813` 上 `compatible`、`qwen3.8-flash` `partial`；OpenCode 四个全部 `partial`（都卡在 `agent.structured-output`）。跨一天、两条协议、四个 Deployment 复现了同样的判定；
- `[passed]` 每条新记录的 subject 都带上了目录指纹，矩阵按实现分行，与旧记录并列而不是覆盖它们；
- `[corrected]` 每一轮恰好有一条请求被报成「未结算」，逐轮核对都是 `protocol.cancellation` 那条。当时读成了「Hub 八轮八次都没写行」，实际是同一个解析缺陷被复现了八次——**同一个盲点重复八次不是八份证据**。行都在，见上；
- `[observed]` `qwen3.8-flash` × Claude Code 有两条 `not-billable`（其余各一条）：除了被拒的无效请求，强制 `tool_choice` 那条也被上游拒了，与 9 月 8 日记录的该模型行为一致。

公开矩阵现在有 16 行：8 条带指纹的新记录，加上 8 条 9 月 8 日采集、目录当时还没有指纹的旧记录。两者是不同的 subject（不同实现），不能合并显示——成对的行逐条给出同样的 Verdict，这本身就是一次跨日复现。

## 能力套件 0.3.0：强制工具选择（2026-09-09）

新增 `agent.forced-tool-choice` 探针，详见[需求 12G](apexnova-ai-hub-requirements.md)。一次运行从七个请求变成八个（六个计费）。

- `[passed]` **首次实测即复现 2026-09-08 的 finding**：`qwen3.8-flash` × `openai-responses` 对按名字强制的 `tool_choice` 返回 `400 litellm.BadRequestError`，同一轮的 `agent.single-tool-call` 仍是 `supported`。两个问题现在分开发布；
- `[passed]` 回放录制已按新套件重录（旧录制遇到新探针报 `RECORDING_INCOMPLETE`，是失效而不是降级），因此这条判定离线可复算；
- `[passed]` 套件 `0.3.0` 在 Hub 登记返回 `201`，新记录上行 `created: true` —— 顺带确认了 Hub 那次登记幂等性修复在**新版本**路径上同样正确；
- `[observed]` 这一轮的对账首次出现**零条未结算**：中断的流式请求正常读到 `not-billable`（`promoCovered` 的 `null` 修复之后），另加 1 条鉴权前失败、2 条不计费；
- `[passed]` 八条 subject 已全部按 `0.3.0` 重采（同日，本批实扣 `0.009940 USD`）并上行，`sync` 报 7 条 `created` / 9 条 `existing` / 0 失败，逐条 `supportsCurrentVerdict: true`、`fingerprint.match: "match"`。矩阵里这一列现在有完整数据；

### `agent.forced-tool-choice` 的分布，以及它解释了什么

| Deployment | OpenCode / `openai-responses` | Claude Code / `anthropic-messages` |
| --- | --- | --- |
| `glm-5.2` | supported | supported |
| `glm-5.1` | supported | supported |
| `deepseek-v4-pro-0813` | supported | supported |
| `qwen3.8-flash` | **unsupported** | **unsupported** |

`qwen3.8-flash` 在两条协议上都拒绝按名字强制指定 tool，其余三个模型两条协议都支持。

**这一列把此前混在一起的两个原因分开了。** 在此之前「`agent.structured-output: unsupported`」在两处出现，看起来是同一个结论：

- **`anthropic-messages` 上的 `qwen3.8-flash`**：该协议没有独立的结构化输出模式，schema 由**强制指定的 tool** 承载。所以那里的结构化输出失败**是强制 tool 被拒的后果**，不是一条独立发现——修好前者，后者自然消失；
- **`openai-responses` 上的四个模型全部失败**：包括三个 `forced-tool-choice: supported` 的模型。这一条与强制 tool 无关，仍然是 12A.5(e) 那条——上游忽略 `text.format.json_schema` 且不报错。

一条能力测的是一件事，因此两个原因才能被分开；这正是把强制选择从 `agent.single-tool-call` 里拆出来的收益。

- `[observed]` 七轮**全部零条未结算**（此前每轮固定一条）。`promoCovered` 的 `null` 修复之后，被中断的流式请求正常读作 `not-billable`，对账第一次是干净的。

## M4 Windows 证据的发布与验证（2026-09-10，Windows 11 与 Linux/WSL2，`api.apexnova-consulting.com`）

[ADR 0007](decisions/0007-m4-scope-and-recommendation-path.md) 决策 5 把「补 Windows 采集」列为 M4 第一批任务。**采集本身在 2026-09-09 20:33–20:37 UTC 就已完成并上行**，本次做的是把它发布进公开矩阵、复核服务端状态，并验证 `recommend` 在该平台上确实成立。本次没有新的推理请求，因此不产生新计费。

- `[passed]` **8 条 Windows 记录已在 Hub 上**：`compatibility sync` 报 `24 of 24 (0 new, 24 already held by Hub)`，逐条 `existing`、`supportsCurrentVerdict: true`、`fingerprint.match`。12 条早期 id 形式按契约被跳过。**这同时是指纹稳定性的第二平台复核**——M3 收口所依赖的那条前提（[ADR 0006](decisions/0006-m3-closure.md)），在跨平台的记录上再次对得上；
- `[corrected]` 本次开始时判断「Windows 证据还没同步」，依据是本地找不到同步痕迹。**CLI 根本不保存同步账本，所以那个依据不成立**；实际状态由 `sync` 的回执给出，不是由本地文件的缺席推出来的；
- `[passed]` **`recommend` 在 `windows-x64` 上有支撑，且不借用别的平台**：Claude Code 2.1.233 与 OpenCode 1.18.29 均为 `4 eligible of 46 considered`，逐条引用的是 Windows 记录本身（例如 OpenCode 第一名引 `ev.sha256.ac0710a5…`）。排序与 Linux 一致：Claude Code 三个满分加 `qwen3.8-flash` 0.556，OpenCode 三个 0.778 加 `qwen3.8-flash` 0.556。ADR 0007 决策 5 的闭环合上；
- `[passed]` **判定跨平台复现**：8 对 subject 的 9 项能力逐格一致——Claude Code 在 `glm-5.2`/`glm-5.1`/`deepseek-v4-pro-0813` 上 `compatible`、`qwen3.8-flash` `partial`；OpenCode 四个全部 `partial`。**其中只有 OpenCode 是纯平台对照**（两侧同为 1.18.29）；Claude Code 两侧分别是 Windows 2.1.233 与 Linux 2.1.261，同时差了一个 Agent 版本，因此那四对不能当作平台单变量的结论；
- `[fixed]` **Windows 采集暴露了矩阵渲染的身份缺陷**（`79f370f`）：能力表只带 agent、deployment、protocol 三列，而 subject 身份一直包含 platform 和 Agent 版本，于是 Windows 行与 Linux 行渲染成逐字节相同的两行。同批修正：Evidence 列表补全整个 subject（含 integration 及其版本），排序补到 subject 全字段——此前排到 protocol 就停，其余交给证据库遍历顺序，重新生成可能重排没人动过的行；
- `[fixed]` **`EvidenceSubject.scenarioId` 自 M0 声明至今无人读写**（`3714369`）：Scenario Quality 在 M4 之后引入，届时一条按 Scenario 采的记录会被当作对 Agent 的一般性结论，矩阵也会把两个 Scenario 并成一行。根因是同一条身份规则在仓库里有三份拷贝（verdict 匹配、矩阵、`explain`），加字段只会改到想起来的那一份；现已收敛为 `subjectIdentity` 一处。公开矩阵重新生成后除时间戳外逐字节不变——库里没有任何记录带 Scenario，这正是修它的时机；
- `[observed]` **一次 `recommend claude-code` 偶发返回 `AGENT_VERSION_UNKNOWN`**，而同一环境下 `detect` 正常报出 2.1.233，其后多次重跑均成功。**原因未查实，不做推断。** 但它暴露的东西是确定的：`installedVersionOf` 用 `catch { return undefined }` 吞掉全部异常，于是「没装」和「这次检测失败了」输出成同一句话，而这两种情况用户要做的事不同。未修；
- `[method]` 本次 Windows 侧是**从 WSL 调用 Windows 原生 node 跑打包版 CLI**（`process.platform` 为 `win32`，state root 落在 `%LOCALAPPDATA%\Apexnova\connect`）。这不等同于在 Windows 终端里的原生会话，但登录（Windows Credential Manager）、`detect`、目录读取与 `recommend` 全部走的是 Windows 路径。9 月 9 日的采集本身是在原生会话里完成的。

macOS 仍无实机，按 [ADR 0006](decisions/0006-m3-closure.md) 继续挂在未决依赖上，`recommend` 在该平台如实返回无证据。

## M4 推荐→连接→验证的首次闭环（2026-09-11，Linux/WSL2，`api.apexnova-consulting.com`）

[ADR 0011](decisions/0011-m4-milestone-review.md) 第 3 问写明：`recommend` 的产出从未被喂给 `connect`，从推荐到连接这一步没有闭环。本次把它跑通，实扣 `0.000328 USD`。

**用 OpenCode 而不是 Claude Code。** `connect claude-code` 会改写 `~/.claude/settings.json`，那是当时正在运行的那个 Claude Code 自己的配置——拿一个会把验收会话本身重定向的对象做验收，风险与收益不成比例。OpenCode 本机装着 1.18.29、有 `linux-x64` 证据，等价且不碰运行中的东西。

- `[passed]` **交接没有摩擦**：`recommend opencode` 排第一的是 GLM-5.1（`deployment.apexnova.cmq4770nr0000edzis38w378a`，score 0.778，引用 `ev.sha256.f61ff31a…`），该 id 原样贴进 `connect --deployment` 即可，不需要任何转换；
- `[passed]` `connect --dry-run` 只报一个操作（创建 `~/.config/opencode/opencode.jsonc`，505 字节）且不改状态；`--yes` 写入成功并签发 runtime credential；
- `[passed]` **`verify opencode --live --yes` 对 GLM-5.1 真实推理通过**，请求 `cef34568-4e03-4788-9de7-1fcb9ba1f11a`，实扣 `0.000328 USD`（10 input / 97 output），非约束估价 `0.000898 USD`；
- `[passed]` **账对得上**：余额 `60.273767` → `60.273439`，差额与 `verify` 报的实扣一分不差；
- `[passed]` 回滚后配置文件消失、绑定删除、凭据撤销（`credential print` 返回 `RUNTIME_CREDENTIAL_NOT_FOUND`）、`restore --list` 无可恢复事务；
- `[fixed]` **`restore --yes` 不带事务 id 时是静默空操作**，见下。

因此「推荐 → 连接 → 真实调用 → 回滚」首次跑通，ADR 0011 第 3 问里那条缺口合上。仍未合上的是另一条：没有人验证过排第一的那个 Deployment**用起来确实更好**——那需要 Scenario Quality Pack，不是这次能给的。

### `restore --yes` 曾经静默什么也不做

`executeRestore` 的分支是 `if (parsed.list || transactionId === undefined)`：**没给事务 id 时无视 `--yes` 走列表分支并返回成功**。本次回滚第一次执行 `restore --yes` 就命中了——打印出一张事务表、退出码 0，而配置仍在磁盘上、runtime credential 仍然可用（`credential print` 仍能取出 secret）。

这比一个普通的空操作更重：**用户请求了恢复、批准了恢复、拿到了成功，因而会认为凭据已经撤销，而它还活着。** 与本阶段修掉的 `--max-price` 静默无效是同一类（[ADR 0010](decisions/0010-m4-constraint-exit-condition-status.md) 决策 2），但后果落在凭据上。

修法：带 `--yes` 或 `--dry-run` 却不给事务 id 时报 `INVALID_ARGUMENT` 并列出当前可恢复的事务，不再落回列表分支。**不自动挑一个**——[`cli-spec.md`](cli-spec.md) 要求恢复按事务逆序显式执行，替用户挑可能回滚掉他没打算动的 integration。`restore` 与 `restore --list` 的列表行为不变。

## `switch` 链路的现网实测：重新签发的凭据真的能用（2026-09-11，Linux/WSL2）

接上一条闭环，把 `recommend → connect → switch → 逆序 restore` 整条跑完，本轮实扣 `0.000623 USD`。目标取自同一次推荐的第一名与第二名（GLM-5.1 与 GLM-5.2，两者 score 同为 0.778，靠 `deploymentId` 字典序分先后）。

**这条补上了 2026-09-05 记录里挂着的那句**：`switch` 恢复时重新签发上一目标凭据的语义，此前只有自动化 contract test 覆盖，标着「仍待 staging 实测」。现在是现网实测过的。

- `[passed]` `switch --dry-run` 报一个操作（`update` 而不是 `create`，506 字节）且不改状态；`--yes` 切到 GLM-5.2 并签发新凭据；
- `[passed]` **切换后真实可用**：`verify --live --yes` 对 `glm-5.2` 通过，请求 `0553e7ae-bf7c-40a4-a08b-f82368cded9e`，实扣 `0.000179 USD`；
- `[passed]` **顺序守卫按预期拒绝**：直接恢复较旧的 `connect` 事务返回 `RESTORE_ORDER_CONFLICT`（退出码 6）并点名应先恢复哪一条；**拒绝后配置未被修改**：文件里仍是 `apexnova/glm-5.2`，即 `switch` 之后的目标；
- `[passed]` **重新签发的凭据不是纸面语义**：恢复 `switch` 事务后 CLI 报「Previous runtime connection was reissued」，配置回到 `apexnova/glm-5.1`，随后 `verify --live --yes` 用那枚**重新签发的**凭据对 `glm-5.1` 真实推理通过，请求 `c68b5c06-b659-4b6e-a45b-3688e472353e`，实扣 `0.000444 USD`。这是这条记录的重点：契约测试能证明代码路径走到了，只有真实调用能证明那枚凭据在上游被接受；
- `[passed]` 再恢复 `connect` 事务后回到连接前：配置文件消失、绑定删除、凭据撤销（`credential print` 返回 `RUNTIME_CREDENTIAL_NOT_FOUND`）、`restore --list` 无可恢复事务；
- `[passed]` **账对得上**：余额 `60.273439` → `60.272816`，差 `0.000623 USD` = `0.000179` + `0.000444`，与两次 `verify` 各自报的实扣分别相符。

## `run` launcher 在 Linux 上的首次实测：跑通了，但跑错了地方（2026-09-11）

M1 在 Windows 上验过 launcher，Linux 侧没有。本次实测的结论是**不能声称 Linux 上的 launcher 已验收**：命令全程成功，agent 也答出了 `APEXNOVA_OK`，但那次请求既不是我们配置的 Deployment，也不是我们签发的凭据。

- `[passed]` **凭据不落盘**：`run` 写出的 `~/.config/opencode/opencode.jsonc` 只含 `{env:APEXNOVA_API_KEY}` 占位，全文无 `anrt_` 前缀material。M1 那条「密钥不进入配置」在 Linux 上成立；
- `[failed]` **我们写的 provider 没有被 OpenCode 加载**：`opencode models apexnova` 报 `Provider not found: apexnova`；`opencode models` 的 13 行里没有 `apexnova/glm-5.1`，却有 `apex_agent/`、`apexnova_ai_hub/`、`huawei_maas/` 这些不是我们写的条目。显式 `--model apexnova/glm-5.1` 时 OpenCode 抛内部 `UnknownError`（ref `err_fed31730`）。**根因未查实，本记录不做推断**；
- `[failed]` **请求落到了别处，而每一步都报成功。** `run opencode -- run "…"` 返回了 `APEXNOVA_OK`，但 OpenCode 用的是 `glm-5.2`（我们配的是 `glm-5.1`），台账显示这 2 次请求记在 **`apiKeyName: "myopencode"`（`apiKeyId: cmtolxknn000ftg71yn7md4v2`）** 名下——一枚**预先存在的长期 API key**，不是 Connect 刚签发的 runtime credential（后者在台账里叫 `OpenCode (default)`，本轮零请求）。实扣 `0.005693 USD`，走的是一枚 **Connect 既不管理也无法撤销**的凭据。

这一条比「launcher 没跑通」严重：CLI 报了 `Configured OpenCode with GLM-5.1`、launcher 报了 `OpenCode exited successfully`，而实际发生的是另一个模型经另一枚凭据完成的调用。**M5 的退出条件「用户始终能看到实际 Deployment 和计费主体」在这条路径上今天不成立**，而且它的失败方式是静默的。

本机的 OpenCode auth store 是空的（`opencode providers list` 报 `0 credentials`），shell 环境里没有任何 `APEXNOVA*` 变量，磁盘上也只有我们写的那一份配置——那枚 key 从何处被 OpenCode 取到，尚未查清。

### 顺带暴露的两处

- `[fixed]` **`restore` 在撤销失败时把凭据 id 一起丢了。** 撤销失败只把 id 放进 `warnings`，而 human 模式只打印 `human`，于是用户得到的指令是「自己去撤销」却没有要撤销的东西。现已把 id 写进 human 文案。**尚未处理的另一半**：绑定在撤销失败时照样被删除，本地从此不再持有那个 id；
- `[observed]` 本次 `restore` 报了「需要手工撤销」，但事后查询账号的 runtime credential 列表只剩一枚 2026-09-09 的能力套件凭据（早已过期），`run` 签发的那枚不在其中。**是撤销其实成功了还是别的原因，未查实。**

### 结论

Linux 侧的 launcher **不记为通过**。要能声称它成立，至少需要：查清 OpenCode 为何不加载我们写入的 provider；查清那枚 `myopencode` key 被 OpenCode 从哪里取到；并让 launcher 在「agent 实际使用的不是我们配置的 Deployment」时**失败而不是报成功**——最后这条是最重要的，因为前两条修好之后，静默错配的可能性依然存在。

### 根因排查（同日晚）：先前两条结论均已撤回

第三条（让 launcher 失败而不是报成功）已实现（`LAUNCH_ATTRIBUTION_MISMATCH`），并在同一条路径上**实测复现并拦截**：命令以退出码 7 失败并点名是谁服务了那两次请求。这一条不受下面的更正影响。

**`[corrected]` 此前记下的两条根因都是错的，作废：**

- ~~「provider 包与凭据协议对不上，OpenCode 走 openai-chat」~~。那条 `This credential is not allowed to use the openai-chat protocol` 来自**我把包换成 `@ai-sdk/openai-compatible` 的实验**，不是我们发布的配置。对照实验证明**我们写的配置是对的**：`@ai-sdk/openai` + 注入的凭据，OpenCode 选中 `apexnova/glm-5.1` 并真实返回 `APEXNOVA_OK`，退出 0。OpenCode 二进制里也明确写着 `if(npm==="@ai-sdk/openai") return configure(a).responses(id)`，即该包本就走 Responses；
- ~~「那批 provider 来自 OpenCode 的远端 v2 catalog」~~。它们来自**另一台机器的配置文件**，见下。

**真正的根因：`detect` 与 `run` 在 WSL 上启动的是 Windows 那份 OpenCode，而配置写给了 Linux 那份。**

证据链：

- 让被启动的子进程自报配置（`run opencode -- debug config`），返回的配置里有 `"username": "wakee"`——**Windows 用户名**（WSL 侧是 `wanke`），provider 是 `apexagent`/`huawei_maas`/`apex_agent`/`apexnova_ai_hub`；
- `/mnt/c/Users/wakee/.config/opencode/opencode.jsonc` 的 provider 列表与之**逐个吻合**。此前那批「不是我们写的 provider」就是这个文件；
- `which -a opencode` **只**返回 `/mnt/c/Users/wakee/AppData/Roaming/npm/opencode`。Linux 安装（`~/.npm-global/bin/opencode`）根本不在 PATH 上，PATH 里有 12 个 `/mnt/c` 条目；
- `discovery.ts:22` 的 `OPENCODE_EXECUTABLE` 是裸名 `"opencode"`，`detect` 与 `planLaunch` 都用它；而配置路径由 context 的 HOME 推出，是 Linux 的。

因此 `detect` 报出的版本来自 Windows 二进制、配置路径来自 Linux HOME，`connect` 把配置写到后者，launcher 启动前者——**Connect 配置了一个永远不会读它的安装**，Agent 于是按 Windows 配置运行，用的是那里的 `myopencode` 长期 key。这也解释了为什么 `myopencode` 的 secret 在 Linux 侧 grep 不到：它本来就不在这台「机器」上。

**已修复（同日）。** 不能靠让用户删掉另一份安装来解决——那不是修复，是绕开。做法是让这种不一致**说出来并拒绝**：

- `foreignInstallation()` 按 PATH 顺序找 `opencode`，落在 `/mnt/<盘符>/` 下的判为另一个操作系统的安装。**PATH 上任何一个本机条目都会让它放行**——本机安装在场时，读我们这份配置的就是它；
- `detect` 与 `doctor` 在只找得到 Windows 安装时给出警告，把「版本读自哪一份、配置写去哪一份」摆在同一句话里；
- launcher 直接拒绝（`AGENT_NOT_FOUND`），并告诉用户两条出路：在本环境内安装，或把它的目录排到 Windows 条目之前。

现网验证（Windows 那份仍在，本机 `~/.npm-global/bin` 此前不在 PATH 上）：

- `[passed]` 未修正 PATH 时，`detect` 报出警告、`run` 以退出码 5 拒绝，**不再静默启动另一份**；
- `[passed]` 把本机安装排到 PATH 之前后：`detect` 无警告、配置路径为本机那份；`run opencode -- run "…"` 真实返回 `APEXNOVA_OK`，并且**对账检查正面确认**：`1 request billed to this launcher's credential on deployment.apexnova.cmq4770nr0000edzis38w378a`。这是 launcher 第一次在 Linux 上被证明把请求送到了我们配置的 Deployment、用的是我们签发的凭据。

**仍未修的一处顺序问题**：拒绝发生在 `configureAgent` **之后**，所以一次被拒的 `run` 会留下已写入的配置和已签发的凭据（可用 `restore` 收回）。可启动性应当在动任何状态之前判定，但那需要在 Agent Discovery Contract 上留一个「能否启动」的前置检查，四个 Integration 都会受影响，单独提出。

### 同一轮暴露的另一处：Agent 会改写 Connect 写的文件（已修复）

`restore` 以 `CONFLICT` 拒绝回滚：`Configuration changed after apply`。对比后确认，改动是 **OpenCode 自己往配置里加了一行 `"$schema"`**，其余内容与 Connect 写入时一致。同一现象当天复现三次，每次都要手工删掉那行 `restore` 才肯收尾。

拒绝本身是对的——不删一个被改过的文件。问题在于用户没有出路，而 Agent 规范化自己的配置文件是常态不是异常。

修法：**Connect 创建配置时自己写上那个 schema 指针**，OpenCode 就没有东西可补，内容哈希在 Agent 跑过之后保持稳定。只在「创建」时写——往用户已有的配置里加一行，是没人要求过的改动。

### 顺带修掉的第三处

- `[fixed]` **`restore` 把「凭据已经不存在」报成「撤销失败」。** 两次观察到同一现象：CLI 报「需要手工撤销」，事后查账号该凭据并不在活动列表里。撤销本就是幂等的——Hub 已经没有的凭据就是已撤销，无论是谁撤的。现改为把 `NOT_FOUND` 视为已撤销，只有真正的失败才提示手工处理；否则真失败与冗余失败无法区分。

## OpenCode 在 Linux 上的端到端闭环（2026-09-11，M4 收口证据）

PATH 修正并修掉上述两处之后，从推荐到回滚一次跑通，**全程无手工干预**：

- `[passed]` `recommend opencode` 第一名 DeepSeek-V4-Pro-0813（score 0.800，`cost` 分项 0.90 —— Hub 交付 12H 后成本第一次真正参与排序）；
- `[passed]` `connect --dry-run` 报一个操作、不改状态；`--yes` 写入并签发 runtime credential；
- `[passed]` `verify opencode --live --yes` 通过，请求 `c85e1e33-28cc-41ee-bbb5-d52581949452`，实扣 `0.000090 USD`；
- `[passed]` **`run opencode -- run "…"` 真实 Agent 进程返回 `APEXNOVA_OK`，模型是 `deepseek-v4-pro-0813`（即推荐的那一个）**，对账正面确认：`1 request billed to this launcher's credential on deployment.apexnova.cmt0bub5d0042139w2xobpghn`；
- `[passed]` `restore` 一次成功，配置文件删除、绑定删除、凭据撤销——不再需要先手工处理 `$schema`。

这条闭环是 [ADR 0011](decisions/0011-m4-milestone-review.md) 第 3 问点名的那条缺口的最后一段：此前只到 `verify`，launcher 那一段是坏的。

仍未合上的一条不变：**没有人验证过排第一的 Deployment 用起来确实更好**——那需要 Scenario Quality Pack。

## Gateway 路径的四个 Integration 验收（2026-09-12，Linux/WSL2）

[ADR 0018](decisions/0018-gateway-first-slice.md) 写明：`run --gateway` 改变 Integration 写入的 `baseURL`，因此每个 Integration 都要重新验收，不能只验 OpenCode。

- `[passed]` **OpenCode**：真实推理经 gateway 返回 `APEXNOVA_OK`，1 个请求逐个点名（`method: "gateway"`，带 Hub 的 `requestId`），运行后配置自动回滚；
- `[passed]` **Codex 0.153.4**：`run codex --gateway -- exec "…"` 真实推理返回 `APEXNOVA_OK`，1 个请求经 gateway 转发；配置在运行前不存在、运行后回到不存在；
- `[fixed]` **Hermes**：经 gateway 的 12 个请求全部被 Hub 拒绝——`This credential is not allowed to use the openai-chat protocol`。**直连对照同样失败**，因此这是既有的协议错配，不是 gateway 引入的。根因与修复见下节，修复后直连与 gateway 均通过；
- `[partial]` **Claude Code**：配置写入路径已验证——经临时配置路径写出 `ANTHROPIC_BASE_URL: http://127.0.0.1:42735/anthropic`，**路径前缀被正确保留**（该协议的端点前缀是 `/anthropic`，与 OpenCode 的 `/v1` 不同）。**launcher 未验证**：它的配置就是本会话正在使用的 `~/.claude/settings.json`，而从会话内部启动 `claude` 会挂起。真实 settings 全程未被写入（核对过零条 loopback 记录）。

四个 Integration 的配置写入器现在都由一条**共用契约测试**覆盖：给一个 `http://127.0.0.1:<port><原路径>` 的端点，必须写出它且不得留下上游 host。这把上面的一次性观察变成了持续证据。

### Hermes 的协议错配：根因与修复（同日）

`selectProtocol` 按目录顺序取第一个该 Integration 声明支持的协议，目录顺序是 `[openai-responses, openai-chat, anthropic-messages]`，Hermes 三个都声明，于是选中 `openai-responses` 并据此签发凭据。集成也如实把它映射成 `api_mode: codex_responses` 写进配置——**写入是对的，`hermes config get model.api_mode` 能读回 `codex_responses`**。

但 Hermes 对 `provider: custom` 不按这个值走。它自己的配置注释写着「For custom OpenAI-compatible endpoints」——custom 在 Hermes 这边就是 OpenAI 兼容（chat completions），于是它调用 `/v1/chat/completions`，而凭据只授权 responses，Hub 据此拒绝。

**逐协议实测**（同一 Deployment，各跑一次真实推理）：

| Hermes 声明 | 实测 |
| --- | --- |
| `openai-chat-completions` | **通过**，返回 `APEXNOVA_OK` |
| `anthropic-messages` | **通过**，返回 `APEXNOVA_OK` |
| `openai-responses` | **失败**，Hermes 改打 chat completions |

修复：**从 Hermes 的 `supportedProtocols` 与 manifest 中移除 `openai-responses`**，`hermesApiMode` 也不再产出 `codex_responses`——能存下来却不被遵守的配置，是写着一件事、做着另一件事。声明一个交付不了的协议，与本项目在别处一律拒绝的「声明当实测」是同一回事。

修复后默认路径（不带 `--protocol`）自动选中 `openai-chat`，直连与 `--gateway` 各跑一次真实推理都返回 `APEXNOVA_OK`（gateway 一次转发 11 个请求，逐个点名）。Hermes 的 `config.yaml` 在全部试验后与原文件逐字节一致。

### Hermes 的失败暴露了两条路径的精度差

同一次全部被拒的运行，两条路径报出的东西不同：

| 路径 | 报告 |
| --- | --- |
| gateway | `12 requests forwarded … each one named` |
| 直连 | `2 requests billed … confirmed` |

**直连把一次全部被拒的运行报成了「已确认计费 2 次」。** 这正是 [ADR 0018](decisions/0018-gateway-first-slice.md) 决策 6 预期的差别，也是先做这个切片的理由。

另记：两条路径下 Hermes 都以退出码 0 结束并报 `exited successfully`，尽管每个请求都被拒。那是 Hermes 自己吞掉了错误，不是 Connect 的行为。

### 顺带发现：目标文件被删后 `restore` 无路可走

验收过程中我在一个活动事务下删掉了目标文件（临时配置目录），`restore` 随即以 `CONFLICT` 拒绝——内容哈希对不上，而文件已经不在。拒绝是对的，但**没有出路**：与 2026-09-11 记录的 `$schema` 那次是同一形状。

本次是靠事务记录里的 `appliedContentHash` 反推出写入时的确切字节（`JSON.stringify(doc, null, 2) + "\n"`）、重建文件后才让 `restore` 正常收尾。**普通用户没有这条路。**

另外：用 `--config` 创建的事务，必须在 `restore` 时再次传同一个 `--config` 才能恢复——否则报 `PATH_OUTSIDE_ALLOWED_ROOT`，而 `restore --list` 不会提示这一点。

## Gateway 的多轮工具调用实跑（2026-09-12）

[ADR 0019](decisions/0019-gateway-first-slice-review.md) 记下的限制是：所有经 Gateway 的实跑都是一次性提示，没有一次是长会话。本次做的是**近似**——一个真正需要多轮工具调用的自动任务，不是交互会话。

任务：在一个临时工作区里读 `src/a.ts`、`src/b.ts`、`docs/notes.md`，再写出一份 `SUMMARY.md` 列出每个文件导出的符号数。

- `[passed]` **Agent 真的完成了工作**：`SUMMARY.md` 写出且计数正确（`a.ts` 2、`b.ts` 1、`notes.md` 0）——读文件、算数、写文件都经 Gateway 完成；
- `[passed]` **4 个请求全部经 Gateway 转发并逐个点名**，状态全 200，单次耗时 2747 / 3224 / 3001 / 3450 毫秒，全程 23 秒；
- `[passed]` 审计逐条记下 `POST /v1/responses 200 in <n>ms (<requestId>)`；
- `[passed]` 运行结束 Gateway 正常关闭、配置回滚、余额差 `0.012791 USD`。

**这次没有覆盖的，逐条写明：**

- **不是交互会话。** 没有人类回合、没有长时间空闲、没有跨越会话中断与恢复；
- **没有跨过凭据有效期。** runtime credential 24 小时有效，23 秒碰不到它。「长会话中途凭据到期」仍然是未知行为；
- **并发仍未验证。** 4 个请求看起来是顺序发出的，多个请求同时在途的行为没有被触碰；
- **23 秒不是「长」。** 它证明的是多轮、多请求、带工具调用的任务可以经 Gateway 完成，不是 Gateway 能扛住一场数小时的会话。

## 本机 Docker 验证记录（2026-09-05）

Compose 项目 `apexagent` 的真实服务已完成以下验证：

- `[passed]` `web` 健康检查，以及 PostgreSQL/Redis 依赖健康检查；
- `[passed]` OAuth discovery、Device Authorization、token exchange；
- `[passed]` `/v1/me`、余额与原子 catalog snapshot；
- `[passed]` runtime credential 签发、推理面 Bearer 鉴权入口和成功后的自动撤销；
- `[passed]` 指定 `glm-5.2` 的最小 `openai-chat` 真实推理返回 HTTP 200；请求 `319f02cd-44c2-4326-a9d8-4c2ee76566f9` 记录为 17 input / 93 output tokens，实扣 `0.000203 USD`；
- `[passed]` 正式 CLI 经 Windows Credential Manager 完成登录、目录查询、`connect --dry-run`、`connect --yes`、配置验证、`switch`、配置事务逆序 `restore` 与 `logout`；`switch` 恢复时重新签发上一目标凭据的语义已由自动化 contract test 覆盖，仍待 staging 实测（**2026-09-11 已现网实测，见下文 M4 switch 链路记录**）；
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

## 2026-09-12 Hermes 首次 capability 采集（linux-x64 / anthropic-messages）

按 [ADR 0023](decisions/0023-integration-status-ladder.md) 的 `stable` 第 1 条采集。`hermes` 与 `codex` 自 [ADR 0004](decisions/0004-m3-scope-and-evidence-path.md) 把 M3 首批定为 OpenCode 与 Claude Code 之后，从未进入过采集范围，**这是 Hermes 的第一批真实证据**。

- 环境：WSL2 Linux，Hermes Agent v0.21.0（`/home/wanke/.hermes`，git 安装），账号 `testpro@test.com`；
- 协议：`anthropic-messages`（Hermes 另一个声称协议 `openai-chat-completions` 不在能力套件覆盖范围内，无法采集）；
- 四个 Deployment，与 `claude-code` 已有证据所用的四个相同，以便交叉比对：

| Deployment | 结论 | 计费 | Evidence |
| --- | --- | --- | --- |
| `…cmq4770nr0000edzis38w378a`（GLM-5.1） | `compatible` | 0.001484 USD / 5 请求 | `ev.sha256.37d21c9d…` |
| `…cmqr4cngr000dn1q69bbrl1vw`（GLM-5.2） | `compatible` | 0.001056 USD / 5 请求 | `ev.sha256.f46e5def…` |
| `…cmt0bub5d0042139w2xobpghn`（DeepSeek-V4-Pro-0813） | `compatible` | 0.001400 USD / 5 请求 | `ev.sha256.ecc84235…` |
| `…cmtdear4g005n5pfmdx2ge3x3` | `partial` | 0.000087 USD / 3 请求 | `ev.sha256.6c11c42a…` |

**交叉验证**：那条 `partial` 的失败项是 `agent.forced-tool-choice` 与 `agent.structured-output`，上游返回 `tool_choice` 不接受 `required`。**`claude-code` 在同一个 Deployment 上是同样的 `partial`、同样两项。** 两个不同 Agent、同一部署、同一组失败——该结论属于部署侧限制，不是 Integration 缺陷。这正是 subject 同时记录 agent 与 deployment 的用处。

合计计费 0.004027 USD。矩阵已重新生成。

## 2026-09-12 首次 `openai-chat-completions` 采集（能力套件 0.4.0）

按 [ADR 0025](decisions/0025-capability-suite-covers-chat-completions.md) 把套件扩到第三个协议后的第一次真机运行。`hermes` × 四个 Deployment × `openai-chat`：

| Deployment | 结论 | 关键项 |
| --- | --- | --- |
| `…cmq4770nr…`（GLM-5.1） | `partial` | `agent.structured-output` unsupported |
| `…cmqr4cngr…`（GLM-5.2） | `partial` | `agent.structured-output` unsupported |
| `…cmt0bub5d…`（DeepSeek-V4-Pro-0813） | `compatible` | 九项全 supported |
| `…cmtdear4g…` | `partial` | `agent.forced-tool-choice` unsupported（`tool_choice` 不接受 `required`） |

**按规范实现的部分被真机确认**：`protocol.streaming-order` 报「41 events, chat.completion.chunk first and `[DONE]` last」——该协议没有 `event:` 命名帧、以 `[DONE]` 收尾，这两点与端点实际行为一致。

**一个只有测了第二个协议才看得见的发现**：GLM-5.1 与 GLM-5.2 的 `agent.structured-output` 在 `anthropic-messages` 上是 supported（该路径是强制工具，它们支持），在 `openai-chat-completions` 上是 unsupported（`response_format: json_schema` 它们不照做）。**同一部署、同一 capability、两个协议、两个结论。** 只测一个协议会给出一个看起来完整、实际只对一半的答案。

四条结论在套件 0.3.0 与 0.4.0 下逐项一致（升版后重采，原因见 ADR 0025 第 3 节）。这批证据**尚未 `compatibility sync` 到 Hub**。

## 2026-09-13 OpenCode 与 Codex 的 Linux 采集

[ADR 0026](decisions/0026-linux-collection-completes.md)。两个客户端在本机 `~/.npm-global/bin` 早已装好；此前 `detect` 看到 `/mnt/c` 下的 Windows 安装，是非交互 shell 未走到 `.bashrc` 的 PATH 段所致。补 PATH 后 `detect` 给出 `/home/wanke/.config/opencode/opencode.jsonc` 与 `/home/wanke/.codex/config.toml`，确认是 Linux 安装后再采集。

| 目标 | 四个 Deployment 的结论 |
| --- | --- |
| `opencode` linux-x64 / `openai-chat` | `partial` ×3、`compatible` ×1 |
| `codex` linux-x64 / `openai-responses` | `partial` ×4 |

`opencode` 的四条与同日 `hermes` 在相同 Deployment、相同协议上的结论**逐项一致**——套件测的是（Deployment × 协议），两个 Agent 得到同一组结论是对确定性的交叉印证。

**`agent.structured-output` 的三协议横比见 [Hub 需求 12K](apexnova-ai-hub-requirements.md)**：没有一个 Deployment 在三个协议上给出相同答案，且 `openai-responses` 上四个全部失败。

本批与 2026-09-12 的全部证据**尚未 `compatibility sync` 到 Hub**。

## 2026-09-13 证据发布到 Hub

`apexnova compatibility sync --yes`。发布是公开且永久的：接受后的证据**可被取代或撤销，不能编辑或删除**。

- **提交 44 条，失败 0 条**。其中本轮新采的 16 条（`hermes` 8、`opencode` 4、`codex` 4）首次发布，其余为 M3／M4 已在 Hub 的记录，重复提交是幂等的（`existing, supports the current verdict, fingerprint match`）；
- **12 条被跳过**：它们是 id 形式约定之前写的（`evidence.<32hex>`），Hub 以 `400 evidence_legacy_id` 拒收。这些记录不可变，因此**只能留在本地**，要发布须重采对应 subject；
- 能力套件 `0.4.0` 已在 Hub 登记（`already registered`）。

### 撤销四条被取代的记录

`hermes × openai-chat` 的四个 subject 在存储里各有两条：升版前由套件 `0.3.0` 采集的一条，升版后由 `0.4.0` 重采的一条（原因见 [ADR 0025](decisions/0025-capability-suite-covers-chat-completions.md) 第 3 节）。`sync` 没有按 id 过滤的能力，两批都会上传，于是四条 `0.3.0` 记录在发布后立即撤销：

| 撤销的记录 | Deployment |
| --- | --- |
| `ev.sha256.e500ddcd…` | `…cmq4770nr…` |
| `ev.sha256.a1227b31…` | `…cmqr4cngr…` |
| `ev.sha256.431028921d70…` | `…cmt0bub5d…` |
| `ev.sha256.f781596f…` | `…cmtdear4g…` |

理由（随记录公开留存）：*Superseded: collected by capability suite 0.3.0, whose published identity does not cover openai-chat-completions. Re-collected identically under 0.4.0, which does.*

撤销**不是删除**：记录仍可按 id 读取，只是不再支持任何判定，并从此带着这条理由。这正是它该有的处置——那四次运行确实发生过，不该被抹掉；被抹掉的只是它们对判定的支持力。

## 2026-09-13 Claude Code 经 Gateway 端到端（[ADR 0020](decisions/0020-gateway-batch-closure.md) 条件 2 达成）

这条从 [ADR 0019](decisions/0019-gateway-first-slice-review.md) 起一直记为「环境所限」，理由是 Claude Code 的配置就是本会话在用的文件。**理由不成立**：`--config` 可以指到隔离路径——只是它此前不起作用，见下。

- 环境：WSL2 Linux，Claude Code（`/usr/bin/claude`），隔离配置 `/tmp/tmp.l1fx35qZ1B/settings.json`；
- 命令：`run claude-code --config <iso>/settings.json --gateway --deployment …cmq4770nr… -- -p "Reply with exactly OK"`；
- 结果：**Agent 退出 0、答出 `OK`、`attributedRequests: 1`**。审计记录 `billed (run): confirmed via gateway, 1 request`，含 `POST /anthropic/v1/messages 200 in 5465ms (0720a469-…)`；
- **本会话自己的 `~/.claude/settings.json` 全程未被触碰**（mtime 仍是 09-11，内容不含 loopback）。

顺带记两个在做这条时发现并修掉的缺陷，见 [ADR 0029](decisions/0029-launch-must-honour-the-configured-file.md)。
