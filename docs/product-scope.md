# Product Scope

## 文档状态

- 阶段：M0 领域模型与产品边界冻结
- 状态：Draft
- 适用范围：Apexnova-connect 开源仓库与独立的 Apexnova AI Hub 服务

## 产品愿景

Apexnova Connect 是开放的 Agent–Model 连接、兼容性验证与场景推荐层。它帮助用户发现已经安装或可访问的 Agent，安全接入模型，验证 Agent 与具体模型线路的真实兼容性，并在不同 Provider 之间进行可解释、可恢复的切换。

长期目标是回答三个问题：

1. 一个 Agent 对模型和运行环境有什么要求？
2. 一个具体 Model Deployment 实际具有什么能力？
3. 在给定场景、预算、延迟、隐私和区域约束下，应选择哪条模型线路？

Coding Agent 是第一个可验证的领域，不是产品边界。后续可以通过新的 Integration 与 Scenario Pack 扩展到自动化、研究、数据分析、客服、文档、浏览器和语音 Agent。

## 核心用户

### 个人开发者和 Agent 用户

- 同时使用多个 Agent，但不希望分别维护 Provider 配置和密钥；
- 希望知道某个模型是否真的兼容当前 Agent；
- 希望在成本、质量和速度之间做出可解释选择；
- 需要在修改配置前查看差异，并在失败后可靠恢复。

### 小型团队

- 没有专门的 AI 平台工程团队；
- 需要共享允许的模型目录、预算和 Provider Profile；
- 需要基础用量归属、虚拟凭证和审计能力；
- 希望保留本地或自托管执行环境。

### Integration 和 Provider 开发者

- 希望通过稳定 Schema 和 Contract Test 接入新 Agent；
- 希望声明模型能力并提交可复现的兼容性证据；
- 希望其服务能被不同 Agent 正确发现和配置。

## 核心用户任务

```text
detect → inspect → authenticate → select → plan → approve → apply → verify
                                                           │
                                                           └─ failure → rollback
```

产品必须支持：

- 自动发现 Agent、版本、配置位置和已启用 Provider；
- 使用凭证引用而不是明文密钥生成 Connection Profile；
- 在修改前展示字段级或文本级 Change Plan；
- 应用后验证，不将“写入成功”等同于“连接成功”；
- 用 Evidence 支撑兼容性结论；
- 显示实际模型、Provider、Deployment 和计费来源；
- 在不确定时返回 `unverified`，不猜测兼容；
- 对失败切换执行确定性恢复。

## 产品组成

### Apexnova Connect OSS

开源、本地优先的客户端和契约层，包含：

- CLI 与未来的桌面宿主；
- Agent Detection 和 Integration Runtime；
- Integration Manifest、SDK 和 Contract Test；
- Change Plan、备份、验证和恢复；
- 系统凭证存储；
- Provider Profile 与可选本地 Gateway；
- 本地兼容性验证和基础推荐；
- 允许连接 Apexnova AI Hub、其他兼容 Provider 和本地模型。

### Apexnova Registry

开放的机器可读目录，包含：

- Agent Profile；
- Model Profile；
- Provider Profile；
- Model Deployment；
- Scenario Profile；
- Compatibility Evidence 与 Verdict。

Registry 可以先以版本化静态资产发布，后续由 Apexnova AI Hub 提供实时查询接口。

### Apexnova Match

使用硬约束、场景权重、运营约束和 Evidence 置信度生成可解释 Recommendation。首版使用公开、确定性的规则，不使用无法解释的黑盒排名。

### Apexnova AI Hub

独立服务端项目，负责：

- 账号、设备授权和凭证撤销；
- 余额、账单、用量和价格；
- Provider 与 Model Deployment 目录；
- 推理协议入口和服务端路由；
- Deployment 健康状态；
- 托管兼容性证据、推荐和付费策略；
- 小团队的共享目录、预算和虚拟凭证。

详细服务端要求见 [`apexnova-ai-hub-requirements.md`](apexnova-ai-hub-requirements.md)。

## 开源与商业边界

### 必须开放

- Schema、Integration SDK 和 Contract Test；
- Agent Detection、配置计划、验证和恢复；
- 本地凭证存储和本地 Gateway；
- 基础兼容性测试和证据格式；
- 本地规则匹配和推荐解释；
- 非 Apexnova Provider 的适配能力。

### 可收费

- Apexnova AI Hub 模型消费；
- 实时线路健康、区域延迟和历史稳定性；
- 高频持续兼容性验证；
- 托管 Match API 和高级路由策略；
- 多设备同步、通知和远程 Runner 管理；
- Team 预算、虚拟凭证、共享 Profile 和基础审计。

## 设计原则

1. **Agent-agnostic core**：核心对象使用 `Agent`、`Workspace`、`Scenario` 和 `ModelDeployment`，Coding 字段只存在于领域扩展。
2. **Evidence before claims**：厂商声明、Apexnova 验证、社区验证和运行观测必须分开。
3. **Local-first and reversible**：本地状态修改必须先计划、再审批、可验证、可恢复。
4. **Provider-neutral OSS**：Apexnova AI Hub 是默认体验最好的 Provider，但不是开源客户端的唯一 Provider。
5. **Transparent commerce**：推荐不得暗中加入商业权重；推广结果必须明确标注。
6. **No unsafe replay**：不得自动重放可能已经触发工具、文件、终端或网络副作用的请求。
7. **Capability truthfulness**：Capability 只表示已实现且已测试的行为。
8. **Progressive scope**：每个里程碑只解决一个主要问题。

## M0 至 v1.0 范围

- OpenCode、Claude Code 和 Codex 三个首批 Agent；
- Apexnova AI Hub 与通用兼容 Provider；
- 自动发现、连接、验证、显式切换和恢复；
- 技术兼容性矩阵；
- Coding Scenario Pack v1；
- 可解释 Recommendation；
- 受控 Provider 路由。

## 明确不进入 v1.0

- 自研基础模型或完整 Coding Agent；
- 完整云 IDE 或手机 IDE；
- 大规模托管 Sandbox 平台；
- 自动生产部署；
- 多 Agent 编排；
- 重型企业 SSO、SCIM、跨区域合规和专属 VPC；
- 无审核的第三方 Integration 市场；
- 对所有 Agent 体验完全一致的承诺。

## 成功指标

M1 至 v1.0 优先观察：

- 从安装到首个已验证连接的完成率和耗时；
- Detection 的准确率与误报率；
- Apply 后 Verify 通过率；
- Rollback 成功率；
- 兼容性结论的证据覆盖率和新鲜度；
- 推荐被采用后的任务成功率、切换率和用户覆盖原因；
- Integration 由社区独立实现并通过 Contract Test 的数量；
- Hub 用户中由 Connect 带来的激活和持续消费比例。

下载量、支持的模型数量和 Integration 数量不能单独作为成功指标。
