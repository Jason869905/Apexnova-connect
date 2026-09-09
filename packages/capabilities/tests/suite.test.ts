import { describe, expect, it } from "vitest";

import { SecretValue } from "@apexnova-connect/credential-store";

import { runCapabilitySuite, type SuiteProtocol } from "../src/index.js";

const MODEL = "glm-5.2";
const DEPLOYMENT = "deployment.glm-5-2";

function hubHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    "x-apexnova-request-id": "req_1",
    "x-apexnova-requested-model": MODEL,
    "x-apexnova-deployment-id": DEPLOYMENT,
    "x-apexnova-provider-id": "provider.apexnova-ai-hub",
    ...extra,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = hubHeaders()): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

function sse(events: readonly string[]): Response {
  const text = events.map((event) => `event: ${event}\ndata: {"type":"${event}"}\n\n`).join("");
  return new Response(text, {
    status: 200,
    headers: { ...hubHeaders(), "content-type": "text/event-stream" },
  });
}

interface RequestShape {
  readonly authorized: boolean;
  readonly body: Record<string, unknown>;
  readonly stream: boolean;
  readonly tools: boolean;
  readonly forced: boolean;
  readonly structured: boolean;
  readonly invalid: boolean;
}

function shape(init: RequestInit | undefined): RequestShape {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  const toolNames = Array.isArray(body.tools)
    ? body.tools.map((tool) => (tool as { name?: string }).name)
    : [];
  return {
    authorized: !String(headers.authorization ?? "").includes("invalid-credential"),
    body,
    stream: body.stream === true,
    tools: toolNames.includes("get_weather"),
    forced: body.tool_choice !== undefined && toolNames.includes("get_weather"),
    structured: toolNames.includes("report_weather") || body.text !== undefined,
    invalid: body.max_output_tokens === -1 || body.max_tokens === -1,
  };
}

/**
 * A Hub that behaves: the shape every probe expects to find. Overrides are
 * factories because a Response body can only be read once.
 */
function healthyHub(protocol: SuiteProtocol, overrides: Partial<Record<string, () => Response>> = {}) {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = shape(init);
    if (!request.authorized) return overrides.unauthorized?.() ?? json({ error: { message: "invalid credential" } }, 401);
    if (request.invalid) return overrides.invalid?.() ?? json({ error: { message: "max tokens must be positive" } }, 400);
    if (request.stream) {
      const events = protocol === "openai-responses"
        ? ["response.created", "response.output_text.delta", "response.output_text.delta", "response.completed"]
        : ["message_start", "content_block_delta", "content_block_delta", "message_stop"];
      return overrides.stream?.() ?? sse(events);
    }
    if (request.forced) return overrides.forced?.() ?? json(toolResponse(protocol, { city: "Oslo" }));
    if (request.tools) return overrides.tools?.() ?? json(toolResponse(protocol, { city: "Oslo" }));
    if (request.structured) return overrides.structured?.() ?? structuredResponse(protocol);
    return overrides.minimal?.() ?? json(messageResponse(protocol, "OK"));
  };
}

function messageResponse(protocol: SuiteProtocol, text: string): unknown {
  const usage = { input_tokens: 17, output_tokens: 3 };
  return protocol === "openai-responses"
    ? { id: "resp_1", model: MODEL, output: [{ type: "message", content: [{ type: "output_text", text }] }], usage }
    : { id: "msg_1", type: "message", model: MODEL, content: [{ type: "text", text }], usage };
}

function toolResponse(protocol: SuiteProtocol, input: Record<string, unknown>): unknown {
  const usage = { input_tokens: 42, output_tokens: 12 };
  return protocol === "openai-responses"
    ? { id: "resp_2", model: MODEL, output: [{ type: "function_call", name: "get_weather", arguments: JSON.stringify(input) }], usage }
    : { id: "msg_2", type: "message", model: MODEL, content: [{ type: "tool_use", name: "get_weather", input }], usage };
}

function structuredResponse(protocol: SuiteProtocol): Response {
  return protocol === "openai-responses"
    ? json(messageResponse(protocol, JSON.stringify({ city: "Oslo", degrees: 7 })))
    : json(toolResponse(protocol, { city: "Oslo", degrees: 7 }));
}

function options(protocol: SuiteProtocol, fetchImpl: typeof globalThis.fetch) {
  return {
    endpoint: protocol === "openai-responses"
      ? "https://api.example.test/v1/responses"
      : "https://api.example.test/v1/messages",
    protocol,
    model: MODEL,
    deploymentId: DEPLOYMENT,
    credential: SecretValue.from("runtime-secret"),
    fetch: fetchImpl,
  };
}

function support(result: Awaited<ReturnType<typeof runCapabilitySuite>>): Record<string, string> {
  return Object.fromEntries(result.outcomes.map((outcome) => [outcome.capabilityId, outcome.support]));
}

describe("runCapabilitySuite", () => {
  for (const protocol of ["openai-responses", "anthropic-messages"] as const) {
    it(`records every capability as supported against a healthy ${protocol} deployment`, async () => {
      const result = await runCapabilitySuite(options(protocol, healthyHub(protocol)));

      expect(support(result)).toEqual({
        "auth.endpoint-reachable": "supported",
        "protocol.model-id-mapping": "supported",
        "protocol.non-streaming": "supported",
        "protocol.streaming-order": "supported",
        "protocol.cancellation": "supported",
        "protocol.error-semantics": "supported",
        "agent.single-tool-call": "supported",
        "agent.forced-tool-choice": "supported",
        "agent.structured-output": "supported",
      });
      expect(result.billableRequests).toBe(6);
      expect(result.requestIds).toContain("req_1");
    });
  }

  it("reports an accepted invalid credential as a failure of the auth capability", async () => {
    const result = await runCapabilitySuite(
      options("openai-responses", healthyHub("openai-responses", { unauthorized: () => json(messageResponse("openai-responses", "OK")) })),
    );

    const auth = result.outcomes.find((outcome) => outcome.capabilityId === "auth.endpoint-reachable");
    expect(auth).toMatchObject({ support: "unsupported" });
    expect(auth?.detail).toContain("instead of 401 or 403");
  });

  it("reports a stream that never terminates as unsupported", async () => {
    const result = await runCapabilitySuite(
      options("openai-responses", healthyHub("openai-responses", { stream: () => sse(["response.created", "response.output_text.delta"]) })),
    );

    expect(support(result)["protocol.streaming-order"]).toBe("unsupported");
    // Two events is enough to abort on, so cancellation still reads as supported.
    expect(support(result)["protocol.cancellation"]).toBe("supported");
  });

  it("reports a missing tool call and a schema the response ignored", async () => {
    const protocol = "anthropic-messages";
    const result = await runCapabilitySuite(
      options(
        protocol,
        healthyHub(protocol, {
          tools: () => json(messageResponse(protocol, "I cannot use tools.")),
          structured: () => json(messageResponse(protocol, "It is 7 degrees in Oslo.")),
        }),
      ),
    );

    expect(support(result)["agent.single-tool-call"]).toBe("unsupported");
    expect(support(result)["agent.structured-output"]).toBe("unsupported");
    // The rest of the run still stands: one failure is a finding, not a crash.
    expect(support(result)["protocol.non-streaming"]).toBe("supported");
  });

  it("tells a refused forced tool_choice apart from tools not working", async () => {
    const protocol = "openai-responses";
    const result = await runCapabilitySuite(
      options(
        protocol,
        healthyHub(protocol, {
          // What qwen3.8-flash does: ordinary tool calls are fine, forcing one
          // is refused outright.
          forced: () =>
            json({ error: { message: "litellm.BadRequestError - The tool_choice parameter does not support being set to required or object" } }, 400),
        }),
      ),
    );

    expect(support(result)["agent.single-tool-call"]).toBe("supported");
    const forced = result.outcomes.find((outcome) => outcome.capabilityId === "agent.forced-tool-choice");
    expect(forced).toMatchObject({ support: "unsupported" });
    expect(forced?.detail).toContain("400");
  });

  it("separates a forced tool_choice that is accepted and then ignored", async () => {
    const protocol = "anthropic-messages";
    const result = await runCapabilitySuite(
      options(protocol, healthyHub(protocol, { forced: () => json(messageResponse(protocol, "It is 7 degrees in Oslo.")) })),
    );

    // A 200 with prose is worse than a refusal for a caller relying on the
    // call, because nothing reports an error.
    expect(support(result)["agent.forced-tool-choice"]).toBe("partial");
    expect(support(result)["agent.single-tool-call"]).toBe("supported");
  });

  it("reports a mismatched deployment rather than trusting the request", async () => {
    const wrongDeployment = () =>
      json(
        messageResponse("openai-responses", "OK"),
        200,
        hubHeaders({ "x-apexnova-deployment-id": "deployment.something-else" }),
      );
    const result = await runCapabilitySuite(
      options("openai-responses", healthyHub("openai-responses", { minimal: wrongDeployment })),
    );

    const mapping = result.outcomes.find((outcome) => outcome.capabilityId === "protocol.model-id-mapping");
    expect(mapping).toMatchObject({ support: "unsupported" });
    expect(mapping?.detail).toContain("deployment.something-else");
  });

  it("turns a refused endpoint into outcomes instead of throwing", async () => {
    const result = await runCapabilitySuite(
      options("openai-responses", async () => json({ error: { message: "unavailable" } }, 503, hubHeaders())),
    );

    expect(support(result)).toMatchObject({
      "auth.endpoint-reachable": "unsupported",
      "protocol.model-id-mapping": "unknown",
      "protocol.non-streaming": "unsupported",
      "protocol.error-semantics": "unsupported",
    });
  });

  it("refuses an endpoint that is not HTTPS", async () => {
    await expect(
      runCapabilitySuite({
        ...options("openai-responses", healthyHub("openai-responses")),
        endpoint: "http://api.example.test/v1/responses",
      }),
    ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
  });
});

describe("stream event names", () => {
  it("reads the frame type when the server sends no event lines", async () => {
    const dataOnly = () =>
      new Response(
        ['{"type":"response.created"}', '{"type":"response.output_text.delta"}', '{"type":"response.completed"}']
          .map((payload) => `data: ${payload}\n\n`)
          .join(""),
        { status: 200, headers: { ...hubHeaders(), "content-type": "text/event-stream" } },
      );

    const result = await runCapabilitySuite(
      options("openai-responses", healthyHub("openai-responses", { stream: dataOnly })),
    );

    expect(support(result)["protocol.streaming-order"]).toBe("supported");
  });
});

describe("probe shape", () => {
  it("offers the tool without forcing the choice", async () => {
    const bodies: Record<string, unknown>[] = [];
    const recording: typeof globalThis.fetch = async (input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return healthyHub("openai-responses")(input, init);
    };

    await runCapabilitySuite(options("openai-responses", recording));

    // Forcing the choice tests a stronger claim than "a tool is callable", and
    // some deployments reject the forced form outright.
    const toolRequest = bodies.find((body) => Array.isArray(body.tools) && body.text === undefined);
    expect(toolRequest).toBeDefined();
    expect(toolRequest?.tool_choice).toBeUndefined();
  });
});
