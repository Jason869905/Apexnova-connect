# Tests

跨包测试资产目录：

- `contract`：所有 integrations 必须通过的公共行为测试；
- `integration`：针对真实配置格式但使用临时目录和假凭证的测试；
- `e2e`：应用级端到端流程；
- `fixtures`：经过脱敏的版本化样例。

测试不得读取或覆盖开发者真实客户端配置。

当前端到端测试使用操作系统临时目录，把 OpenCode v2 planner、生命周期审批、`FileConfigExecutor`、验证和 rollback 串联起来；测试结束前会校验目录归属，再清理自己创建的临时目录。
