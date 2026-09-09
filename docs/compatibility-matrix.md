# Compatibility Matrix

- Generated: 2026-09-09T17:11:12.727Z
- Test suite: `apexnova.capability-suite` 0.3.0
- Source: Apexnova-verified test runs. A provider claim is shown as claimed and never counted as verified.

Generated from the evidence store by `apexnova compatibility matrix`. Do not edit by hand.

Verdicts: `compatible` every required capability passed, `partial` a preferred capability fell short, `incompatible` a required capability failed, `unknown` something required has no live evidence. Expired evidence is still shown and does not support a verdict.

| Agent | Version | Deployment | Protocol | Platform | Verdict | Observed |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code | 2.1.261 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-09T15:28:19.961Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmq4770nr0000edzis38w378a` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:11:45.955Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-09T15:26:37.713Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:12:39.299Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-09T15:28:43.568Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:09:47.774Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | anthropic-messages | linux-x64 | `partial` | 2026-09-09T15:29:03.840Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | anthropic-messages | linux-x64 | `partial` | 2026-09-08T18:15:42.328Z |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | linux-x64 | `partial` | 2026-09-09T15:24:29.117Z |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:10:48.262Z |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-responses | linux-x64 | `partial` | 2026-09-09T15:10:57.776Z |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | openai-responses | linux-x64 | `partial` | 2026-09-08T17:55:06.990Z |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-responses | linux-x64 | `partial` | 2026-09-09T15:24:51.626Z |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:09:23.615Z |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-responses | linux-x64 | `partial` | 2026-09-09T17:10:15.630Z |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:39:20.314Z |

## Capabilities

| Agent | Deployment | Protocol | auth.endpoint-reachable | protocol.model-id-mapping | protocol.non-streaming | protocol.streaming-order | protocol.cancellation | protocol.error-semantics | agent.single-tool-call | agent.forced-tool-choice | agent.structured-output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | `deployment.apexnova.cmq4770nr0000edzis38w378a` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | no |
| claude-code | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmq4770nr0000edzis38w378a` | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-responses | yes | yes | yes | yes | yes | yes | yes | no | no |
| opencode | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |

## Evidence

- claude-code 2.1.261, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), anthropic-messages: `ev.sha256.a138f5b3421a70eeb4abcb4138752d85e941c611ff59ba9cfdd7257b2d6c65ee`
- claude-code 2.1.261, `deployment.apexnova.cmq4770nr0000edzis38w378a`, anthropic-messages: `evidence.f68f807fdb7faf027d33cd7339a1913f`
- claude-code 2.1.261, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), anthropic-messages: `ev.sha256.6ccc29b2d45a63546a0ff8ba317b4c89df3cbf773384a6f41f1bbe8136a14076`
- claude-code 2.1.261, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw`, anthropic-messages: `evidence.fae718937172a24770d387572c471294`
- claude-code 2.1.261, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), anthropic-messages: `ev.sha256.e9cfb344afcb5b335cdd8b2122ec73358656f70f2bfa9fa6cb1a6364b2c4dd8b`
- claude-code 2.1.261, `deployment.apexnova.cmt0bub5d0042139w2xobpghn`, anthropic-messages: `evidence.cb067b4e5470daa0a44b758ee3dc899b`
- claude-code 2.1.261, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), anthropic-messages: `ev.sha256.7c894728cd05b87081e2c9d625b28ae0ea00408568c72327424f36d2255d31c1`
- claude-code 2.1.261, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3`, anthropic-messages: `evidence.d71a7564ef6e71f7cdf3d3ab87356535`
- opencode 1.18.29, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), openai-responses: `ev.sha256.a41ff679e046055ef03f150f741c49620950220fa322e070cd632950e0a1802c`
- opencode 1.18.29, `deployment.apexnova.cmq4770nr0000edzis38w378a`, openai-responses: `evidence.3fa5e35537385cf736270de34394b1de`
- opencode 1.18.29, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), openai-responses: `ev.sha256.53d5a8f709098f9679f547de5dee93f760cdef7bb89d759e693a03f742d954fa`
- opencode 1.18.29, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw`, openai-responses: `evidence.f1e9a0dd5a089281d39c6d950402eeab`
- opencode 1.18.29, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), openai-responses: `ev.sha256.b0de3407869ec7c901562487faa38a40ca1ea948eabcfe98f27a470cc402b3cb`
- opencode 1.18.29, `deployment.apexnova.cmt0bub5d0042139w2xobpghn`, openai-responses: `evidence.552607de7fdf3203ead94a6c65f0ad99`
- opencode 1.18.29, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), openai-responses: `ev.sha256.8ae3df111d7c61b696acd3bfd701183f81fd9b66932c78087b945131dd9dfe0c`
- opencode 1.18.29, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3`, openai-responses: `evidence.9edde81e07637920b6ce5d709afadc17`

