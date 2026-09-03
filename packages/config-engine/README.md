# Config Engine

负责生成和验证 change plan、展示差异、创建备份、原子更新配置以及确定性恢复。产品配置格式由 integrations 解析，本包只提供通用事务语义。

当前实现提供 `FileConfigExecutor`：仅允许写入显式根目录，使用 SHA-256 乐观并发控制，拒绝符号链接，通过同目录临时文件完成原子替换，并把权限受限的备份用于受保护回滚。

每次应用都会建立持久化 transaction 目录，并在修改目标文件前写入带完整性校验的元数据和全部备份。新进程可以通过 `listBackups()` 发现未恢复的 transaction，用 `getReceipt()` 重建 receipt，再调用 `rollback()` 恢复。恢复操作可重试，但元数据校验只用于发现损坏或意外篡改，不构成对拥有本机文件写权限攻击者的密码学认证。
