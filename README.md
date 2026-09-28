# Apexnova-connect

面向 AI Agent、编程助手与自动化平台的 Apexnova AI Hub 通用连接层。

> [!IMPORTANT]
> 本项目尚未发布 1.0，接口仍可能有破坏性变更（见[发布说明](docs/release-notes.md)）。已在本机 dev 环境和现网完成端到端联调。本文描述的是产品目标与当前已实现能力。

## 快速安装

一行命令下载预构建的单文件 CLI（约 1 MB）。不需要 git、pnpm，也不在本机编译；只需要 Node.js 20+，没有的话脚本会自动通过 fnm 安装。

**Linux / macOS：**

```bash
curl -fsSL https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.sh | bash
```

**Windows (PowerShell)：**

```powershell
irm https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.ps1 | iex
```

脚本会校验发布产物的 `sha256`，把 CLI 装到 `~/.apexnova-connect`，并在 `~/.local/bin` 生成 `apexnova` 启动器（启动器记录 node 的绝对路径，因此新开终端也能直接运行）。

钉定某个 release：

```bash
APEXNOVA_VERSION=v0.7.0 curl -fsSL https://raw.githubusercontent.com/Jason869905/Apexnova-connect/main/scripts/install.sh | bash
```

可用环境变量覆盖默认行为：`APEXNOVA_VERSION`、`APEXNOVA_HOME`、`APEXNOVA_BIN`、`APEXNOVA_ASSET_URL`、`NODE_MAJOR`。

### 手动安装

```bash
curl -fsSLO https://github.com/Jason869905/Apexnova-connect/releases/latest/download/apexnova.mjs
curl -fsSLO https://github.com/Jason869905/Apexnova-connect/releases/latest/download/apexnova.mjs.sha256
sha256sum -c apexnova.mjs.sha256
node apexnova.mjs --version
```

### 开始使用

```bash
apexnova login              # 设备码授权
apexnova agents             # 看这份构建支持哪些 Agent
apexnova run opencode       # 选模型 + 建 key + 写配置 + 启动 OpenCode
apexnova run codex          # 同一条路径，换成 Codex
apexnova run claude-code    # 同一条路径，换成 Claude Code
apexnova run opencode --model glm-5.2 --model <id-b>   # 一枚 key 配一组模型
apexnova models             # 只读：列出 Hub 模型目录
apexnova switch opencode    # 换默认模型，key 不变
apexnova recommend opencode # 按兼容性证据与目录顺序给出排序表
```

`apexnova opencode` 保留为 `apexnova run opencode` 的别名。

发布产物内置了生产 Hub 地址，装完即可 `login`。要指向其他环境（自建、staging、本机 dev），运行 `apexnova init` 把地址写进
`~/.config/apexnova-connect/config.json`（Windows 为 `%APPDATA%\Apexnova\connect\config.json`）：

```bash
apexnova init --hub-url https://api.example.com --client-id apexnova-connect
```

`APEXNOVA_HUB_BASE_URL` / `APEXNOVA_OAUTH_CLIENT_ID` 环境变量的优先级高于该文件。从源码构建的版本不含内置默认值，必须先 `init` 或设置环境变量——这是为了避免开发版本误连生产。

`apexnova doctor` 会显示当前生效的 Hub 地址及其来源。完整的初始化安装流程（三步、每步写了哪些文件、doctor 每行怎么读）见 [CLI 使用指南](docs/cli-usage-guide.md#初始化安装流程)。

### 凭证存放在哪

Linux 上默认写进 `~/.local/share/apexnova-connect/credentials.json`（目录 0700、文件 0600）——**不需要 keyring、不需要 D-Bus、不需要 sudo**，装完就能 `login`。Windows 默认用 Credential Manager。

代价说在前面：这个文件**只靠文件权限保护**，没有操作系统加密在背后，`apexnova doctor` 会一直为此输出一条警告。想让操作系统保管秘密的机器可以切回 keyring：

```bash
sudo apt-get install -y libsecret-tools gnome-keyring   # Linux 上 keyring 得自己装
apexnova init --credential-store system
apexnova login                                          # 两个后端不共享已存凭证
```

切换只发生在你明说的时候：选了 `system` 而 keyring 不应答，命令会报 `BACKEND_UNAVAILABLE` 停下，不会把秘密改写到文件里。（文件后端自 v0.6.0 起成为 Linux 默认；v0.5.2 及更早版本强制要求 keyring。）

> 注：从源码构建请见下方「开发状态」一节。

## 项目简介

Apexnova-connect 是一个计划开源的连接平台，用于把 Apexnova AI Hub 的账号、余额、模型目录和模型调用能力接入不同的 AI 工具。

项目首批关注 OpenCode、Codex、Claude Code 和 DeepSeek Harness 等 Agent 客户端，以及 n8n、Dify 等工作流平台。它不会被设计成只适配少数产品的“一次性插件”，而是由通用内核、协议适配层和独立 integrations 组成：公共能力只实现一次，每个外部产品只维护自己的发现、配置、切换和恢复逻辑。

用户应当能够登录 Apexnova AI Hub、查看余额与可用模型，并在明确知情的情况下切换模型服务。所有切换都必须展示当前提供方和计费来源，支持变更预览、配置备份及可靠恢复。

## 名称约定

- **Apexnova-connect**：本仓库及客户端连接项目，包含桌面伴侣、CLI、公共组件和各种 integrations。
- **Apexnova AI Hub**：独立的服务端项目，负责账号、设备授权、余额、模型目录、计费、路由和风控等服务端能力。

本文后续严格使用以上名称，避免把公开客户端项目与私有服务端混为一体。

## 基本信息

| 项目 | 说明 |
| --- | --- |
| 项目名称 | Apexnova-connect |
| 对接服务 | Apexnova AI Hub |
| 仓库定位 | Apexnova AI Hub 面向 AI Agent 与自动化生态的开源连接平台 |
| 集成对象 | Agent 客户端、Coding Harness、工作流自动化平台及未来的 IDE/工具链 |
| 首批目标 | OpenCode、Codex、Claude Code、DeepSeek Harness、n8n、Dify |
| 目标用户 | 希望在现有 AI 工具中使用 Apexnova AI Hub 模型服务的开发者和团队 |
| 产品形态 | 桌面伴侣、CLI、原生插件、Provider/Gateway 和配置适配器 |
| 当前阶段 | `v0.7.0`（M1～M5 已关闭） |
| 开源协议 | Apache License 2.0 |
| 代码仓库 | [Jason869905/Apexnova-connect](https://github.com/Jason869905/Apexnova-connect) |

## 目标能力

- 使用安全的设备授权流程登录 Apexnova AI Hub；
- 展示余额、额度、模型状态和价格信息；
- 获取统一模型目录，并映射为目标平台理解的模型格式；
- 支持 OpenAI Responses、Chat Completions、Anthropic Messages 等协议；
- 按目标平台能力选择原生插件、Provider、Gateway 或配置管理方式；
- 切换前展示配置差异，自动备份，并支持一键恢复；
- 明确展示当前模型、服务提供方和计费来源；
- 为新增 Agent 或自动化平台提供稳定的语言无关契约、多语言 SDK 和模板。

## 集成范围

不同产品的扩展接口不同，因此 Apexnova-connect 采用“能力驱动”而不是“所有平台体验完全一致”的设计。

四个 Agent Integration 的状态判定标准见 [ADR 0023](docs/decisions/0023-integration-status-ladder.md)：两条可机检（声称的每个平台 × 协议都要有实测结论、文档齐全），三条人工逐条判定（每平台的端到端闭环记录、失败可恢复验收、已知限制不得为空）。**macOS 不在支持范围内**（[ADR 0024](docs/decisions/0024-narrow-platform-claims.md)）。

| 类别 | 集成 | 计划方式 | 当前状态 |
| --- | --- | --- | --- |
| Agent | OpenCode | 自定义 Provider 配置与启动器 | **`stable`**（Windows、Linux） |
| Agent | Codex | `config.toml` 自定义 model provider 与启动器 | **`stable`**（Windows、Linux） |
| Agent | Claude Code | 官方 LLM gateway 设置与启动器 | **`stable`**（Windows、Linux） |
| Agent | Hermes Agent | `config.yaml` 自定义 custom endpoint 与启动器 | **`stable`**（Linux；Hermes 无原生 Windows 版） |
| Agent | DeepSeek Harness | 根据其公开扩展能力选择插件、Provider 或 Gateway | 待调研 |
| 自动化 | n8n | Community Node 或凭证化节点集成 | 待调研 |
| 自动化 | Dify | Model Provider 或插件集成 | 待调研 |

表中的方式是当前方向，最终实现将以各平台公开、稳定且允许的扩展接口为准。

## 架构概览

```text
Desktop / CLI
      │
      ▼
Integration Runtime ─── Integration Manifest / Capability Contract
      │
      ├── Agent integrations
      │     ├── OpenCode
      │     ├── Codex
      │     ├── Claude Code
      │     ├── Hermes Agent
      │     └── DeepSeek Harness（待调研）
      │
      ├── Automation integrations
      │     ├── n8n
      │     └── Dify
      │
      └── Shared packages
            ├── Apexnova AI Hub API client
            ├── Authentication & credential store
            ├── Model catalog & protocol adapters
            ├── Config planning, backup & rollback
            ├── Compatibility evidence & recommendation
            ├── Routing audit
            ├── Optional local gateway
            └── Language-neutral schemas & language SDKs
```

每个 integration 通过 manifest 声明自己支持的能力，例如：

- `authentication`
- `balance`
- `model-catalog`
- `provider-config`
- `gateway`
- `hot-switch`
- `restart-required`
- `backup-and-restore`

宿主应用根据能力组合提供操作入口，不假设每个平台都能热切换或在客户端内展示余额。详细边界见 [架构说明](docs/architecture.md) 和 [新增 Integration 指南](docs/adding-an-integration.md)。

## M0 设计基线

- [发布说明](docs/release-notes.md) —— 每个版本**包含什么与不包含什么**；当前 `v0.7.0`
- [CLI 使用指南（通用）](docs/cli-usage-guide.md) —— 安装、登录、Key 模式、通用命令
- Agent 使用指南：[OpenCode](docs/opencode-usage-guide.md)、[Codex](docs/codex-usage-guide.md)、[Claude Code](docs/claude-code-usage-guide.md)、[Hermes Agent](docs/hermes-usage-guide.md)
- [产品范围与开源/商业边界](docs/product-scope.md)
- [跨 Agent 领域模型](docs/domain-model.md)
- [分阶段路线图](docs/roadmap.md)
- [CLI 命令与输出规范](docs/cli-spec.md)
- [兼容性证据规范](docs/compatibility-evidence.md)
- [兼容性矩阵](docs/compatibility-matrix.md) —— 由 `apexnova compatibility matrix` 从证据生成，Model ID 与模型别名的对照见 [ADR 0004](docs/decisions/0004-m3-scope-and-evidence-path.md)
- [Apexnova AI Hub 对接需求与 API 契约](docs/apexnova-ai-hub-requirements.md)
- [机器可读 Schema](schemas/README.md)

## 仓库结构

```text
Apexnova-connect/
├── apps/
│   ├── cli/                    # 登录、检测、连接、切换与恢复
│   └── desktop/                # 跨平台桌面伴侣
├── integrations/
│   ├── agents/                 # Agent 与 Coding Harness 适配器
│   │   ├── opencode/
│   │   ├── codex/
│   │   ├── claude-code/
│   │   ├── hermes/
│   │   └── deepseek-harness/       # 待调研，尚无实现
│   ├── automation/             # 工作流与自动化平台适配器
│   │   ├── n8n/
│   │   └── dify/
│   └── _template/              # 新集成模板和检查清单
├── packages/
│   ├── core/                   # 领域模型、能力协定与运行时编排
│   ├── hub-client/             # Apexnova AI Hub 公共 API 客户端
│   ├── credential-store/       # 系统安全凭证存储
│   ├── config-engine/          # 变更计划、备份、原子写入与恢复
│   ├── capabilities/           # 能力定义、兼容性证据与 Verdict 计算
│   ├── protocols/              # 模型协议和数据格式转换（占位）
│   ├── recommendation/         # Scenario 评分与推荐排序
│   ├── routing/                # 路由审计记录
│   ├── gateway/                # 可选本地 Gateway（默认关闭）
│   └── integration-testing/    # 公共 Contract Test 套件
├── schemas/                    # Manifest、配置与模型元数据 Schema
├── sdks/                       # 按语言提供的 Integration SDK
│   ├── typescript/
│   └── python/
├── tests/                      # Contract、integration 与 E2E 测试
├── tools/                      # 生成器、构建及仓库维护工具
└── docs/                       # 架构、集成、安全与决策记录
```

技术栈：TypeScript + pnpm workspace，`tsc` 构建、`vitest` 测试、`esbuild` 打包成单文件 `dist/apexnova.mjs` 随 release 发布。`apps/desktop`、`integrations/automation` 与 `sdks/python` 目前只有目录骨架。

## 扩展性原则

1. **核心不感知具体产品**：`packages/core` 不导入任何 OpenCode、n8n 或其他产品的实现。
2. **集成自治**：每个 integration 独立声明能力、平台限制、配置位置和生命周期。
3. **先计划后执行**：配置修改统一产生可预览的 change plan，再由 config engine 执行和回滚。
4. **协议与产品解耦**：OpenAI、Anthropic 等协议转换放在 `packages/protocols`，不散落在各 integration。
5. **语言无关契约**：Schema 是跨运行时的事实来源，TypeScript、Python 等 SDK 只是便利实现。
6. **渐进式能力**：集成可以只实现模型配置，不必为了接入而伪造余额展示或热切换能力。
7. **可测试契约**：所有 integration 必须通过公共 contract tests，并使用脱敏 fixture 和 mock server。
8. **安全默认值**：凭证不进入普通配置、日志、命令行参数或版本库。

## 设计原则

- **用户明确授权**：不在后台偷偷切换服务商，也不自动重放可能包含工具调用的失败请求。
- **计费透明**：切换前后明确展示模型、提供方、余额和计费来源。
- **安全可恢复**：所有配置修改支持预览、备份、原子写入和恢复。
- **最小权限**：凭证进入操作系统安全存储，并支持设备级撤销。
- **客户端可审计**：本地配置、凭证处理和切换逻辑在公开仓库中接受审查。
- **服务端隔离**：计费、上游密钥、路由、风控和内部管理逻辑不属于本仓库。

## 实施路线图

完整里程碑、范围和退出条件见 [路线图](docs/roadmap.md)。**M1～M5 均已关闭**（M5 收口见 [ADR 0041](docs/decisions/0041-m5-closure.md)），M6 按实际需求推进；当前发布为 `v0.7.0`。M5 关闭时明确**不包含** Circuit Breaker、受控选择、Connection Profile 与 Pro／Team，**本地 Gateway 保持默认关闭**，不支持 macOS。四个 Agent Integration 均为 `stable`（Hermes 仅 Linux，其余 Windows、Linux）。逐项见 [发布说明](docs/release-notes.md)。

- [x] 建立 Integration Manifest 和 capability contract v1 初稿；
- [x] 建立产品范围、领域模型、CLI、Evidence 和 Hub API 的 M0 设计基线；
- [x] 建立 Agent、Model、Scenario、Evidence 和 Recommendation 等 M0 Schema 草案；
- [ ] 使用首个真实 integration 验证并冻结 contract v1；
- [ ] 明确 Apexnova AI Hub 登录、余额、模型元数据和错误语义；
- [x] 实现 OAuth device flow、刷新与安全会话存储基础模块；
- [x] 实现配置 change plan、受限文件执行、持久化备份与跨进程恢复基础模块；
- [x] 实现 Windows/Linux 操作系统凭证存储基础模块；
- [x] 实现长期 API Key（`POST /v1/api-keys`）和按 key 聚合用量查询；
- [x] 实现 `apexnova run <agent>` 一行命令（自动选模型 + 创建 key + 写配置 + 启动）；
- [x] 实现交互式上下键模型选择器；
- [x] 在 dev 环境和现网 staging 完成端到端联调；
- [x] 建立 Agent Discovery Contract、Integration Registry 与公共 Contract Test；
- [x] 增加 macOS Keychain 后端（尚未在真实 macOS 上验收）；
- [x] ~~完成三平台真实环境验收~~ 完成 Windows 与 Linux 真实环境验收（macOS 退出支持范围，见 [ADR 0024](docs/decisions/0024-narrow-platform-claims.md)）；
- [x] 发布 OpenCode integration（`stable`）；
- [x] 发布 Apexnova-connect CLI（单文件 bundle 随 GitHub release 发布）；
- [x] 增加 Codex 与 Claude Code integrations；
- [x] 核实 Hermes Agent 配置面并实现其 integration；
- [ ] 完成 DeepSeek Harness、n8n 和 Dify 的可行性验证；
- [ ] 发布 Integration Schema、TypeScript/Python SDK、模板和 contract test suite；
- [ ] 发布桌面伴侣并建立签名、可复现构建和供应链验证流程。

## 开发状态

截至 `v0.7.0`，已实现的能力如下（完整命令、选项与错误码见 [CLI 命令与输出规范](docs/cli-spec.md)）。

### 已实现的命令

| 类别 | 命令 | 做什么 |
| --- | --- | --- |
| 账号 | `init` / `login` / `logout` / `whoami` / `balance` / `usage` | 配置 Hub 地址与凭证后端；OAuth 设备码登录（链接自带 `user_code`）；登出前检查未恢复事务；余额；按 key / 时间 / 模型聚合用量 |
| 发现 | `agents` / `detect [agent]` / `inspect <agent>` / `doctor [agent]` | 列出已注册 Integration；从 `$PATH` 找 Agent 并探测版本；脱敏查看现有配置；环境与凭证保护自检 |
| 模型 | `models` / `recommend <agent>` | 只读列出 Hub 目录（与模型广场同序）；按兼容性证据 + 目录顺序给出排序表，`--json` 输出 Recommendation 0.3 文档 |
| 连接 | `run <agent>` / `connect <agent>` / `switch <agent>` | 一行命令选模型→建 key→写配置→启动；建立绑定并签发 24h runtime credential；在同一枚 key 上换默认模型 |
| 凭据 | `credential print <agent>` | 供 Agent 的 credential helper 调用，只输出当前绑定的凭据（必要时先续期） |
| 验证与恢复 | `verify <agent>` / `restore [transaction-id]` / `audit [agent]` | 配置级与显式付费的 `--live` 验证；按事务回滚 Agent 配置并吊销凭据；读取不可变路由审计 |
| 兼容性证据 | `compatibility run / refresh / sync / revoke / replay / matrix / explain` | 本地采集能力套件证据、到期刷新、与 Hub 双向同步、生成兼容性矩阵 |

### 核心逻辑

- **一枚 key、一组模型**：`run` 可多选模型，全部写进 Agent 配置并由同一枚永久 `sk-` key 授权；加模型走 PATCH 扩大授权并读回校验，key 在 logout 之前不变。`--rotating` / `--gateway` / `--credential-ttl` 改用可续期的短期 credential；
- **先计划后执行**：所有配置修改先生成 change plan（`--dry-run` 与写入共用同一份计算），再原子写入、持久化备份，可跨进程 `restore`；
- **只有 Model**：`packages/hub-client` 是唯一认识 Hub 线格式（`models[]` + `deployments[]`）的层，在边界上合并成 Model；CLI、审计和 Integration SDK 只使用 `modelId`；
- **推荐总能给出答案**：只有四件事把模型移出排序——Agent 不支持其协议、目录报不在服务、超出 `--max-price`、required 能力实测失败；有证据的按 `coding.v1` 计分排前，没证据的保留 Hub 目录顺序且不给默认分；
- **凭证存储**：Linux 默认 0600 文件后端（无需 keyring），Windows 用 Credential Manager，可用 `init --credential-store` 显式切换，不会静默回退；
- **路由审计**：每次连接写入 `selected` / `attributed` 两类不可变记录，回答选了哪个 Model、依据是什么、由谁计费；
- **可选本地 Gateway**（默认关闭）：忠实转发、逐请求归属、运行期凭据续期。

已在本机 dev 环境与现网（`api.apexnova-consulting.com`）完成端到端联调，四个 Agent 在各自声称的平台（Hermes 仅 Linux，其余 Windows 与 Linux）上均有 `connect → run → 归属对账 → restore` 的实跑记录，见 [Hub 联调清单](docs/hub-h1-integration-checklist.md)。macOS Keychain 后端有实现但未在真实 macOS 上验收，默认拒绝。

### 从源码构建

本地要求：Node.js 24+ 与 pnpm 9.15+。

```bash
pnpm install
pnpm check
pnpm cli -- login
pnpm cli -- opencode
```

`pnpm check` 会依次执行 TypeScript 类型检查、测试和 SDK 构建。

欢迎先阅读 [贡献指南](CONTRIBUTING.md)。安全问题请遵循 [安全策略](SECURITY.md)，不要在公开 Issue 中提交真实密钥、账号信息或漏洞细节。

## 许可证与声明

本项目采用 [Apache License 2.0](LICENSE) 开源。

Apexnova-connect 是独立的第三方集成项目。OpenCode、OpenAI、Codex、Anthropic、Claude、Claude Code、DeepSeek、n8n 和 Dify 等名称及商标归各自权利人所有。本项目与这些项目或公司不存在隶属、背书或官方合作关系，除非另有明确书面说明。
