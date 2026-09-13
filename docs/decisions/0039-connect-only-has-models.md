# 0039 Connect 只有 Model，没有 Deployment

- 状态：已接受
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0038](0038-models-reads-switch-writes.md)、[Domain Model](../domain-model.md)
- 结论：Connect 的领域里没有 Deployment。目录、CLI、配置、绑定、审计、推荐、文档一律只说 Model；选择模型的参数一律是 `--model`；`--deployment` 报错并指向 `--model`

## 1. 问题：一个用户看不见的维度，占着一个到处出现的词

Domain Model 原本把这件事拆成两层：`ModelProfile` 描述抽象模型版本，`ModelDeployment` 描述「某个 Provider 在特定区域和协议入口提供的可调用线路」，并规定「同一个模型由不同 Provider、不同区域或不同协议入口提供时，必须是不同 Deployment」。

**这一层对用户不存在。** 用户看不到 Hub 内部的部署，他知道的只有「我在用哪个模型」。

在 Hub 这个 Provider 上，这个维度本身也是空的。对着现网逐条核：

| 理论上区分 Deployment 的字段 | 实际 |
| --- | --- |
| `providerId` | 46 个条目**全是** `provider.apexnova-ai-hub` |
| `region` | `HubCatalogDeployment` 里根本没有这个字段 |
| 与 Model 的基数 | 一一对应，ID 直接内嵌 model 后缀 |
| `protocols` | 唯一真正带信息的一项，而它是模型自己的属性 |

而这个词在代码里出现约 1800 次、92 个文件，在文档里 582 次。**一个不承载信息的维度，占着整个代码库里最高频的名词之一。**

## 2. 多区域是 Provider 的事，由多个 Model 表达

同一份权重在多个区域提供时，**由 Provider 侧作为多个 Model 发布**——`glm-5.2-ap` 和 `glm-5.2-eu`，两个 ID、两个别名、各自的价格和可用性。

选哪一个和在任意两个模型之间做选择没有区别，是用户的事，不是 Connect 要替他抽象掉的事。「一个模型背后用了哪几条上游线路」同样是 Provider 的事：托管线路切换不改变公共 Model 身份。

排序同理：**只按模型自身的属性排**（目录顺序、价格、上下文窗口、能力证据），不引入部署维度。

## 3. 目录在适配层合并，一对多则报错

Hub 的目录响应是两个数组：`models[]` 带 publisher 和 modelType，`deployments[]` 带那个真正被授权、被路由、被计费的 ID，外加别名、协议、价格和可用性。

`packages/hub-client` 把它们**合并成一个 `HubCatalogModel`**，`id` 取可调用条目的那个——因为那是 Hub 记账的主体。这是唯一需要知道 Hub 线格式的一层。

两个方向不对称，因为后果不对称：

- **一个 model 挂两个可调用条目 → 报错**。这是 Connect 无法呈现的形状，替用户挑一个等于把这个维度悄悄放回来，而用户会被计费在一条没人选过的线路上。
- **一个可调用条目没有对应的 model 行 → 保留**，排在有序条目之后，缺的字段就缺着。它存在、可调用、会计费；因为目录有缺陷就把它藏起来，是 [ADR 0037 §5](0037-one-key-many-models.md) 拒绝的那种静默消失。

顺序取 `models[]` 的顺序，也就是模型广场那一份（[ADR 0038 §4](0038-models-reads-switch-writes.md)）。合并之后 Connect 只剩一个数组，没有第二种排法可造。

## 4. 不做兼容层

`--deployment` 直接消失，落到 `UNKNOWN_OPTION`。**不保留别名，不打提示，不做「已改名为 --model」的引导**——保留任何一种都会让这个词继续活在 CLI 表面上，而这正是本记录要消除的东西。

`--model` 本来就接受 ID 和别名（`selectModelByReference` 先按 ID 精确匹配，再按 `inferenceAlias` 和 `aliases`，歧义报 `MODEL_AMBIGUOUS`），所以改的只是那个词。

## 5. 落盘与对外输出一起改，同样不做迁移

**没有版本号跟着这次改名动**：Deployment 当作没存在过，所以磁盘上的形状就是「一直叫 `modelId`」，没有第二种拼法要读。

| 位置 | 处理 |
| --- | --- |
| 绑定存储 | 仍是 v5，字段 `modelId`。**改名前存的绑定读不出来**，报 `SESSION_CORRUPT` |
| 路由审计 | 仍是 schemaVersion `0.1`，字段 `modelId`。旧行校验不过，被 `list` 跳过 |
| Recommendation | 仍是 schemaVersion `0.2`，字段 `modelId` |
| Recording | 仍是 version `1`，字段 `modelId`。仓内 fixture 已就地改写 |
| CLI `--json` 信封 | `deploymentId` → `modelId`，`deploymentIds` → `modelIds` |
| 错误码 | `DEPLOYMENT_REQUIRED` / `NOT_FOUND` / `UNAVAILABLE` / `AMBIGUOUS` → `MODEL_*` |
| 领域 Schema | `model-profile` + `model-deployment` 合并为 `model.schema.json` |
| Integration SDK | `ConnectionIntent.deploymentId` → `modelId`，`ConnectionModel.deploymentId` → `modelId` |

**代价明说**：升级之后第一次运行，已有 profile 的绑定读不出来，需要重新 `apexnova run` 或 `apexnova connect`；改名前写的审计行会从 `apexnova audit` 的输出里消失。这是 pre-1.0 换干净一套语言的价格，写进发布说明。

## 6. 两处保留 `deployment`，都是别人的线格式（不是兼容层）

**不是 Connect 的词，是别人的契约穿过边界**，各自在代码里带着说明：

**(a) Hub 的线字段。** `/catalog` 的 `deployments[]`、创建 key 的 `publicDeploymentIds`、响应头 `x-apexnova-deployment-id`、估价请求体的 `deploymentId`。只出现在 `packages/hub-client`，在边界上翻译。

**(b) Compatibility Evidence 的 `subject.deploymentId`。** 这条要展开说，因为它是唯一一处**想改也不能改**的。

evidence 记录的 ID 是它 canonical JSON 的 sha256，而这条规则**与 Hub 双向钉死**：`schemas/fixtures/evidence-canonical-vectors.json` 两边各存一份，Hub 会重算这个哈希来做不可变性校验。`packages/capabilities/tests/canonical-vectors.test.ts` 里那句写得很清楚：

> 改这里的值意味着哈希规则变了，会让每一个已存的 ID 失效——把失败当成一个契约问题，不是一个待更新的快照。

改键名的后果：每条内容相同的记录换一个新 ID，而 Hub 对同一份记录算出来的又是另一个，提交会被拒。

所以它保持 Hub 的拼法，在类型和 Schema 上都写明**它装的就是 model id**。要真正改掉需要 Hub 侧协同改哈希规则并重新钉 vector，那是一次跨系统迁移，不在本记录范围内。

## 7. 破坏性

- `--deployment` 不再是一个选项；
- `--json` 信封的 `deploymentId` / `deploymentIds` 改名为 `modelId` / `modelIds`；
- `DEPLOYMENT_*` 错误码改名为 `MODEL_*`；
- Integration SDK 的 `ConnectionIntent` / `ConnectionModel` 字段改名（仓内四个 integration 已同步，仓外适配器需要跟改）；
- **已有的绑定和审计行读不出来**（见第 5 节）。

当前版本 `v0.6.1`，目标 `v1.0`。要统一语言就在 1.0 之前，而且趁没有兼容包袱的时候一次改净。
