# Architecture Decision Records

此目录用于记录影响多个 applications、packages 或 integrations 的架构决策，例如技术栈、manifest 格式、插件加载模型、Gateway 边界和凭证存储策略。

建议文件名格式：`NNNN-short-decision-title.md`。每条记录至少包含背景、决策、替代方案、后果和状态。

当前记录：

- [ADR 0001：分离 Integration 交付契约与产品领域契约](0001-separate-integration-and-domain-contracts.md)
- [ADR 0002：Agent Discovery Contract 与 Integration Registry](0002-agent-discovery-contract.md)
- [ADR 0003：M2 里程碑评审](0003-m2-milestone-review.md)
- [ADR 0004：M3 启动的首批范围与 Evidence 产出路径](0004-m3-scope-and-evidence-path.md)
- [ADR 0005：M3 里程碑评审](0005-m3-milestone-review.md)
- [ADR 0006：M3 收口](0006-m3-closure.md)
- [ADR 0007：M4 启动的首批 Scenario 与 Recommendation 产出路径](0007-m4-scope-and-recommendation-path.md)
- [ADR 0008：非 Apexnova Provider 的候选来源属于 M5](0008-non-apexnova-candidates-belong-to-m5.md)
- [ADR 0009：Recommendation 记录 Scenario 的 profileVersion（schemaVersion 0.2）](0009-recommendation-schema-carries-the-profile-version.md)
- [ADR 0010：M4 约束退出条件的逐项状态](0010-m4-constraint-exit-condition-status.md)
- [ADR 0011：M4 里程碑评审](0011-m4-milestone-review.md)
- [ADR 0012：区域不是一条约束，是一个测量条件](0012-region-is-the-wrong-requirement.md)
- [ADR 0013：M4 二次评审](0013-m4-second-review.md)
- [ADR 0014：数据处理属性由 Hub 后续提供，隐私约束移到 M5](0014-data-handling-attributes-belong-to-m5.md)
- [ADR 0015：M4 收口](0015-m4-closure.md)
- [ADR 0016：M5 启动的首批范围](0016-m5-scope-and-first-batch.md)
- [ADR 0017：M5 首批评审](0017-m5-first-batch-review.md)
- [ADR 0018：Gateway 首个切片](0018-gateway-first-slice.md)
- [ADR 0019：Gateway 首个切片评审](0019-gateway-first-slice-review.md)
- [ADR 0020：Gateway 这一批的收尾，仍然保持可选](0020-gateway-batch-closure.md)
- [ADR 0021：经 Gateway 的凭据在运行期内续期，并且一律是短期的](0021-gateway-credential-renewal.md)
- [ADR 0022：M5 中期状态评审，并撤销两条退出条件](0022-m5-midpoint-review.md)
- [ADR 0023：Integration 状态阶梯的判定标准](0023-integration-status-ladder.md)
- [ADR 0024：收窄平台声明，不再声称支持 macOS](0024-narrow-platform-claims.md)
- [ADR 0025：能力套件扩到 `openai-chat-completions`（套件 0.4.0）](0025-capability-suite-covers-chat-completions.md)
- [ADR 0026：Linux 两格补齐，只剩 Windows](0026-linux-collection-completes.md)
- [ADR 0027：M2 的平台退出条件改为两个平台](0027-m2-exit-condition-two-platforms.md)
