import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SecretValue } from "@apexnova-connect/credential-store";
import {
  REPLAY_CREDENTIAL,
  createReplayFetch,
  parseRecording,
  runCapabilitySuite,
  type CapabilityRecording,
} from "@apexnova-connect/capabilities";

import { startGateway, type RunningGateway } from "../src/index.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "capabilities",
  "tests",
  "fixtures",
  "qwen3-8-flash-openai-responses.recording.json",
);

const running: RunningGateway[] = [];

afterEach(async () => {
  for (const gateway of running.splice(0)) await gateway.close();
});

/**
 * The replay matches a request by path, body and whether it was authorized, and
 * it reads the authorization out of a plain header record because that is the
 * shape the suite's own fetch uses. The gateway sends a `Headers` object, which
 * is equally valid and would make every lookup miss, so it is flattened here.
 * This adapts how the oracle is addressed, never what it answers.
 */
function replayThrough(recording: CapabilityRecording): typeof globalThis.fetch {
  const replay = createReplayFetch(recording);
  return async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    // The recording also keys on the body as a string. The gateway streams it,
    // which is the behaviour under test, so the shim collects it here rather
    // than the gateway buffering to suit its own oracle.
    const body = init?.body instanceof ReadableStream
      ? await new Response(init.body).text()
      : init?.body;
    return replay(input, { ...init, headers, ...(body === undefined ? {} : { body }) } as RequestInit);
  };
}

/**
 * The strong faithfulness check ADR 0018 asked for and ADR 0019 recorded as not
 * done.
 *
 * Three agents returning the expected text proves the answers came out the same.
 * This runs the capability suite itself -- the thing built to notice streaming
 * order, cancellation and error semantics -- against one recording twice, once
 * straight at it and once with the gateway in between, and compares what the
 * suite concluded. Same answer is not the same events; this compares the events
 * the suite was designed to be sensitive to.
 */
describe("the gateway against the capability suite", () => {
  it("leads the suite to the same verdicts with and without it in the path", async () => {
    const recording = parseRecording(JSON.parse(await readFile(FIXTURE, "utf8")));

    const direct = await runCapabilitySuite({
      endpoint: recording.endpoint,
      protocol: recording.protocol,
      model: recording.model,
      modelId: recording.modelId,
      credential: SecretValue.from(REPLAY_CREDENTIAL),
      fetch: replayThrough(recording),
    });

    const gateway = await startGateway({
      upstreamBaseUrl: new URL(recording.endpoint).origin,
      // The gateway holds what the recording considers the real credential, and
      // the suite holds only the local token -- which is the production shape.
      credential: SecretValue.from(REPLAY_CREDENTIAL),
      fetch: replayThrough(recording),
    });
    running.push(gateway);

    const throughGateway = await runCapabilitySuite({
      endpoint: `${gateway.url}${new URL(recording.endpoint).pathname}`,
      protocol: recording.protocol,
      model: recording.model,
      modelId: recording.modelId,
      credential: SecretValue.from(gateway.localToken),
      allowInsecureLoopback: true,
    });

    const verdicts = (result: typeof direct) =>
      Object.fromEntries(result.outcomes.map((outcome) => [outcome.capabilityId, outcome.support]));

    // `auth.endpoint-reachable` is excluded by construction, not by convenience:
    // that probe checks a *bad* credential is rejected, and the gateway replaces
    // whatever the caller sent with its own. An Agent behind the gateway cannot
    // present a wrong Hub credential at all -- which is the point of the process
    // boundary, and means this one probe cannot be asked through it.
    const comparable = (result: typeof direct) => {
      const { "auth.endpoint-reachable": _auth, ...rest } = verdicts(result);
      return rest;
    };

    expect(comparable(throughGateway)).toEqual(comparable(direct));
    // Not vacuous: the recording carries findings in both directions, so an
    // equality that passed by turning everything "unknown" would fail here.
    expect(Object.values(comparable(direct))).toContain("supported");
    expect(Object.values(comparable(direct))).toContain("unsupported");
  });
});
