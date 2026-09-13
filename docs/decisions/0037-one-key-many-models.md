# 0037 一枚永久 key 覆盖一组模型，换模型不换 key

- 状态：已接受
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：`run` 默认签发永久 user API Key（[Hub 需求 §10A](../apexnova-ai-hub-requirements.md)）；OpenCode 的 provider 段本来就写 `models` 映射，只是一直只写一项
- 结论：`run` 一次可选多个模型，写进同一个 provider、由同一枚 key 授权；`models` 的切换改为「加上并置顶」；已有的永久 key 用 `PATCH` 扩大授权范围，不另发

## 1. 问题：Connect 把 Agent 的模型选择器废掉了

OpenCode 自己有模型选择器。它能切换的，是配置里 `provider.apexnova.models` 列出的那些。

Connect 一直只往里写一项——`ConnectionIntent` 只描述一个 deployment，适配器把它包成一个单元素数组。于是：

- 用户在 OpenCode 里打开模型选择器，只看得到一个模型；
- 想换一个，得退出 OpenCode，回到 Connect 跑 `apexnova models`，**换来一枚新 key**、一次配置改写、一次重启；
- 换完之后原来那个模型又从选择器里消失了。

**这不是「少了个功能」，是把目标产品已经做好的那部分能力挡在了外面。** 一个 Agent 的模型选择器是它的核心交互之一，而 Connect 配置出来的 Agent 里它只有一个选项。

## 2. key 本来就能覆盖一组模型

`publicDeploymentIds` 从一开始就是数组（[§10A](../apexnova-ai-hub-requirements.md)：非空时每次推理校验请求模型是否在允许集，不在则 fail closed）。Connect 一直只往里放一个元素。

所以这条改动**不需要 Hub 做任何事**：创建时把勾中的全部 deployment 一起传进去，这枚 key 就能服务这一组模型。fail-closed 的语义不变，变的只是允许集不再恒等于一。

**允许集必须恰好等于配置里列出的模型集合**，两边不一致是唯一会伤人的状态：

- key 覆盖得比配置多 → 用户看不到、也用不上那些模型，但它们的授权还挂在这枚 key 上；
- 配置列得比 key 多 → 用户在 OpenCode 里选中它、发出第一个请求、被 fail closed 拒绝——**而这个失败发生在 Connect 早就退出以后**，错误信息里没有任何东西指回这里。

后一种是真正的危险，所以绑定里存的是这一组（存储格式 v5 的 `deploymentIds`），写配置和发 key 读的是同一个来源。

## 3. 一组模型必须共用一个 endpoint

一个 provider 段只有一个 `npm` 包和一个 `baseURL`。协议相同还不够：目录给每个 deployment **各自的** URL，两个都声称 `openai-responses` 但地址不同的模型，写进同一个 provider 会把其中一半发到不服务它们的地址上。

判定因此是「同协议**且**同 baseUrl」，做不到就报 `PROTOCOL_NOT_SHARED` 并列出分歧的 deployment。

**不悄悄丢掉那个不合群的**：用户勾中了它，而丢弃的结果是他在 OpenCode 的选择器里找不到自己刚刚选过的模型——一个没人会想到要来这里查的现象。

## 4. 「key 不变」是一句必须兑现的承诺

永久 key 的卖点是它不过期、不轮换、不需要续期。用户据此可以在别处引用它、在 Hub 的用量页面上按它读账。

那么**加一个模型就不能换一枚 key**。已有本 profile 的永久 key 且协议一致时：

```
PATCH /v1/api-keys/{id}  { publicDeploymentIds: 并集 }
```

Hub 的 PATCH 是整体替换，所以发的是并集而不是增量。返回的 summary 会被读回校验：没有真的放宽就报 `VERIFICATION_FAILED`——**没放宽意味着用户选中的模型第一次调用就会被拒**，而那时已经没人在看这里了。

唯一会重新签发的情况是 key 已被服务端撤销（`NOT_FOUND`）：没有东西可以扩大了。

### 一条随之而来的修复

`configureAgent` 原先在写配置失败时无条件撤销「刚拿到的」凭据。复用已有 key 之后，这条会在一次失败的换模型里**撤掉这个 profile 赖以运行的那枚永久 key**。现在只撤销本次调用真正签发的凭据。

## 5. 切换是「加上并置顶」，不是「换掉」

`apexnova models` 选中一个模型后：

- 不在配置里 → 加进去，并成为默认；
- 已经在 → 只把默认指向它；
- 其余已配置的模型 → 全部保留。

理由是第 1 节那个场景的对称面：如果 Connect 里的切换会把别的模型踢出去，那么用户每次用 Connect 换模型，都会把自己在 OpenCode 里的选择器重新砍回一项。**两条路径必须指向同一个集合**，否则用哪条路换模型会变成一件需要记住的事。

目录里已经消失、或不再在同一 endpoint 上提供的旧模型是例外：没有任何东西可以用来描述它了，它被移出配置并给出**点名的**警告。

**没有做「取消勾选」**：目前只能加。删一个模型要回答的问题——key 的范围是否跟着收窄、用量归属怎么办——和这条改动要解决的问题无关，留到有人真的需要时再谈。

## 6. 哪些路径不适用

模型集合只在**凭据本身活过这次改动**的路径上累积，也就是默认的永久 key。其余三条都签发新凭据、各自有替换或回滚语义，集合就是这次命令选中的那些：

- `connect` / `switch`：显式的单目标命令，`--dry-run` 里已经把要配的那一个给用户看过了；
- `--rotating` / `--credential-ttl`：凭据本来就在轮换；
- `--gateway`：运行结束会把自己的写入取回（[ADR 0029](0029-launch-must-honour-the-configured-file.md) 第 4 节）。

**`--gateway` 遗留一个已知缺口**：它对一个持有永久 key 的 profile 运行时，仍会按旧规则替换绑定并撤销那枚永久 key，而结束时的 `restore` 放回去的是一枚 24 小时的 runtime credential。这不是本记录引入的，但「key 到 logout 为止不变」现在是一句明说的承诺，所以它从一个不起眼的行为变成了一条需要单独处理的缺口，记在这里。
