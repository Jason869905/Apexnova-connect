# Compatibility Matrix

- Generated: 2026-09-09T17:58:57.178Z
- Test suite: `apexnova.capability-suite` 0.3.0
- Source: Apexnova-verified test runs. A provider claim is shown as claimed and never counted as verified.

Generated from the evidence store by `apexnova compatibility matrix`. Do not edit by hand.

Verdicts: `compatible` every required capability passed, `partial` a preferred capability fell short, `incompatible` a required capability failed, `unknown` something required has no live evidence. Expired evidence is still shown and does not support a verdict.

| Agent | Version | Deployment | Protocol | Platform | Verdict | Observed |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code | 2.1.261 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-09T17:58:05.935Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmq4770nr0000edzis38w378a` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:11:45.955Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-09T17:57:14.125Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:12:39.299Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-09T17:58:20.711Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:09:47.774Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | anthropic-messages | linux-x64 | `partial` | 2026-09-09T17:58:30.557Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | anthropic-messages | linux-x64 | `partial` | 2026-09-08T18:15:42.328Z |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | linux-x64 | `partial` | 2026-09-09T17:56:06.863Z |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:10:48.262Z |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-responses | linux-x64 | `partial` | 2026-09-09T17:54:59.844Z |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | openai-responses | linux-x64 | `partial` | 2026-09-08T17:55:06.990Z |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-responses | linux-x64 | `partial` | 2026-09-09T17:56:20.769Z |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:09:23.615Z |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-responses | linux-x64 | `partial` | 2026-09-09T17:10:15.630Z |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:39:20.314Z |

## Capabilities

| Agent | Deployment | Protocol | auth.endpoint-reachable | protocol.model-id-mapping | protocol.non-streaming | protocol.streaming-order | protocol.cancellation | protocol.error-semantics | agent.single-tool-call | agent.forced-tool-choice | agent.structured-output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | `deployment.apexnova.cmq4770nr0000edzis38w378a` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | no | no |
| claude-code | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | anthropic-messages | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | `deployment.apexnova.cmq4770nr0000edzis38w378a` | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-responses | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-responses | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-responses | yes | yes | yes | yes | yes | yes | yes | no | no |
| opencode | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | openai-responses | yes | yes | yes | yes | yes | yes | yes | untested | no |

## Evidence

- claude-code 2.1.261, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), anthropic-messages: `ev.sha256.ea0e0863e65dcab3f4cb08e7c21935f4914237a4a8547374c6b203c46b27c794`
- claude-code 2.1.261, `deployment.apexnova.cmq4770nr0000edzis38w378a`, anthropic-messages: `evidence.f68f807fdb7faf027d33cd7339a1913f`
- claude-code 2.1.261, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), anthropic-messages: `ev.sha256.3641778e9de388aedb1f1e58e03fe2d280a6da11a6e5ea2c0c70858ae01856be`
- claude-code 2.1.261, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw`, anthropic-messages: `evidence.fae718937172a24770d387572c471294`
- claude-code 2.1.261, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), anthropic-messages: `ev.sha256.b14be07c2082b6fb9128d6b8e850476299bbec5a91c9ce474f7d9f702457296d`
- claude-code 2.1.261, `deployment.apexnova.cmt0bub5d0042139w2xobpghn`, anthropic-messages: `evidence.cb067b4e5470daa0a44b758ee3dc899b`
- claude-code 2.1.261, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), anthropic-messages: `ev.sha256.0334c12be4a6133a5a8c3ce72b9b85534f5b7917d96f3726d7fe2a44036ea6ce`
- claude-code 2.1.261, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3`, anthropic-messages: `evidence.d71a7564ef6e71f7cdf3d3ab87356535`
- opencode 1.18.29, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), openai-responses: `ev.sha256.f61ff31afd83aa75c091936cf295f73fee481f9a5e0b5bfe6c34367b64831634`
- opencode 1.18.29, `deployment.apexnova.cmq4770nr0000edzis38w378a`, openai-responses: `evidence.3fa5e35537385cf736270de34394b1de`
- opencode 1.18.29, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), openai-responses: `ev.sha256.b18944091629b166f7aeb6ceb15a675dacba2f907b99e0beea95f3cb2de012f3`
- opencode 1.18.29, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw`, openai-responses: `evidence.f1e9a0dd5a089281d39c6d950402eeab`
- opencode 1.18.29, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), openai-responses: `ev.sha256.662a03dadb7604a7f003d8982803c50df66bfa4e3a9bb5fd29233cb5f2f5d0fa`
- opencode 1.18.29, `deployment.apexnova.cmt0bub5d0042139w2xobpghn`, openai-responses: `evidence.552607de7fdf3203ead94a6c65f0ad99`
- opencode 1.18.29, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), openai-responses: `ev.sha256.8ae3df111d7c61b696acd3bfd701183f81fd9b66932c78087b945131dd9dfe0c`
- opencode 1.18.29, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3`, openai-responses: `evidence.9edde81e07637920b6ce5d709afadc17`

