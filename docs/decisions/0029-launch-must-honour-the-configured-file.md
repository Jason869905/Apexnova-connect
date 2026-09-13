# 0029 启动必须落在刚写的那份配置上，否则拒绝启动

- 状态：已接受
- 日期：2026-09-13
- 阶段：M5 Reliable Provider Routing（目标版本 `v1.0`）
- 前置：[ADR 0020](0020-gateway-batch-closure.md) 第 3 节把「Claude Code 经 Gateway 的端到端实跑」列为转默认的条件 2，并标为「环境所限」
- 结论：条件 2 **达成**；过程中发现并修掉两个缺陷，其中一个是既有的

## 1. 「环境所限」这个理由不成立

从 [ADR 0019](0019-gateway-first-slice-review.md) 起，这条一直记着同一个理由：Claude Code 的配置就是本会话在用的文件，所以不能拿它做实验。

理由本身没错，结论错了——**`run` 接受 `--config`**，把配置写到隔离路径就完全避开了那份文件。没有人试过，因为那个理由听起来足够充分。

试了之后发现：`--config` 在启动这一步**根本不起作用**。

## 2. 两次运行，只差一个开关

| 命令 | 网关看到的请求 | Agent |
| --- | --- | --- |
| `run opencode --gateway --deployment …` | **1** | 退出 0 |
| `run opencode --config <隔离路径> --gateway --deployment …` | **0** | 退出 0，并且答出了内容 |

第二行是这条记录的全部要点：**Connect 把配置写到了隔离路径，启动的 OpenCode 读的是它自己的那份，请求一个都没经过我们，而命令报告成功。**

OpenCode 答得出内容，是因为它**自带 provider**——`opencode models` 列出的 `opencode/big-pickle` 等等，正是那次运行的会话名。于是用户以为自己跑在配置好的 Deployment 上，实际上跑在别人的模型上，**账也记在别人头上**。

代码层面的原因很短：两个 `planLaunch` 都没有读过 `context.configPath`。

这与本阶段反复出现的那类缺陷同形（[ADR 0019](0019-gateway-first-slice-review.md) 第 4 节），但更重一档：`--max-price`、`restore --yes`、`run --gateway` 那三次是**开关没起作用**；这一次是**开关起了一半作用**——配置真的写过去了，只有启动没跟上，所以连"什么都没发生"这个线索都没有。

## 3. 规则：指过去，或者拒绝启动

修法不是给 Claude Code 补一个参数就算完——那样只修掉被撞见的那一个。规则写进**公共契约套件**：

> 拿到显式配置路径时，Integration 要么把 Agent 指向那份文件，要么拒绝启动。**悄悄启动到另一份配置上不是第三个选项。**

四个 Agent 的能力不一样，如实处理：

| Agent | 机制 | 处理 |
| --- | --- | --- |
| Claude Code | `--settings <file>` | 指过去 |
| Codex | `$CODEX_HOME/config.toml` | 文件名是 `config.toml` 时设 `CODEX_HOME`，否则拒绝 |
| OpenCode | 无。实测 `OPENCODE_CONFIG` 在 1.18.29 上无效 | 拒绝 |
| Hermes | 无。实测 `HERMES_CONFIG` 在 0.21.0 上无效（`hermes config path` 不变） | 拒绝 |

拒绝用 `LAUNCH_CONFIG_UNREACHABLE`，消息说明配置已写到哪里、为什么指不过去、以及为什么宁可不启动。

**注意 `connect --config` 不受影响**：把配置写到指定位置本身是正当用法，不能启动的只是 `run`。

**契约套件那条旧断言，本身就是这个缺陷的书面形式。** 套件的 context 一直带着显式 `configPath`，而旧测试断言 `launch.args` 原样等于传入的参数——也就是要求计划**忽略**那个路径。它不是没抓到，它是把缺陷写成了契约。

## 4. 顺带撞出一个更老的缺陷

加了拒绝之后，第一次真实运行**挂死了**：进程不退出。

原因与 `--config` 无关：关闭网关和取回配置的代码只在**启动成功之后**执行。而 `launchAgent` 在 Agent 非零退出时会抛 `AGENT_EXITED`——所以**今天任何一次 Agent 非零退出的 `--gateway` 运行，都会让网关继续监听、进程永不退出，并在 Agent 配置里留下一个已经死掉的 loopback 地址**给下一次启动去踩。

这是既有缺陷，不是本次引入的；本次只是让它变得容易撞上。两条路径现在共用同一个释放函数，附变异验证的测试。

**它又一次说明了同一件事**：[ADR 0020](0020-gateway-batch-closure.md) 第 4 节记过「本批四个缺陷没有一个是既有测试发现的」。这个是第五个，发现方式是**我盯着一个不返回的终端**。

## 5. 条件 2 达成

`run claude-code --config <iso>/settings.json --gateway --deployment …cmq4770nr… -- -p "Reply with exactly OK"`：

- Agent 退出 0，答出 `OK`，`attributedRequests: 1`；
- 审计：`billed (run): confirmed via gateway, 1 request`，含 `POST /anthropic/v1/messages 200 in 5465ms`，带真实 requestId；
- **本会话的 `~/.claude/settings.json` 全程未被触碰**（mtime 仍是 09-11，内容不含 loopback）。

这条能成立，恰恰依赖第 3 节的修复——没有 `--settings`，隔离配置就是一句空话。

## 6. 另两条的状态

- **条件 1（凭据跨过到期的实跑）**：仍未达成，且**它今天无法达成**。运行时凭据的 TTL 固定 24 小时（`RUNTIME_CREDENTIAL_TTL_SECONDS`），没有任何参数可调，所以这条路径只能靠**等一整天**来验证。这不是耐心问题，是可测试性问题：一条只能靠等 23 小时才能走到的代码，实际上没有人会去验证它。合理的下一步是让 TTL 可配置——它本身也有独立理由（一次十分钟的运行不需要一枚 24 小时凭据），并顺带让这条变得可验证；
- **条件 3（真实长交互会话）**：仍未达成，且**不是我能做的**。它要的是人类回合、长空闲与数小时时长，自动任务的近似已经做过（[ADR 0019](0019-gateway-first-slice-review.md) 第 5 节）并明确写过那不算数。

**因此 Gateway 仍不设为默认。** 三条里达成一条。
