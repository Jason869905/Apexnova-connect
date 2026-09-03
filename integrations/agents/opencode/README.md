# OpenCode Integration

OpenCode 原生插件与自定义 Provider 的规划目录。当前已实现 OpenCode v2 Provider 配置的纯 change-plan 生成器：支持 JSONC、保留无关配置、不写入 API key，并明确要求重启。

当前限制：

- 已与公共文件执行器完成临时目录端到端测试，但尚未通过 CLI 对用户配置开放；
- 尚未连接操作系统凭证存储；公共执行器已支持持久化 transaction 与跨进程恢复；
- 只支持 OpenCode v2 的 `providers/package/settings` 配置；
- 检测到旧版 `provider/npm/options` 配置时会安全拒绝；
- 同一个 Provider 计划不能混用 Responses 与 Chat Completions 协议；
- manifest 继续保持 `planned`，在端到端 apply、verify 和 rollback 完成前不声明已交付 capability。

实现依据：[OpenCode v2 Provider 文档](https://opencode.ai/v2/docs/providers)。
