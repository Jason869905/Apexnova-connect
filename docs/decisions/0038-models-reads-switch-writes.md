# 0038 `models` 只读，`switch` 换模型

- 状态：已接受
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0037](0037-one-key-many-models.md)「切换是加上并置顶」
- 结论：`models` 去掉交互选择器、只列目录并按 Hub 的模型顺序排；`switch` 不再是 `connect` 的别名，改成承载 ADR 0037 的那个切换，显式目标在终端上补一次确认；`connect` 保持原样，负责建立绑定并签发凭据

## 1. 问题：三个命令，两种行为，对不上

改动之前：

- `apexnova switch` 在 dispatch 里直接调 `executeConnect`，两者的 `COMMAND_OPTIONS` 逐字相同。整个代码库里它和 `connect` 的唯一区别，是错误信息和审计记录里印出来的那个词。而 `docs/cli-spec.md` 把它们写成两条命令、两段说明——文档在描述一个不存在的区别。
- 真正在换模型的是 `apexnova models`：TTY 下它会弹选择器，回车之后写配置、PATCH key 的授权范围、改默认模型。一个读形状的名字，默认路径上会写盘。

于是「换模型」有两种语义，取决于用户敲的是哪条命令：

| | `models` 的选择器 | `switch`（= `connect`） |
|---|---|---|
| 对已配置模型 | 加上并置顶，其余全留 | 单目标，替换绑定 |
| 凭据 | 复用永久 key，PATCH 扩范围 | 新签一枚 24h runtime credential |
| 确认 | 回车即生效 | 必须 `--dry-run` + `--yes` |

**这不是命名不好看，是同一个词指向两件后果不同的事。** ADR 0037 第 5 节讲「切换是加上并置顶」时说的是 `models`，第 6 节又说「`connect` / `switch` 是显式单目标命令」——同一篇记录里这个词已经在打架。`docs/opencode-usage-guide.md` 不得不专门写一句「`apexnova switch` 是另一回事」来消歧，那是命名在还债。

## 2. 按行为划分，不只是把选择器挪个地方

三个词各自对应一件事：

- **`models`** —— 看目录。只读。
- **`switch <agent>`** —— 换这个 Agent 打开时用的模型。不带目标就从列表里挑，`--deployment <id>` 或 `--best` 指定目标。语义就是 ADR 0037 第 5 节的「加上并置顶、key 不变、免费」。
- **`connect <agent>`** —— 建立绑定并签发凭据，保留 plan + `--dry-run` / `--yes` 那一套。

用户在 OpenCode 界面里换模型和在 Connect 里 `switch`，走的是同一个集合语义——这正是 ADR 0037 第 5 节要的对称性，之前被命名破坏了一半。

## 3. 确认的界线：都要确认，但不问两遍

每次切换都要有一次确认，区别只在那次确认长什么样：

- **从列表里挑的**：用户刚刚在选择器前面看着选完，**那次选择就是确认**，再问一遍是把同一个问题问两次；
- **显式目标**（`--deployment` / `--best`）：决定在命令运行之前就做完了，选择器没出现过，所以在终端上补一次 y/N（默认 N）。

补的这一次不是走个形式。`--deployment deployment.b` 这行字里没有任何东西说得出**切换之后还剩哪些模型**、**key 会不会被换掉**、**有没有模型会被移出配置**——而这三件正是 ADR 0037 花整篇在保证的东西。所以提问之前先把它们打出来：

```
Add Aux Reasoner (aux) as the default model for OpenCode?
  Deployment: deployment.b
  Protocol:   openai-responses
  Models after the switch: deployment.b, deployment.a
  Key key_1 is widened, not replaced.

? Apply this switch? (y/N)
```

`--yes` 是同一个问题的非交互答案，给了就不问。**不可交互又没给 `--yes` 时返回 `APPROVAL_REQUIRED`，不替用户答**——一个问不出口的终端不是一个默认同意的终端。

脚本里的 `switch --deployment <id> --yes` 因此一字未变，交互用户则多了一层看得见的确认。

## 4. `models` 的排序跟 Hub 的模型广场走

目录响应里有两个数组，只有一个带着用户**已经看过**的顺序：`models` 是模型广场那份列表，`deployments` 挂在它下面。

按 `deployments` 自己的数组顺序输出，等于给同一份目录造了第二种排法。用户刚在广场上看过一个顺序，`apexnova models` 给出另一个，两边都解释不了差异从哪来——这不是审美问题，是同一份数据的两个视图对不上。

所以排序按 deployment 所属 model 在 `models` 里的位置来，同一个 model 的多个 deployment 保持原有相对顺序（`Array.prototype.sort` 是稳定的）。`models` 里找不到对应条目的排在最后，**但不隐藏**：排不进去不等于不能用。

`switch` 的选择器、`run` 首次运行的多选框和 `models` 读的是同一个函数，所以三处顺序必然一致——不一致在结构上做不到。

## 5. `switch --dry-run` 必须说出写入之后的那一组

`connect` 的 `--dry-run` 只需要展示一个目标，因为它本来就替换。`switch` 会保留已配置的模型，所以**计划里列的模型集合必须就是写入产生的那一组**——否则 `--dry-run` 正好在它唯一要防的那件事上说谎。

为此把 `configureAgent` 里算「保留哪些、丢弃哪些」的那段抽成 `deploymentsAfterSwitch`，`--dry-run` 和真正的写入调用同一个函数。不是为了少写几行，是为了让「计划和结果不一致」在结构上不可能发生。

## 6. `switch` 不再接受 `--credential-ttl`

`--credential-ttl` 和 `--rotating` 的意思都是「签发一枚新凭据」，而这正是 `switch` 承诺不做的那件事。留着它会让一次 switch 悄悄变成一次 replace。它们属于 `connect` 和 `run`。

按 `COMMAND_OPTIONS` 一贯的做法，`switch --credential-ttl` 现在是一个响亮的用法错误，而不是一个被忽略的开关。

## 7. 破坏性，以及为什么现在改

`apexnova switch <agent> --deployment <id> --yes` 这个写法本身不变，退出码和 `--json` 信封的形状也不变；变的是它的后果：不再签发 24 小时 runtime credential、不再替换绑定，而是在已有的永久 key 上加模型并置顶。

**需要旧行为的人用 `connect`**——它一直就是那条路径，改动之后仍然是。

当前版本 `v0.6.1`，目标 `v1.0`。要改就在 1.0 之前，之后 `switch` 的语义就定死了。
