# OpenCode + Apexnova AI Hub 使用指南

> 适用版本：apexnova-connect v0.2.1 · OpenCode ≥1.18.29 <2.0.0
> 平台：Windows、Linux

> [!NOTE]
> v0.2 起支持四个 Agent。本文是 OpenCode 专属指南，其余三个见
> [Codex](codex-usage-guide.md)、[Claude Code](claude-code-usage-guide.md)、[Hermes Agent](hermes-usage-guide.md)。
> 文中的 `apexnova opencode` 是 `apexnova run opencode` 的别名，继续可用。

## 简介

`apexnova-connect` 是一个 CLI 工具，把 OpenCode 的模型请求路由到 Apexnova AI Hub。**登录一次，一行命令启动 OpenCode**——自动创建永久 API Key、写入 Provider 配置、注入凭证、启动会话。

核心流程：

```
apexnova login        # 网页授权，一次性
apexnova run opencode # 自动选模型 + 创建 key + 写配置 + 启动
apexnova models       # 上下键切换模型
apexnova usage        # 按模型/按 key 看用量
apexnova balance      # 看余额
```

## 先完成通用设置

安装、Linux 凭证后端、Hub 地址、登录、Key 模式、通用命令、超时、环境变量和安全说明都在
[CLI 通用指南](cli-usage-guide.md)——那份是所有 Agent 共用的，本文只讲 OpenCode 特有的部分。

前置条件：Node.js 20+、已安装 OpenCode（`apexnova detect opencode` 可确认）、一个 Apexnova AI Hub 账号。

## 受管理的字段

配置文件按项目目录、`XDG_CONFIG_HOME`、平台配置目录的顺序探测，通常是
`~/.config/opencode/opencode.json(c)`（Windows 为 `%APPDATA%\opencode\opencode.json(c)`）。

只写 `provider.apexnova` 一段和顶层 `model`，其余内容（注释、其他 provider、主题等）逐字保留：

```jsonc
{
  "provider": {
    "apexnova": {
      "name": "Apexnova AI Hub",
      "env": ["APEXNOVA_API_KEY"],
      "npm": "@ai-sdk/openai",              // Responses；chat completions 用 @ai-sdk/openai-compatible
      "options": {
        "apiKey": "{env:APEXNOVA_API_KEY}", // 变量引用，不是密钥本身
        "baseURL": "<Hub 推导出的 /v1 根>"
      },
      "models": { "<inferenceAlias>": { "name": "..." } }
    }
  },
  "model": "apexnova/<inferenceAlias>"
}
```

**配置文件里不会出现任何密钥。** 密钥由 `apexnova run opencode` 注入进程环境。

支持 `openai-responses` 和 `openai-chat-completions` 两种协议；一个 provider 段不能混用两种，混用会返回 `MIXED_PROTOCOLS`。已被弃用的复数 `providers` 结构会被识别为 `LEGACY_CONFIG` 并拒绝改写。

## 快速开始

### 1. 启动 OpenCode

```bash
apexnova opencode
```

这一行命令会：
1. 检测 OpenCode 安装
2. 获取 Hub 模型目录，自动选择第一个可用模型（交互模式下弹出上下键选择器）
3. 向 Hub 创建一个**永久 API Key**（`sk-`，永不过期）
4. 写入 OpenCode 配置文件（`~/.config/opencode/opencode.jsonc`），Provider 的 `apiKey` 字段写 `{env:APEXNOVA_API_KEY}` 占位符——**secret 不落盘**
5. 通过环境变量 `APEXNOVA_API_KEY` 注入 key，启动 OpenCode 子进程

也可以指定模型或传参：

```bash
# 指定模型（deployment ID 从 apexnova models 输出中获取）
apexnova opencode --deployment deployment.apexnova.xxx

# 传参给 OpenCode
apexnova opencode -- --model apexnova/glm-5.2
```

### 2. 切换模型

交互模式下直接用上下键选择：

```bash
apexnova models
```

列出所有可用模型，上下键选中目标，回车即切换（自动创建新 key + 更新配置）。按 Esc 取消。

非交互模式用 `switch`：

```bash
apexnova switch opencode --deployment deployment.apexnova.xxx --yes
```

> **非交互首次运行必须指定模型**：没有已绑定的 deployment 且终端不可交互（`--json`、`--non-interactive`、CI）时，`apexnova opencode` 不会替你挑一个，而是返回 `DEPLOYMENT_REQUIRED`（退出码 2）。先用 `apexnova models --json` 列出候选，再传 `--deployment`。

### 3. 查看用量和余额

`apexnova balance` 和 `apexnova usage` 对所有 Agent 通用，见
[CLI 通用指南](cli-usage-guide.md#通用命令)。

## 完整流程示例

```bash
# 1. 配置 Hub（发布产物已内置生产地址，可跳过）
apexnova init --hub-url https://api.apexnova-consulting.com --client-id apexnova-connect

# 2. 登录（一次性）
apexnova login

# 3. 启动 OpenCode（自动选模型 + 创建永久 key + 写配置 + 启动）
apexnova opencode

# 4. 切换模型（上下键选择）
apexnova models

# 5. 查看用量
apexnova usage --granularity day

# 6. 用完退出
apexnova logout
```

## dev 环境联调

连接本机 dev Hub（Next.js dev server + nginx）：

```bash
export APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK=1
apexnova init --hub-url http://localhost:3000 --client-id apexnova-connect --path-prefix /api --force

apexnova login      # 浏览器打开 http://console.localhost/device 授权
apexnova opencode   # 永久 key 路径
```

dev 环境注意事项：
- `*.localhost` 只有浏览器会自动解析，curl/Node 不会——需要加 `/etc/hosts` 条目
- 设备批准页只能走 `console` 子域（`console.localhost/device`）
- dev 按需编译，每个端点首次请求慢 1–10 秒
- 不改 hosts 时推理用 `http://127.0.0.1:3000/api/v1`，但 OAuth 授权仍需 `console.localhost`
