# Roadmap

## 路线原则

每个里程碑只解决一个主要问题：

```text
M0 定义清楚
M1 能连接
M2 能扩展
M3 能证明
M4 能推荐
M5 能可靠路由
M6 能跨领域复制
```

时间为小团队的相对估算，不是对外承诺。上一个里程碑没有满足退出条件时，不应通过减少验证或安全要求强行进入下一个阶段。

## M0：领域模型与产品边界冻结

预计：1～2 周。

当前状态：设计与 Schema 草案已落库，等待 Connect/Hub 跨仓评审和契约验证；评审完成前不标记为正式冻结。

交付物：

- [`product-scope.md`](product-scope.md)；
- [`domain-model.md`](domain-model.md)；
- 本路线图；
- [`cli-spec.md`](cli-spec.md)；
- [`compatibility-evidence.md`](compatibility-evidence.md)；
- [`apexnova-ai-hub-requirements.md`](apexnova-ai-hub-requirements.md)；
- Agent、Model、Provider、Deployment、Scenario、Evidence、Recommendation、Connection 和 Diagnostic Schema 草案；
- Apexnova AI Hub M1 API 契约清单；
- 开源与收费边界。

退出条件：

- Integration 与 Agent、Model、Deployment 的职责没有重叠；
- 核心模型可以表达非 Coding Agent；
- Evidence 来源、过期和冲突处理有明确语义；
- CLI 命令、错误和非交互行为已定义；
- Hub 团队能够仅依据需求文档开始 OpenAPI 设计；
- M1 不再依赖未决的产品级命名和数据边界。

## M1：Connect CLI Developer Preview

预计：4～6 周。目标版本：`v0.1`。

当前状态：进行中，已推进到 H1 staging 联调边界。已对齐 Hub H1 P6 OpenAPI/fixtures，并通过官方 mock 的 discovery、device flow、账号、余额、目录、runtime credential 创建/撤销。CLI 已实现 `detect/inspect/login/logout/whoami/balance/models`、`connect --dry-run`、`connect --yes`、`switch`、安全 `run opencode` launcher、配置级 `verify`、`doctor` 和事务 `restore`。live inference verify、runtime credential 自动轮换和 Windows/Linux 真实环境验收等待 staging。

首个正式目标：OpenCode。

范围：

- `detect`、`inspect`、`login`、`balance`、`models`；
- `connect --dry-run`、`connect`、`verify`、`switch`、`restore`、`doctor`；
- Apexnova AI Hub OAuth、账号、余额和模型目录；
- OpenCode v2 ConnectionProfile 到 Change Plan；
- 操作系统凭证引用；
- Apply、Verify、Rollback 与跨进程恢复；
- JSON 输出和规范化退出码；
- Windows、Linux 真实环境验收。

退出条件：

- 新用户可在十分钟内完成首个已验证连接；
- `--dry-run` 不修改状态；
- 密钥不进入配置、Plan、日志或命令行参数；
- 写入中断和验证失败均可恢复；
- OpenCode Integration 从 `planned` 升级到 `experimental`；
- Hub M1 Contract Test 全部通过。

依赖：

- Hub OAuth 和 scopes 冻结；
- `/me`、余额、Provider、Model、Deployment 和协议 Endpoint 可用；
- Hub 错误语义和请求 ID 可用。

## M2：Multi-Agent Alpha

预计：4～6 周。目标版本：`v0.2`。

范围：

- Claude Code 和 Codex Integration；
- Agent Discovery Contract；
- DetectionResult 和 DiagnosticResult；
- Integration 公共 Contract Test；
- Community Integration 模板；
- 产品版本漂移和安全拒绝；
- macOS Keychain 后端与三平台验收。

退出条件：

- 三个 Agent 使用同一套发现、计划、验证和恢复生命周期；
- 产品特有逻辑没有进入 `packages/core`；
- 未知配置格式不会被猜测修改；
- 社区能够独立实现只读 Detection Integration；
- 三个平台的凭证和恢复流程通过真实环境测试。

## M3：Compatibility Beta

预计：6～8 周。目标版本：`v0.3`。

范围：

- Capability Definition Registry；
- 协议、流式、Tool Call、结构化输出、图片、缓存和上下文测试；
- 不可变 Compatibility Evidence；
- Verdict 计算和 Evidence 过期；
- 静态公共兼容性矩阵；
- CLI `compatibility explain`；
- Hub Evidence 查询接口。

首批控制规模：

- 3 个 Agent；
- 6～10 个 Model Deployment；
- 8～12 项基础能力测试。

退出条件：

- 每个公开 Verdict 都有可追溯 Evidence；
- Vendor Claimed 与 Apexnova Verified 分开；
- 测试可在隔离环境中重放；
- 模型、Provider、Integration 或 Test Suite 版本变化会使相关 Evidence 过期；
- 失败日志完成脱敏。

## M4：Match Beta

预计：6～8 周。目标版本：`v0.4`。

范围：

- Coding Scenario Pack v1；
- 硬约束过滤；
- 质量、成本、速度、隐私和稳定性权重；
- 可解释 Recommendation；
- Evidence 置信度；
- CLI `recommend`；
- Hub 托管 Recommendation API；
- 商业推广标记。

退出条件：

- 相同输入和规则版本产生可重复结果；
- 每个推荐都有分项理由、备选和排除原因；
- 允许推荐非 Apexnova Provider；
- 用户可以强制模型白名单、预算、区域和隐私约束；
- 不存在隐藏商业评分项。

## M5：Reliable Provider Routing

预计：6～8 周。目标版本：`v1.0`。

范围：

- Connection Profile 和显式 Provider 切换；
- Deployment 健康、余额、区域和价格约束；
- 本地 Gateway 与 Hub 路由协作；
- Circuit Breaker；
- 新请求边界上的受控选择；
- 路由审计和实际计费来源；
- Pro 高级策略和 Team 基础能力。

退出条件：

- Provider 故障不会造成工具副作用请求的自动重放；
- 每次路由可解释且可审计；
- 切换失败不会破坏 Agent 配置；
- 三个首批 Integration 达到 stable；
- 用户始终能看到实际 Deployment 和计费主体。

## M6：Domain Expansion

M5 后按实际需求推进，不预设固定日期。

候选 Domain Pack：

- Automation：n8n、Dify、通用工作流 Agent；
- Research：搜索、引用、长上下文和文档抽取；
- Data：结构化输出、代码执行和可重复分析；
- Voice：低延迟、流式音频和中断；
- Browser：Computer Use、视觉定位和风险控制。

每个新领域必须提供：

- 至少一个真实 Integration；
- 一个版本化 Scenario Pack；
- 可重复 Capability Test；
- 不修改核心对象即可接入的证明。

## 商业能力门槛

| 阶段 | 可开始的商业能力 |
| --- | --- |
| M1 | Hub 模型消费、统一余额和基础目录 |
| M3 | 实时健康、区域延迟、持续兼容性数据 |
| M4 | Pro 推荐、偏好、预算优化和 Match API |
| M5 | 高级路由、Team 虚拟凭证、共享目录和基础审计 |
| M6+ | 多设备 Companion、自托管 Runner 和领域专属服务 |

## 暂缓清单

以下内容在 v1.0 前不进入主线：

- 完整桌面端和手机 IDE；
- 托管云开发环境；
- 自动生产部署；
- 多 Agent 编排；
- 插件市场；
- 企业 SSO/SCIM 和专属 VPC；
- 大规模模型智力排行榜。

## 里程碑评审

每个里程碑结束时记录一份 Decision Record，至少回答：

- 退出条件是否全部满足；
- 哪些风险被验证或推翻；
- 是否有真实用户完成核心流程；
- 下一阶段的最大未决依赖；
- 是否需要缩小而不是扩大范围。
