# ADR 0001：分离 Integration 交付契约与产品领域契约

- 状态：Accepted
- 日期：2026-09-03

## 背景

Integration Manifest v1 描述一个适配器如何交付、需要哪些权限以及实现哪些生命周期能力。随着产品从 Coding Agent 扩展到研究、自动化和其他 Agent，模型能力、部署、场景、兼容性证据和推荐也需要机器可读结构。

如果把这些信息继续塞入 Integration Manifest，适配器版本、模型目录版本和测试证据生命周期会互相耦合，也会让 Hub 与本地客户端难以共享契约。

## 决策

保留 Integration Manifest 作为适配器交付与权限契约。新增独立的 AgentProfile、ProviderProfile、ModelProfile、ModelDeployment、ScenarioProfile、CompatibilityEvidence、Recommendation、ConnectionProfile 和 DiagnosticResult Schema。

实体通过稳定 ID 和显式版本关联，不共享隐式名称。Hub 拥有账号、Deployment、计费和服务端证据数据；Connect 拥有本地检测、连接和诊断数据；开源仓库维护公共契约。

## 替代方案

- 扩展单个 Integration Manifest：文件少，但生命周期与权限边界混乱；
- 只使用 TypeScript 类型：实现方便，但无法支持多语言 SDK、Hub 仓库和第三方验证；
- 完全采用 Hub 私有响应：短期快，但会让开源客户端被服务端实现细节锁定。

## 后果

- Schema 数量增加，需要版本管理和跨文件引用；
- Integration 作者只需维护与自身有关的 manifest 和 AgentProfile，不负责伪造模型证据；
- Hub 与 Connect 可以通过公开 Schema 和契约测试独立演进；
- 推荐必须引用版本化 Deployment 与证据，不能只依赖模型名称。
