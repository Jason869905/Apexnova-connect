# Integration Template

新增集成时复制此目录，并完成以下内容：

- 唯一 ID、展示名称、类别和维护者；
- 支持的操作系统、产品版本和模型协议；
- 经过验证的 capability 声明；
- 安装检测与版本探测；
- 配置 change plan、验证、备份和恢复策略；
- 凭证存储方式与最小权限说明；
- contract tests、脱敏 fixtures 和 mock 行为；
- 官方扩展文档、已知限制和卸载步骤。

不要先复制另一个集成的产品逻辑再修改；优先组合 `packages` 提供的公共能力。

`manifest.example.json` 是可执行的 Manifest v1 示例，由 TypeScript SDK 测试持续校验。复制后必须替换示例身份、权限目标和能力声明；不要把示例域名当作真实服务地址。
