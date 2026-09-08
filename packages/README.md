# Shared Packages

此目录存放主运行时中与具体目标产品解耦的公共模块。依赖方向应从 applications 和 integrations 指向 packages；公共 packages 不应反向导入任何具体 integration。需要跨语言共享的契约放在 `schemas`，对应的语言封装放在 `sdks`。

| 包 | 职责 |
| --- | --- |
| `core` | 领域模型、capability contract、运行时编排和规范化错误 |
| `hub-client` | Apexnova AI Hub 公共 API、认证、余额和模型目录客户端 |
| `credential-store` | 操作系统安全凭证存储抽象 |
| `config-engine` | Change plan、差异预览、备份、原子写入和恢复 |
| `capabilities` | Capability Definition Registry、Compatibility Evidence 的本地不可变存储与 Verdict 计算 |
| `protocols` | OpenAI、Anthropic 等模型协议与元数据映射 |
| `gateway` | 必要时使用的本地协议 Gateway，不承载产品特有逻辑 |
