# Adding an Integration

本指南定义新增 Agent、Harness、IDE、工作流或其他平台集成时应回答的问题。Manifest 必须符合 [`integration-manifest.schema.json`](../schemas/integration-manifest.schema.json)，可以从 [`manifest.example.json`](../integrations/_template/manifest.example.json) 开始。

## 1. 证明集成方式可行

在写实现前记录：

- 目标产品的准确名称、版本范围和运行平台；
- 官方插件、Provider、Node、Gateway 或配置接口文档；
- 认证、模型发现、流式输出、工具调用和错误协议；
- 分发、商标、许可及应用商店要求；
- 配置生效是否需要重启或重新打开会话。

不要依赖抓取第三方订阅令牌、未公开私有接口或绕过产品限制的方式。

## 2. 选择类别和唯一 ID

在 `integrations` 下选择最接近的类别。类别只用于组织，唯一 ID 才是稳定身份。ID 应使用小写 kebab-case，并避免公司内部代号。

## 3. 声明 capabilities

只声明已经实现并可测试的能力。缺少 `hot-switch` 并不表示集成不完整；如果平台需要重启，应明确声明和展示该限制。

## 4. 保持边界

Integration 可以：

- 发现产品和版本；
- 解析产品特有配置；
- 将用户意图转换为 change plan；
- 调用公共协议或 Gateway 能力；
- 验证连接结果并报告规范化状态。

Integration 不应：

- 自己保存 Apexnova AI Hub 长期密钥；
- 复制余额、认证或通用协议客户端；
- 在没有 change plan 的情况下直接覆盖配置；
- 把未脱敏的用户配置或提示词写入日志；
- 自动重放可能有副作用的请求。

## 5. 定义恢复语义

至少覆盖以下情况：

- 目标配置不存在或格式未知；
- 配置同时被用户或目标产品修改；
- 写入中断或验证失败；
- 用户要断开 Apexnova AI Hub 但保留其他 Provider；
- 备份来自不同产品版本；
- 凭证已经撤销或过期。

恢复操作应只撤销 Connect 管理的字段，不覆盖用户在之后添加的无关配置。

## 6. 测试

每个 integration 应提供：

- 公共 contract tests；
- 支持版本的脱敏配置 fixtures；
- 不支持版本和损坏配置的负向测试；
- change plan 快照；
- apply、verify、rollback 的临时目录测试；
- 假凭证和 mock API，不访问个人账号或生产服务。

## 7. 文档

Integration README 应说明支持状态、安装方法、能力矩阵、受管理的配置、重启要求、已知限制、断开和恢复步骤，以及对应的官方扩展文档。
