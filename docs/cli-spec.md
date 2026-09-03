# CLI Specification

## 文档状态

- 阶段：M0
- 状态：Draft
- 命令名：`apexnova`

## 目标

CLI 是首个可审计、可脚本化宿主。它负责用户交互和编排，不直接实现第三方产品配置解析、OAuth、凭证后端或协议转换。

## 全局原则

- 默认面向人类输出，`--json` 输出版本化机器数据；
- 修改状态前必须展示 Plan 并获得明确确认；
- 非交互环境没有显式 `--yes` 时拒绝修改；
- Secret 不接受普通命令行参数，避免进入 shell history 和进程列表；
- 标准输出用于结果，标准错误用于进度、警告和诊断；
- 所有命令支持 `--profile <name>` 选择本地账号/连接配置；
- 所有网络调用显示请求 ID，但不显示 Token；
- `--verbose` 仍必须脱敏；
- 未验证、受限和不兼容是不同状态。

## 全局选项

```text
--profile <name>       本地 Profile，默认 default
--json                 输出版本化 JSON
--no-color             禁用颜色
--non-interactive      禁止任何交互提示
--yes                  接受已经输出或通过 --plan-file 指定的 Plan
--timeout <seconds>    客户端操作超时
--verbose              输出脱敏诊断
--version
--help
```

`--yes` 不能跳过 Plan 生成、权限检查和 Verify，只能代替人工确认。高风险操作未来可以要求额外策略确认。

## 命令

### `apexnova detect [agent]`

扫描已注册 Integration，返回 Agent 安装、版本、配置位置、当前连接和检测置信度。

```text
apexnova detect
apexnova detect opencode --json
```

默认只读。不得读取无关目录或上传本地绝对路径。

### `apexnova inspect <agent>`

显示目标 Agent 的当前 Provider、模型、协议、Integration 状态、受管理字段和已知限制。

```text
apexnova inspect opencode
```

### `apexnova login`

显式发起 Apexnova AI Hub Device Authorization。UI 只展示 `user_code`、验证 URI 和有效期。

```text
apexnova login
apexnova login --profile work
```

### `apexnova logout`

默认删除本地会话并尝试服务端撤销当前设备。服务端不可用时必须说明“仅完成本地登出”。

```text
apexnova logout
apexnova logout --all-devices
```

`--all-devices` 需要服务端支持和额外确认。

### `apexnova whoami`

显示当前账号、Profile、设备和 Token 到期元数据，不显示 Token。

### `apexnova balance`

显示余额、币种、信用额度、更新时间和计费主体。

### `apexnova models`

查询 Model 与 Deployment 目录。

```text
apexnova models
apexnova models --agent opencode
apexnova models --protocol openai-responses
apexnova models --compatible-only
```

`--compatible-only` 只隐藏明确不兼容项；未验证项必须单独标记，不能当作兼容。

### `apexnova connect <agent>`

生成并可选执行 ConnectionProfile 对应的 Change Plan。

```text
apexnova connect opencode --deployment apexnova/model-x --dry-run
apexnova connect opencode --connection-profile coding-fast
```

选项：

```text
--deployment <id>
--connection-profile <name>
--protocol <id>
--gateway auto|on|off
--dry-run
--plan-file <path>
```

流程固定为：

```text
detect → inspect → resolve credentialRef → plan → approve → backup → apply → verify
                                                               │
                                                               └─ failure → rollback
```

### `apexnova verify <agent>`

验证当前配置、凭证引用、Endpoint、模型映射和最小协议行为。默认不执行会产生费用的大型测试；可能产生费用的验证必须展示预计上限。

### `apexnova switch <agent>`

切换到已存在 ConnectionProfile 或 Deployment，仍必须生成 Plan。

```text
apexnova switch opencode --connection-profile coding-cheap
```

首版只提供显式切换，不承诺当前 Agent 会话内热切换。

### `apexnova restore [transaction-id]`

列出或执行恢复。

```text
apexnova restore --list
apexnova restore <transaction-id> --dry-run
apexnova restore <transaction-id>
```

恢复只撤销 Connect 管理的变更，并执行并发哈希检查。

### `apexnova doctor [agent]`

执行只读诊断：

- 运行环境和版本；
- Integration 加载；
- 配置可读性；
- 凭证后端；
- Hub 连接；
- Schema 和备份目录；
- 过期或未完成事务；
- 已知 Agent 版本兼容性。

`doctor` 不自动修复。未来的 `--fix` 必须生成独立 Plan。

### `apexnova compatibility explain`

M3 提供：

```text
apexnova compatibility explain \
  --agent opencode \
  --deployment provider/model
```

输出 Verdict、限制、Evidence、测试版本、新鲜度和未验证能力。

### `apexnova recommend`

M4 提供：

```text
apexnova recommend \
  --agent opencode \
  --scenario coding.repository-edit \
  --priority quality
```

选项包括：

- `--priority quality|cost|latency|privacy|balanced`；
- `--max-cost`；
- `--region`；
- `--provider`；
- `--model-allowlist`；
- `--verified-only`。

输出推荐、备选、排除原因、Evidence 和商业推广标记。

## JSON 输出

所有 JSON 输出使用统一信封：

```json
{
  "schemaVersion": "1",
  "command": "detect",
  "requestId": "local-or-server-request-id",
  "ok": true,
  "data": {},
  "warnings": []
}
```

失败：

```json
{
  "schemaVersion": "1",
  "command": "connect",
  "requestId": "request-id",
  "ok": false,
  "error": {
    "code": "CONFIG_CONCURRENTLY_MODIFIED",
    "message": "Target configuration changed after the plan was created.",
    "retryable": false,
    "details": {}
  }
}
```

`details` 必须经过脱敏，不能包含原始 Token、完整用户配置或未授权绝对路径。

## 退出码

| Code | 含义 |
| ---: | --- |
| 0 | 成功，包括明确的 no-op |
| 1 | 未分类运行失败 |
| 2 | 参数或 Schema 错误 |
| 3 | 未认证或认证过期 |
| 4 | 权限不足或用户拒绝 |
| 5 | Agent/Integration 未发现或不支持 |
| 6 | 配置冲突、版本未知或并发修改 |
| 7 | Verify 或 Compatibility 失败 |
| 8 | 网络、Provider 或 Hub 暂时不可用 |
| 9 | 余额、预算或 Rate Limit 阻止 |
| 10 | Rollback/Restore 需要人工处理 |

## 交互与自动化

- TTY 中可以显示选择器和差异；
- 非 TTY 默认等价于 `--non-interactive`；
- 自动化必须显式指定 Deployment/Profile，不允许依赖交互默认值；
- 将来允许签名 Plan 文件，但不能接受来源未知的 Plan；
- JSON 输出字段只做向后兼容增加，破坏性变更提升 Schema Version。

## 安全要求

- 禁止 `--api-key`、`--refresh-token` 等参数；
- Secret 只能来自系统凭证存储、受控标准输入或受支持的外部 Secret Provider；
- 错误栈、HTTP Body 和第三方配置输出前必须脱敏；
- 打开浏览器或二维码不包含 `device_code`；
- CLI 不自动启用 `yolo`、`bypassPermissions` 或等价权限；
- 切换和验证不自动重放带副作用的 Agent 请求。
