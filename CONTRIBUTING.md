# Contributing to Apexnova-connect

感谢你参与 Apexnova-connect。项目仍处于 pre-alpha，当前贡献重点是集成需求、协议兼容性、架构边界、安全设计和可复现测试。

## 开始之前

1. 先搜索已有 Issue，避免重复提案。
2. 新增目标平台时，说明其官方扩展接口、认证方式、模型协议和平台限制。
3. 影响公共 contract、凭证处理或配置写入方式的改动，应先通过 Issue 或设计文档达成共识。
4. 不要提交真实 API key、访问令牌、账号数据、提示词、生产配置或未脱敏日志。

## 新增 Integration

请从 `integrations/_template` 开始，并遵循 [新增 Integration 指南](docs/adding-an-integration.md)。每个 integration 都应：

- 只声明真实支持并经过验证的 capabilities；
- 把产品特有逻辑留在自己的目录中；
- 提供平台检测、变更预览、失败处理和恢复说明；
- 使用 mock 数据和脱敏 fixtures；
- 通过公共 contract tests；
- 链接目标产品允许该集成方式的官方文档。

## 变更范围

- `packages/core`：只放与具体外部产品无关的领域模型和编排逻辑；
- `packages/protocols`：负责协议级转换，不负责修改产品配置；
- `integrations/*`：负责产品发现、配置计划和生命周期；
- `apps/*`：负责用户交互，不直接复制 integration 逻辑。

## 本地验证

当前基础工具链要求 Node.js 24+ 和 pnpm 9.15+：

```bash
pnpm install
pnpm check
```

`pnpm check` 必须在提交前通过。应用和 integration 可以按目标平台采用不同运行时；新增运行时应同时补充可复现的安装、测试和构建说明。
