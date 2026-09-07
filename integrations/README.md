# Integrations

Integration 是 Apexnova-connect 连接外部产品的最小独立单元。每个 integration 负责目标产品特有的检测、能力声明、配置计划、验证和恢复，不负责实现 Apexnova AI Hub 的计费或通用模型协议。Integration 可以使用不同语言和官方运行时，跨语言行为以 `schemas` 中的机器可读契约为准。

## 分类

- `agents`：AI Agent、Coding Agent、CLI 与 Harness。
- `automation`：工作流编排、低代码与自动化平台。
- `_template`：新 integration 的目录模板和完成标准。

未来可以增加 `ides`、`gateways`、`chat-clients` 等类别，但公共 contract 不应依赖分类名称。

## 预期组成

具体文件扩展名可以随目标平台运行时变化，但每个 integration 至少应包含等价内容：

```text
<integration>/
├── manifest.*        # 身份、版本、平台与 capability 声明
├── src/              # 产品特有实现
├── tests/            # contract 与 integration tests
├── fixtures/         # 脱敏配置样例
└── README.md          # 支持范围、限制和恢复方式
```

`_template/example-agent` 是可运行的只读 Detection 模板：复制它就能开始一个新 Integration，`pnpm test` 直接是绿的。

每个 Integration 必须通过 `packages/integration-testing` 的公共 Contract Test（`describeIntegrationContract`）才能超出 `research` 状态。套件覆盖 manifest 有效性与 `manifest.ts`/`manifest.json` 漂移、未安装机器上的检测、对无法识别的配置格式的拒绝、计划的确定性与幂等、计划与启动命令行中不得出现 secret，以及 apply → verify → rollback 的字节级往返。

详见 [新增 Integration 指南](../docs/adding-an-integration.md)。
