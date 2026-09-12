# 0023 Integration 状态阶梯的判定标准

- 状态：已接受
- 日期：2026-09-12
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0022](0022-m5-midpoint-review.md) 第 2 节把「三个首批 Integration 达到 stable」从无人过问改为明确未满足，并指出它缺的是判定标准
- 结论：五档各自写出判定条件；必要条件中可机检的部分**当场实现为测试**；四个 Integration 按新标准**全部仍是 `experimental`**

## 1. 为什么这条要先做

[ADR 0022](0022-m5-midpoint-review.md) 的判断是：这条退出条件至今没被提起，不是疏忽，而是**它是唯一一条写代码时永远撞不上的条件**。`stable` 在 schema 的 enum 里，`adding-an-integration.md` 第 6 节也只定义了一级门槛（不通过契约套件不得超出 `research`），`experimental → stable` 之间没有任何东西。

因此本记录的产出**不能只是一段定义**。一段无人核对的定义与今天的状况没有区别——它仍然会在收口那天被默认满足。必要条件里凡是能机检的，本记录同时交付检查。

## 2. 五档的判定条件

| 档位 | 含义 | 判定 |
| --- | --- | --- |
| `research` | 只证明了集成方式可行 | [adding-an-integration](../adding-an-integration.md) 第 1 节：找到了配置面或启动面的接入点 |
| `planned` | 已决定要做，ID 与类别已定，尚无实现 | manifest 存在并通过 schema 校验 |
| `experimental` | 能用，但覆盖面未经证明 | 通过 `describeIntegrationContract`（含不支持版本与损坏配置的负向 fixtures）；**至少一个**声称平台上完成过一次现网生命周期验收 |
| `stable` | 声称的范围内都经过实测 | `experimental` 全部条件，外加第 3 节五条 |
| `deprecated` | 不再维护，保留以读取旧配置 | 有替代路径或明确的退出说明 |

## 3. `stable` 的五条

1. **声称即有据。** manifest `compatibility.platforms` 里的**每个平台** × manifest 声明的**每个协议**，在已提交的[兼容性矩阵](../compatibility-matrix.md)里都有一条未过期、非 `unknown` 的 Apexnova 实测结论。

   要求的是**测过**，不是**全过**：`partial` 与 `incompatible` 同样算数据齐全，因为它们是真实结论。不满足的只有两种——缺行，和 `unknown`。

2. **端到端闭环有记录。** 在每个声称平台上各有一次 `connect → run → 归属对账 → restore` 的真实记录，写在 [Hub 联调清单](../hub-h1-integration-checklist.md)，含真实 `requestId` 对账。

3. **失败可恢复有验收。** 该 Integration 在 apply 失败注入下配置不被破坏（事务与逆序 `restore`），负向 fixtures 覆盖不支持版本与损坏配置。

4. **文档齐全。** README 覆盖 [adding-an-integration](../adding-an-integration.md) 第 7 节的各项，并有一份 `docs/<agent>-usage-guide.md`。

5. **已知限制不得为空。** README 的「已知限制」一节必须有实质内容。**一个没有已知限制的 Integration，说明没有人认真用过它**——这一条是给前四条兜底的，因为前四条都可以在只跑顺利路径的情况下满足。

### 这五条里谁能机检

第 1 条与第 4 条能，**并且已经实现**（`tests/integration-status.test.ts`）。第 2、3、5 条是人的判定，但各自指向一处具体记录，不是印象。

## 4. 机检怎么做才不是摆设

只检查「声称 `stable` 的 Integration 是否够格」在今天是**空检查**——四个都没声称，断言永远通过。而空检查正是 [ADR 0022](0022-m5-midpoint-review.md) 第 2 节批评的那种东西的又一个版本。

因此检查是双向的：

- **不得高报**：manifest 写 `stable` 时，第 1、4 条必须全部成立；
- **缺口要对账**：四个 Integration 各自缺哪几条，以一张表写死在测试里。**证据一旦补上、或平台声明一旦收窄，测试立刻失败**，迫使作者同时更新那张表并重新判断档位。

第二条是让检查非空的关键。它不强制升档——第 2、3、5 条机器看不见，够格与否仍要人判断——但它保证**状态与事实之间的任何漂移都会当场报错**，而不是等到收口。

## 5. 按新标准，今天四个都是 `experimental`

下表是机检算出来的，不是我列的。**这一点必须写明，因为它当场推翻了本记录的初稿**：初稿说 `opencode` 只差 macOS，检查跑出来的是它还差**整整一个协议**——manifest 声称 `openai-responses` 与 `openai-chat-completions` 两个，证据只有前一个，三个平台上都是。

| Integration | 声称 | 缺的证据（平台/协议） |
| --- | --- | --- |
| `opencode` | win/mac/linux × responses, chat-completions | macos/responses；**三个平台的 chat-completions 全缺** |
| `claude-code` | win/mac/linux × anthropic-messages | macos/anthropic-messages |
| `codex` | win/mac/linux × responses | **三个平台全缺**（一条证据都没有） |
| `hermes` | mac/linux × chat-completions, anthropic-messages | **四格全缺**（一条证据都没有） |

实际测过的只有两个平台（`linux-x64`、`windows-x64`）和两个协议（`opencode` 的 `openai-responses`、`claude-code` 的 `anthropic-messages`）。

三个结论值得单独写出来：

- **初稿那次出错本身就是这条标准要防的东西。** 我是照印象写的表，而印象里 `opencode` 是覆盖最好的那个。协议维度从来没有人按 Integration 声称的范围核对过，所以它不在任何人的印象里。**第 4 节坚持要机检，理由在写完五分钟后就兑现了**；
- **macOS 一次性卡住全部四个。** 自 M2 起挂账至今，此前它只是一条零散的备注；第 1 条把它变成了硬门槛。出路只有两条，都需要一个决定：**拿到实机**，或者**收窄 `compatibility.platforms`**——即不再声称支持 macOS。本记录不替这个决定做选择，只指出「既声称又无证据」在新标准下不再是一种可以停留的状态；
- **`codex` 与 `hermes` 一条证据都没有。** 这不是遗漏：[ADR 0004](0004-m3-scope-and-evidence-path.md) 把 M3 首批定为 2 个 Agent（OpenCode 与 Claude Code），另两个从未进入过采集范围。它们今天能用、通过契约套件、现网生命周期验收过，**但「能用」与「测过它声称的范围」是两个标准**——与 [ADR 0020](0020-gateway-batch-closure.md) 对 Gateway 转默认所用的是同一句话。

另有一条不在机检范围内、但影响 `claude-code` 是否够格的事实：它**从未经 Gateway 实跑过**（[ADR 0020](0020-gateway-batch-closure.md) 的两条缺口之一）。那属于第 2 条的人判定部分。

## 6. 代价

- **这条标准让「达到 stable」变贵了**，而且是有意的。按它执行，M5 那条退出条件不可能靠改一个字段满足；
- **`compatibility.platforms` 从此是一个受检的断言**，不再是意向声明。这会逼出一批收窄，那正是「没测过的不得显示为支持」这条规矩在 Integration 这一层的落地；
- 机检只覆盖五条中的两条。剩下三条靠人，**因此它们各自被绑到一处可查的记录上**，而不是靠回忆。
