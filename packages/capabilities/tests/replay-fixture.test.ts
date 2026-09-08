import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SecretValue } from "@apexnova-connect/credential-store";

import {
  REPLAY_CREDENTIAL,
  createReplayFetch,
  parseRecording,
  runCapabilitySuite,
} from "../src/index.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "qwen3-8-flash-openai-responses.recording.json",
);

/**
 * A real run against `qwen3.8-flash` on the live Hub, recorded on 2026-09-08 and
 * replayable from here on. This is what makes the suite's decisions checkable
 * without a Hub, a credential or a bill -- and it is a recording of one moment,
 * not a claim about the deployment today.
 */
describe("replaying a recorded live run", () => {
  it("reaches the same outcomes the live run reported", async () => {
    const recording = parseRecording(JSON.parse(await readFile(FIXTURE, "utf8")));

    const result = await runCapabilitySuite({
      endpoint: recording.endpoint,
      protocol: recording.protocol,
      model: recording.model,
      deploymentId: recording.deploymentId,
      credential: SecretValue.from(REPLAY_CREDENTIAL),
      fetch: createReplayFetch(recording),
    });

    expect(Object.fromEntries(result.outcomes.map((outcome) => [outcome.capabilityId, outcome.support])))
      .toEqual({
        "auth.endpoint-reachable": "supported",
        "protocol.model-id-mapping": "supported",
        "protocol.non-streaming": "supported",
        "protocol.streaming-order": "supported",
        "protocol.cancellation": "supported",
        "protocol.error-semantics": "supported",
        "agent.single-tool-call": "supported",
        // The finding that held across every deployment tested: the
        // openai-responses path did not honour text.format.json_schema.
        "agent.structured-output": "unsupported",
      });
    expect(result.requestIds.length).toBeGreaterThan(0);
  });

  it("carries no credential and no request headers", async () => {
    const raw = await readFile(FIXTURE, "utf8");

    expect(raw).not.toMatch(/anrt_[A-Za-z0-9]/);
    expect(raw.toLowerCase()).not.toContain("authorization");
    const recording = parseRecording(JSON.parse(raw));
    for (const interaction of recording.interactions) {
      for (const header of Object.keys(interaction.headers)) {
        expect(header).toMatch(/^(content-type|x-apexnova-[a-z-]+)$/);
      }
    }
  });
});
