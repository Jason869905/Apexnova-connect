# Compatibility Matrix

- Generated: 2026-09-13T12:32:55.816Z
- Test suite: `apexnova.capability-suite` 0.4.0
- Source: Apexnova-verified test runs. A provider claim is shown as claimed and never counted as verified.

Generated from the evidence store by `apexnova compatibility matrix`. Do not edit by hand.

Verdicts: `compatible` every required capability passed, `partial` a preferred capability fell short, `incompatible` a required capability failed, `unknown` something required has no live evidence. Expired evidence is still shown and does not support a verdict.

| Agent | Version | Deployment | Protocol | Platform | Verdict | Observed |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code | 2.1.261 | `deployment.apexnova.cmq4770nr0000edzis38w378a` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:11:45.955Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-09T17:58:05.935Z |
| claude-code | 2.1.233 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | anthropic-messages | windows-x64 | `compatible` | 2026-09-09T20:37:17.851Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:12:39.299Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-09T17:57:14.125Z |
| claude-code | 2.1.233 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | anthropic-messages | windows-x64 | `compatible` | 2026-09-09T20:36:22.914Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | anthropic-messages | linux-x64 | `compatible` | 2026-09-08T18:09:47.774Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-09T17:58:20.711Z |
| claude-code | 2.1.233 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | anthropic-messages | windows-x64 | `compatible` | 2026-09-09T20:37:38.826Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | anthropic-messages | linux-x64 | `partial` | 2026-09-08T18:15:42.328Z |
| claude-code | 2.1.261 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | anthropic-messages | linux-x64 | `partial` | 2026-09-09T17:58:30.557Z |
| claude-code | 2.1.233 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | anthropic-messages | windows-x64 | `partial` | 2026-09-09T20:37:56.731Z |
| codex | 0.153.4 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | linux-x64 | `partial` | 2026-09-13T08:34:57.173Z |
| codex | 0.147.0 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | windows-x64 | `partial` | 2026-09-13T12:32:18.420Z |
| codex | 0.153.4 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-responses | linux-x64 | `partial` | 2026-09-13T08:35:57.608Z |
| codex | 0.153.4 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-responses | linux-x64 | `partial` | 2026-09-13T08:36:11.047Z |
| codex | 0.153.4 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-responses | linux-x64 | `partial` | 2026-09-13T08:36:50.440Z |
| hermes | 0.21.0 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-12T12:22:12.646Z |
| hermes | 0.21.0 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-chat | linux-x64 | `partial` | 2026-09-12T12:39:30.202Z |
| hermes | 0.21.0 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-12T12:23:13.654Z |
| hermes | 0.21.0 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-chat | linux-x64 | `partial` | 2026-09-12T12:40:23.550Z |
| hermes | 0.21.0 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | anthropic-messages | linux-x64 | `compatible` | 2026-09-12T12:23:29.156Z |
| hermes | 0.21.0 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-chat | linux-x64 | `compatible` | 2026-09-12T12:40:37.066Z |
| hermes | 0.21.0 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | anthropic-messages | linux-x64 | `partial` | 2026-09-12T12:23:38.872Z |
| hermes | 0.21.0 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-chat | linux-x64 | `partial` | 2026-09-12T12:41:02.879Z |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-chat | linux-x64 | `partial` | 2026-09-13T08:32:25.376Z |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-chat | windows-x64 | `partial` | 2026-09-13T12:31:14.845Z |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:10:48.262Z |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | linux-x64 | `partial` | 2026-09-09T17:56:06.863Z |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | windows-x64 | `partial` | 2026-09-09T20:34:54.153Z |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-chat | linux-x64 | `partial` | 2026-09-13T08:33:24.251Z |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | openai-responses | linux-x64 | `partial` | 2026-09-08T17:55:06.990Z |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-responses | linux-x64 | `partial` | 2026-09-09T17:54:59.844Z |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-responses | windows-x64 | `partial` | 2026-09-09T20:33:54.056Z |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-chat | linux-x64 | `compatible` | 2026-09-13T08:33:39.575Z |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:09:23.615Z |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-responses | linux-x64 | `partial` | 2026-09-09T17:56:20.769Z |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-responses | windows-x64 | `partial` | 2026-09-09T20:35:13.891Z |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-chat | linux-x64 | `partial` | 2026-09-13T08:33:57.936Z |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | openai-responses | linux-x64 | `partial` | 2026-09-08T18:39:20.314Z |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-responses | linux-x64 | `partial` | 2026-09-09T17:10:15.630Z |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-responses | windows-x64 | `partial` | 2026-09-09T20:35:32.513Z |

## Capabilities

| Agent | Version | Deployment | Protocol | Platform | auth.endpoint-reachable | protocol.model-id-mapping | protocol.non-streaming | protocol.streaming-order | protocol.cancellation | protocol.error-semantics | agent.single-tool-call | agent.forced-tool-choice | agent.structured-output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | 2.1.261 | `deployment.apexnova.cmq4770nr0000edzis38w378a` | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | 2.1.261 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | 2.1.233 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | anthropic-messages | windows-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | 2.1.261 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | 2.1.261 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | 2.1.233 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | anthropic-messages | windows-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | 2.1.261 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | untested | yes |
| claude-code | 2.1.261 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | 2.1.233 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | anthropic-messages | windows-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| claude-code | 2.1.261 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | untested | no |
| claude-code | 2.1.261 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | no | no |
| claude-code | 2.1.233 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | anthropic-messages | windows-x64 | yes | yes | yes | yes | yes | yes | yes | no | no |
| codex | 0.153.4 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| codex | 0.147.0 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | windows-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| codex | 0.153.4 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| codex | 0.153.4 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| codex | 0.153.4 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | no | no |
| hermes | 0.21.0 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| hermes | 0.21.0 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-chat | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| hermes | 0.21.0 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| hermes | 0.21.0 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-chat | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| hermes | 0.21.0 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| hermes | 0.21.0 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-chat | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| hermes | 0.21.0 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | anthropic-messages | linux-x64 | yes | yes | yes | yes | yes | yes | yes | no | no |
| hermes | 0.21.0 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-chat | linux-x64 | yes | yes | yes | yes | yes | yes | yes | no | yes |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-chat | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-chat | windows-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | 1.18.29 | `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`) | openai-responses | windows-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-chat | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | 1.18.29 | `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`) | openai-responses | windows-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-chat | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | 1.18.29 | `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`) | openai-responses | windows-x64 | yes | yes | yes | yes | yes | yes | yes | yes | no |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-chat | linux-x64 | yes | yes | yes | yes | yes | yes | yes | no | yes |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | untested | no |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-responses | linux-x64 | yes | yes | yes | yes | yes | yes | yes | no | no |
| opencode | 1.18.29 | `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`) | openai-responses | windows-x64 | yes | yes | yes | yes | yes | yes | yes | no | no |

## Evidence

- claude-code 2.1.261, `deployment.apexnova.cmq4770nr0000edzis38w378a`, anthropic-messages, linux-x64, integration claude-code 0.1.0: `evidence.f68f807fdb7faf027d33cd7339a1913f`
- claude-code 2.1.261, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), anthropic-messages, linux-x64, integration claude-code 0.1.0: `ev.sha256.ea0e0863e65dcab3f4cb08e7c21935f4914237a4a8547374c6b203c46b27c794`
- claude-code 2.1.233, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), anthropic-messages, windows-x64, integration claude-code 0.1.0: `ev.sha256.bf71b51eb69ff96fa8fdc7a599866c26f267814e5ea212fb88e23b9763a262c2`
- claude-code 2.1.261, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw`, anthropic-messages, linux-x64, integration claude-code 0.1.0: `evidence.fae718937172a24770d387572c471294`
- claude-code 2.1.261, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), anthropic-messages, linux-x64, integration claude-code 0.1.0: `ev.sha256.3641778e9de388aedb1f1e58e03fe2d280a6da11a6e5ea2c0c70858ae01856be`
- claude-code 2.1.233, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), anthropic-messages, windows-x64, integration claude-code 0.1.0: `ev.sha256.368d40a8c75ad59fbeff0eb99752533624daede759727be1f96c49d307f80008`
- claude-code 2.1.261, `deployment.apexnova.cmt0bub5d0042139w2xobpghn`, anthropic-messages, linux-x64, integration claude-code 0.1.0: `evidence.cb067b4e5470daa0a44b758ee3dc899b`
- claude-code 2.1.261, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), anthropic-messages, linux-x64, integration claude-code 0.1.0: `ev.sha256.b14be07c2082b6fb9128d6b8e850476299bbec5a91c9ce474f7d9f702457296d`
- claude-code 2.1.233, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), anthropic-messages, windows-x64, integration claude-code 0.1.0: `ev.sha256.e6db5515864d62b9e2c10f29d452e1990593061a245447a9903a84daabbfe153`
- claude-code 2.1.261, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3`, anthropic-messages, linux-x64, integration claude-code 0.1.0: `evidence.d71a7564ef6e71f7cdf3d3ab87356535`
- claude-code 2.1.261, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), anthropic-messages, linux-x64, integration claude-code 0.1.0: `ev.sha256.0334c12be4a6133a5a8c3ce72b9b85534f5b7917d96f3726d7fe2a44036ea6ce`
- claude-code 2.1.233, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), anthropic-messages, windows-x64, integration claude-code 0.1.0: `ev.sha256.544f46d44c864724966afff05265d1765770d34e48e8c909c1bb5b5e9f9f7164`
- codex 0.153.4, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), openai-responses, linux-x64, integration codex 0.1.0: `ev.sha256.8eb174c0c45b3e5abc1de0a0cef3196c97b07100b29a64337cf11a4cf20577be`
- codex 0.147.0, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), openai-responses, windows-x64, integration codex 0.1.0: `ev.sha256.f303cac45c593f744d79e7ef189055dc0d279c756013e4cb5c25bbfe5c204f65`
- codex 0.153.4, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), openai-responses, linux-x64, integration codex 0.1.0: `ev.sha256.682cc5f7c350905cf31e0a45fc7831a52e996d04bc05e43d6453cc1639bcc720`
- codex 0.153.4, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), openai-responses, linux-x64, integration codex 0.1.0: `ev.sha256.70f4bbd4c65392cc17a3952435be098aca727a83b3fc12651a232345032ff6c9`
- codex 0.153.4, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), openai-responses, linux-x64, integration codex 0.1.0: `ev.sha256.41e502cff1349ac6f39157380f824190001a576111e312e5c6d3331457e90ffe`
- hermes 0.21.0, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), anthropic-messages, linux-x64, integration hermes 0.1.0: `ev.sha256.37d21c9dfdf6f11b6f9125963e7e5ffd7465510d17d69306fcbb1a1d0b830ed0`
- hermes 0.21.0, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), openai-chat, linux-x64, integration hermes 0.1.0: `ev.sha256.746c7480e38a02ac96580ddf24d420e249b2bbd1568c606dfd8e72436d048a7c`
- hermes 0.21.0, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), anthropic-messages, linux-x64, integration hermes 0.1.0: `ev.sha256.f46e5def1cb28ded71ae1aebcbceab2d2c85c8514c00fb0a20a1ddbfaf517028`
- hermes 0.21.0, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), openai-chat, linux-x64, integration hermes 0.1.0: `ev.sha256.4b25bf707554bd2ac00e6e15efcf9dac185afcd922a8dd6a91c1ba150ceaccc6`
- hermes 0.21.0, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), anthropic-messages, linux-x64, integration hermes 0.1.0: `ev.sha256.ecc84235a2f5272fe87f2719f336b65096c971fa7e37cf748ba4482d8cdcabcf`
- hermes 0.21.0, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), openai-chat, linux-x64, integration hermes 0.1.0: `ev.sha256.349a7873a0b6a3219785f9c4b4b8d95410be66c0bc69af2045f183f709dc463e`
- hermes 0.21.0, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), anthropic-messages, linux-x64, integration hermes 0.1.0: `ev.sha256.6c11c42aa69fb50c5ff1f375525edd508b7a72663d75d7317499e22bbb617cdc`
- hermes 0.21.0, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), openai-chat, linux-x64, integration hermes 0.1.0: `ev.sha256.b24ff1f4cd1340d6c8198683bbc290147431f258fab8e249917edaa65c1539c4`
- opencode 1.18.29, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), openai-chat, linux-x64, integration opencode 0.1.0: `ev.sha256.bcc8939481a6ef92f44cd46d6e5d80b80a21fe5468acd282be4df0fc6b9b6528`
- opencode 1.18.29, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), openai-chat, windows-x64, integration opencode 0.1.0: `ev.sha256.7bb5b89637f6676e468cc7304993b2f3a515774c41191e40bd58fd6ecd72cc71`
- opencode 1.18.29, `deployment.apexnova.cmq4770nr0000edzis38w378a`, openai-responses, linux-x64, integration opencode 0.1.0: `evidence.3fa5e35537385cf736270de34394b1de`
- opencode 1.18.29, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), openai-responses, linux-x64, integration opencode 0.1.0: `ev.sha256.f61ff31afd83aa75c091936cf295f73fee481f9a5e0b5bfe6c34367b64831634`
- opencode 1.18.29, `deployment.apexnova.cmq4770nr0000edzis38w378a` (impl `e639719dc23b`), openai-responses, windows-x64, integration opencode 0.1.0: `ev.sha256.ac0710a57d0b411b95a814fbed6d786d8b5f9e15b11f1e73dba39215419ff80f`
- opencode 1.18.29, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), openai-chat, linux-x64, integration opencode 0.1.0: `ev.sha256.c5759ce6647ab11be52e19e61bbcae21b0ad9b7a387260813161e22a43f2bb3d`
- opencode 1.18.29, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw`, openai-responses, linux-x64, integration opencode 0.1.0: `evidence.f1e9a0dd5a089281d39c6d950402eeab`
- opencode 1.18.29, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), openai-responses, linux-x64, integration opencode 0.1.0: `ev.sha256.b18944091629b166f7aeb6ceb15a675dacba2f907b99e0beea95f3cb2de012f3`
- opencode 1.18.29, `deployment.apexnova.cmqr4cngr000dn1q69bbrl1vw` (impl `29870b6039ab`), openai-responses, windows-x64, integration opencode 0.1.0: `ev.sha256.f22199122f25e6beb42589721166eed2b81867a1ffdc37c2ef287d3147d221b0`
- opencode 1.18.29, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), openai-chat, linux-x64, integration opencode 0.1.0: `ev.sha256.1ac8367a9860b8b1ba6d53548fa681642715d38580aa803c1befc45f6e88b736`
- opencode 1.18.29, `deployment.apexnova.cmt0bub5d0042139w2xobpghn`, openai-responses, linux-x64, integration opencode 0.1.0: `evidence.552607de7fdf3203ead94a6c65f0ad99`
- opencode 1.18.29, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), openai-responses, linux-x64, integration opencode 0.1.0: `ev.sha256.662a03dadb7604a7f003d8982803c50df66bfa4e3a9bb5fd29233cb5f2f5d0fa`
- opencode 1.18.29, `deployment.apexnova.cmt0bub5d0042139w2xobpghn` (impl `052241dbad52`), openai-responses, windows-x64, integration opencode 0.1.0: `ev.sha256.cbdb87c8f867c5b92455ebd9786ae652b383dff92e63952273b3ca5216553739`
- opencode 1.18.29, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), openai-chat, linux-x64, integration opencode 0.1.0: `ev.sha256.3e116a6531df565dc334abb2606b22efa76b051a9a8c9125faddb7ec2c50fbce`
- opencode 1.18.29, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3`, openai-responses, linux-x64, integration opencode 0.1.0: `evidence.9edde81e07637920b6ce5d709afadc17`
- opencode 1.18.29, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), openai-responses, linux-x64, integration opencode 0.1.0: `ev.sha256.8ae3df111d7c61b696acd3bfd701183f81fd9b66932c78087b945131dd9dfe0c`
- opencode 1.18.29, `deployment.apexnova.cmtdear4g005n5pfmdx2ge3x3` (impl `e27721ab47cf`), openai-responses, windows-x64, integration opencode 0.1.0: `ev.sha256.8c0259087602ee351628deedff904b3e2e82b7208f5b7cb9ab584a4837f03c86`

