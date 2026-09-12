# 0025 能力套件扩到 `openai-chat-completions`（套件 0.4.0）

- 状态：已接受
- 日期：2026-09-12
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0024](0024-narrow-platform-claims.md) 第 3 节指出六个缺口里有三个卡在「能力套件够不着这个协议」，且跑多少遍都不会关闭
- 结论：套件新增第三个协议，版本 `0.3.0 → 0.4.0`；`hermes` 补齐并**机检无缺口**；剩余缺口从「卡工具」全部转为「卡环境」

## 1. 为什么扩套件而不是收窄声明

[ADR 0024](0024-narrow-platform-claims.md) 处理 macOS 时选的是收窄声明，因为那是「声称了一个从未测过的平台」。这一条**形状不同**，所以选择相反：

`openai-chat-completions` 是 `opencode` 与 `hermes` **真实支持并且在用**的协议——`hermes` 的默认模式就是它。够不着的是我们的测量工具。在这里收窄声明，是把要求改到工具的能力上，而不是改到事实上；[ADR 0012](0012-region-is-the-wrong-requirement.md) 与 [ADR 0022](0022-m5-midpoint-review.md) 都否决过这种方向。

## 2. 三处真正的差异

加一个协议不是把分支复制一遍。读响应这一侧有三处是实质不同的，也正是容易错的地方：

1. **流式没有事件名。** Responses 与 Messages 都用 `event:` 行给每一帧命名；Chat Completions 一个都没有——每帧是一个对象，靠 `object` 字段说明自己是什么，并以 `data: [DONE]` 这个**不是 JSON** 的哨兵收尾。套件原先的取名逻辑会把这样的流读成「零个事件」。现在按帧取名：`event:` 行优先，其次 payload 的 `type`，再次 `object`，`[DONE]` 单独识别；

   因此这个协议的 `protocol.streaming-order` 判据是「首帧 `chat.completion.chunk`、末帧 `[DONE]`」。**这就是它全部的顺序契约**，所以这就是全部的要求——不多要，也不少要；

2. **工具调用不在内容列表里。** 另两个协议把调用放在套件遍历的 item 列表中；这个协议挂在 `choices[0].message.tool_calls[]`，参数是 JSON 字符串。读错的后果不是报错，是**把一个工具调用完全正常的模型报成不会调工具**；

3. **它有自己的结构化输出模式。** Anthropic Messages 没有，所以套件在那里用「强制一个 input schema 就是目标形状的工具」并在证据里说明这一点。Chat Completions 有 `response_format: json_schema`，所以直接问——与 Responses 同路，与 Messages 不同路。

另有一处词汇差异：目录把这个协议拼作 `openai-chat`，而 manifest 与 schema 拼作 `openai-chat-completions`。证据**记录目录自己的拼法**（这样一个 subject 不会裂成两个），因此状态机检在比对前把它归一化到 schema 的词汇。

## 3. 版本按这个常量自己的约定走

`CAPABILITY_SUITE_VERSION` 的文档写着：major bump 意味着套件变得使旧结果失效；而 capability 定义那段写着「加一个 capability 是 minor bump：0.2.0 下写的记录仍然有效，只是对它不置一词」。

**加一个协议是同一种情况**：九个 capability 一个没动，`CAPABILITY_DEFINITIONS_DIGEST` 因此没变，旧记录仍然有效、只是对 chat-completions 不置一词。所以 `0.4.0`。

**一处自己造出来又自己修掉的不一致要记下**：扩完套件后我先采了四条 chat-completions 证据，那时版本还写着 `0.3.0`。这些记录对「是什么代码产生了它们」是准确的，但 `0.3.0` 作为一个**已发布的身份**并不包含这个协议——同一个版本号会有两种含义。于是升版后重采了那四条（约 0.012 USD），四次结论与升版前逐项一致。旧的四条留在本地存储里，按观测时间自然被取代，矩阵取的是 0.4.0 那批。

（尝试 `compatibility revoke` 撤销旧记录返回 `NOT_FOUND`：那条命令作用于 **Hub 已发布**的记录，而这几条尚未 `sync`。是误用，不是缺陷。）

## 4. 第一次真机运行的结果

`hermes` × 四个 Deployment × `openai-chat`，九项里八项 supported：

- **流式顺序在真机上确认**：`41 events, chat.completion.chunk first and [DONE] last`。`[DONE]` 哨兵真实存在，按规范写的实现与端点实际行为一致；
- **`agent.structured-output` 两个 supported、两个 unsupported**。这是**真实的逐部署结论，不是实现缺陷**——若是探针写错，四个会一起失败。

第二点还带出一个只有测了第二个协议才看得见的发现：GLM-5.1 与 GLM-5.2 在 `anthropic-messages` 上 `agent.structured-output` 是 **supported**（那条路径是强制工具，它们支持），在 `openai-chat-completions` 上是 **unsupported**（`response_format: json_schema` 它们不照做）。**同一个部署、同一个 capability、两个协议、两个结论。** 只测一个协议会给出一个看起来完整、实际只对一半的答案。

同样地，`cmtdear4g…` 的 `agent.forced-tool-choice` 在两个协议上都因 `tool_choice` 不接受 `required` 而失败——跨协议一致，说明那是部署侧限制。

## 5. 缺口现状：三个卡工具的没了，剩下的全是环境

| Integration | 机检缺口 |
| --- | --- |
| `claude-code` | **无** |
| `hermes` | **无**（本记录补齐） |
| `opencode` | windows + linux / `openai-chat-completions` |
| `codex` | windows + linux / `openai-responses` |

**四个剩余缺口没有一个再卡在套件上**，全部卡在环境：本机 PATH 上 `opencode` 与 `codex` 解析到的是 `/mnt/c/` 下的 Windows 安装（Linux 侧没装），Windows 那两格需要一个 Windows 会话。这是一类完全不同的阻塞——它不需要写代码，需要装两个客户端和借一台 Windows。
