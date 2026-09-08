import { describe, expect, it } from "vitest";

import { SecretValue } from "@apexnova-connect/credential-store";

import {
  REPLAY_CREDENTIAL,
  buildRecording,
  createRecordingFetch,
  createReplayFetch,
  parseRecording,
  redact,
  runCapabilitySuite,
  type CapabilitySuiteResult,
  type SuiteProtocol,
} from "../src/index.js";

const MODEL = "glm-5.2";
const DEPLOYMENT = "deployment.glm-5-2";
const ENDPOINT = "https://api.example.test/v1/responses";
const SECRET = "anrt_live_9f2b41d7c8aa";

function hubHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-apexnova-request-id": "req_1",
    "x-apexnova-requested-model": MODEL,
    "x-apexnova-deployment-id": DEPLOYMENT,
    "x-apexnova-provider-id": "provider.apexnova-ai-hub",
    // A header nothing reads, and the recording should not keep it either.
    "set-cookie": "session=abc123",
  };
}

/** A Hub that answers every probe, and leaks a credential into one response. */
function hub(protocol: SuiteProtocol): typeof globalThis.fetch {
  return async (_input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (headers.authorization !== `Bearer ${SECRET}`) {
      return new Response(JSON.stringify({ error: { message: "invalid credential" } }), {
        status: 401,
        headers: hubHeaders(),
      });
    }
    if (body.max_output_tokens === -1 || body.max_tokens === -1) {
      return new Response(
        // The gateway echoing a credential back is exactly what must not land
        // in a fixture that gets committed.
        JSON.stringify({ error: { message: `rejected request for Bearer ${SECRET}` } }),
        { status: 400, headers: hubHeaders() },
      );
    }
    if (body.stream === true) {
      const events = protocol === "openai-responses"
        ? ["response.created", "response.output_text.delta", "response.completed"]
        : ["message_start", "content_block_delta", "message_stop"];
      return new Response(events.map((event) => `event: ${event}\ndata: {"type":"${event}"}\n\n`).join(""), {
        status: 200,
        headers: { ...hubHeaders(), "content-type": "text/event-stream" },
      });
    }
    const usage = { input_tokens: 17, output_tokens: 5 };
    if (Array.isArray(body.tools)) {
      const payload = { city: "Oslo", degrees: 7 };
      return new Response(
        JSON.stringify(
          protocol === "openai-responses"
            ? { id: "resp_2", model: MODEL, output: [{ type: "function_call", name: "get_weather", arguments: JSON.stringify(payload) }], usage }
            : { id: "msg_2", type: "message", model: MODEL, content: [{ type: "tool_use", name: "get_weather", input: payload }], usage },
        ),
        { status: 200, headers: hubHeaders() },
      );
    }
    const text = body.text === undefined ? "OK" : JSON.stringify({ city: "Oslo", degrees: 7 });
    return new Response(
      JSON.stringify(
        protocol === "openai-responses"
          ? { id: "resp_1", model: MODEL, output: [{ type: "message", content: [{ type: "output_text", text }] }], usage }
          : { id: "msg_1", type: "message", model: MODEL, content: [{ type: "text", text }], usage },
      ),
      { status: 200, headers: hubHeaders() },
    );
  };
}

function support(result: CapabilitySuiteResult): Record<string, string> {
  return Object.fromEntries(result.outcomes.map((outcome) => [outcome.capabilityId, outcome.support]));
}

async function recordSuite(protocol: SuiteProtocol) {
  const recorder = createRecordingFetch({ fetch: hub(protocol), credential: SECRET });
  const live = await runCapabilitySuite({
    endpoint: protocol === "openai-responses" ? ENDPOINT : "https://api.example.test/v1/messages",
    protocol,
    model: MODEL,
    deploymentId: DEPLOYMENT,
    credential: SecretValue.from(SECRET),
    fetch: recorder.fetch,
  });
  const recording = buildRecording({
    endpoint: protocol === "openai-responses" ? ENDPOINT : "https://api.example.test/v1/messages",
    protocol,
    model: MODEL,
    deploymentId: DEPLOYMENT,
    recordedAt: "2026-09-08T18:00:00.000Z",
    interactions: recorder.interactions(),
  });
  return { live, recording };
}

describe("recording and replay", () => {
  for (const protocol of ["openai-responses", "anthropic-messages"] as const) {
    it(`replays a recorded ${protocol} run to the same outcomes`, async () => {
      const { live, recording } = await recordSuite(protocol);

      const replayed = await runCapabilitySuite({
        endpoint: recording.endpoint,
        protocol: recording.protocol,
        model: recording.model,
        deploymentId: recording.deploymentId,
        credential: SecretValue.from(REPLAY_CREDENTIAL),
        fetch: createReplayFetch(recording),
      });

      expect(support(replayed)).toEqual(support(live));
      expect(replayed.requestIds).toEqual(live.requestIds);
      // A replay survives a round trip through disk, which is the point of it.
      expect(parseRecording(JSON.parse(JSON.stringify(recording)))).toEqual(recording);
    });
  }

  it("keeps credentials out of the recording, and headers nothing reads", async () => {
    const { recording } = await recordSuite("openai-responses");
    const serialized = JSON.stringify(recording);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("set-cookie");
    expect(serialized).not.toContain("session=abc123");
    // Request headers are where the credential lives, so none are kept at all.
    expect(serialized).not.toContain("authorization");
  });

  it("separates the authorized probe from the one sent without a credential", async () => {
    const { recording } = await recordSuite("openai-responses");

    const unauthorized = recording.interactions.filter((interaction) => !interaction.authorized);
    expect(unauthorized).toHaveLength(1);
    expect(unauthorized[0]?.status).toBe(401);
  });

  it("refuses a request the recording does not cover instead of inventing a failure", async () => {
    const { recording } = await recordSuite("openai-responses");
    const partial = { ...recording, interactions: recording.interactions.slice(0, 2) };

    await expect(
      runCapabilitySuite({
        endpoint: partial.endpoint,
        protocol: partial.protocol,
        model: partial.model,
        deploymentId: partial.deploymentId,
        credential: SecretValue.from(REPLAY_CREDENTIAL),
        fetch: createReplayFetch(partial),
      }),
    ).rejects.toMatchObject({ code: "RECORDING_INCOMPLETE" });
  });

  it("rejects a file that is not a recording", () => {
    expect(() => parseRecording({ version: 2 })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVIDENCE" }),
    );
    expect(redact(`Bearer ${SECRET}`)).not.toContain(SECRET);
  });
});
