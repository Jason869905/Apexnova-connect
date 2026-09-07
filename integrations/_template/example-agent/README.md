# Example Agent（只读 Detection 模板）

可运行的 Integration 模板：它只发现产品、读取配置并报告状态，**不做任何修改**。复制这个目录就能开始一个新的 Agent Integration，`pnpm test` 直接就是绿的。

## 它演示了什么

- `manifest.ts` 是唯一事实来源，`manifest.json` 是语言无关副本，contract test 保证两者不漂移；
- 未安装的机器上 `detect` 返回 `not-found` 而不是抛异常；
- 配置无法解析时返回 `status: "invalid"`，警告里只说“文件坏了”，不含文件内容；
- `plan` / `verify` / `planLaunch` 明确拒绝（`READ_ONLY_INTEGRATION`），而不是留下半实现的生命周期；
- manifest 只声明真正做得到的东西：`capabilities: []`、只要 `filesystem-read` 权限。

只读集成的 status 用 `experimental` 而不是 `research`：Schema 规定 `research`/`planned` 的 Integration 不允许声明任何 capability 或权限，而这里的检测是真实且有测试覆盖的。

## 从这里开始

1. 复制 `integrations/_template/example-agent` 到 `integrations/<类别>/<你的-agent>`；
2. 改 `manifest.json` 和 `src/index.ts` 里的 id、显示名、版本范围、配置路径与权限；
3. 先只实现 `detect` 和 `inspect`，跑通 `describeIntegrationContract({ ..., readOnly: true })`；
4. 要支持写入时，实现 `plan` / `verify` / `planLaunch`，去掉 `readOnly: true`，补上 `unsupportedConfigs`、`preservedConfig` 和 `unsupportedProtocol` 三组 fixture，再在 manifest 里声明对应的 capability 与权限；
5. 在 `apps/cli/src/integrations.ts` 注册。

完整要求见 [新增 Integration 指南](../../../docs/adding-an-integration.md)。
