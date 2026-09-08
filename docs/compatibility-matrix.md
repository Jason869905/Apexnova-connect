# Compatibility Matrix

- Generated: 2026-09-08T18:32:21.801Z
- Test suite: `apexnova.capability-suite` 0.2.0
- Source: Apexnova-verified test runs. A provider claim is shown as claimed and never counted as verified.

Generated from the evidence store by `apexnova compatibility matrix`. Do not edit by hand.

Verdicts: `compatible` every required capability passed, `partial` a preferred capability fell short, `incompatible` a required capability failed, `unknown` something required has no live evidence. Expired evidence is still shown and does not support a verdict.

| Agent | Version | Deployment | Protocol | Platform | Verdict | Observed |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code | 2.1.261 | `deployment.apexnova.cmq4770nr0000edzis38w378a` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:11:45.955Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:12:39.299Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:09:47.774Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | anthropic-messages | linux-x64 | `partial` | 2026-09-08T18:15:42.328Z |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:10:48.262Z |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | openai-responses | linux-x64 | `partial` | 2026-09-08T17:55:06.990Z |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:09:23.615Z |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:15:25.565Z |

## Capabilities

| Agent | Deployment | Protocol | auth.endpoint-reachable | protocol.model-id-mapping | protocol.non-streaming | protocol.streaming-order | protocol.cancellation | protocol.error-semantics | agent.single-tool-call | agent.structured-output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | `deployment.apexnova.cmq4770nr0000edzis38w378a` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | `deployment.apexnova.cmq4770nr0000edzis38w378a` | openai-responses | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | openai-responses | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | openai-responses | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | openai-responses | yes | yes | yes | yes | yes | yes | yes | no |

## Evidence

- claude-code 2.1.261, `deployment.apexnova.cmq4770nr0000edzis38w378a`, anthropic-messages: `evidence.f68f807fdb7faf027d33cd7339a1913f`
- claude-code 2.1.261, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw`, anthropic-messages: `evidence.fae718937172a24770d387572c471294`
- claude-code 2.1.261, `deployment.apexnova.cmt0bub5d0042139w2xobpghn`, anthropic-messages: `evidence.cb067b4e5470daa0a44b758ee3dc899b`
- claude-code 2.1.261, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3`, anthropic-messages: `evidence.d71a7564ef6e71f7cdf3d3ab87356535`
- opencode 1.18.29, `deployment.apexnova.cmq4770nr0000edzis38w378a`, openai-responses: `evidence.3fa5e35537385cf736270de34394b1de`
- opencode 1.18.29, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw`, openai-responses: `evidence.f1e9a0dd5a089281d39c6d950402eeab`
- opencode 1.18.29, `deployment.apexnova.cmt0bub5d0042139w2xobpghn`, openai-responses: `evidence.552607de7fdf3203ead94a6c65f0ad99`
- opencode 1.18.29, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3`, openai-responses: `evidence.e7418db138ab60e11ee488a77a169037`

