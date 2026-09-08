import type { SecretValue } from "@apexnova-connect/credential-store";

import { CAPABILITY_SUITE_ID, CAPABILITY_SUITE_VERSION } from "./definitions.js";
import { CapabilityError, type CapabilityOutcome, type CapabilitySupport } from "./evidence.js";

/** The two protocol families ADR 0004 fixed for the first batch. */
export type SuiteProtocol = "openai-responses" | "anthropic-messages";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_EVENTS = 512;
const MAX_DETAIL = 240;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface CapabilitySuiteOptions {
  readonly endpoint: string;
  readonly protocol: SuiteProtocol;
  /** The inference alias the Agent would send, not the catalog deployment ID. */
  readonly model: string;
  readonly deploymentId: string;
  readonly credential: SecretValue;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
  readonly allowInsecureLoopback?: boolean;
}

export interface CapabilityOutcomeDetail extends CapabilityOutcome {
  /** Structural, never a response body: findings are published. */
  readonly detail: string;
  readonly requestIds: readonly string[];
}

export interface CapabilitySuiteResult {
  readonly suite: { readonly id: string; readonly version: string };
  readonly outcomes: readonly CapabilityOutcomeDetail[];
  /** Every request the Hub attributed, for reconciliation against billed usage. */
  readonly requestIds: readonly string[];
  readonly billableRequests: number;
}

interface Probe {
  readonly ok: boolean;
  readonly status: number;
  readonly requestId?: string;
  readonly requestedModel?: string;
  readonly deploymentId?: string;
  readonly body?: Record<string, unknown>;
  readonly events?: readonly string[];
  readonly aborted?: boolean;
  readonly failure?: string;
}

function truncate(text: string): string {
  return text.length <= MAX_DETAIL ? text : `${text.slice(0, MAX_DETAIL - 1)}…`;
}

function endpointUrl(options: CapabilitySuiteOptions): URL {
  let url: URL;
  try {
    url = new URL(options.endpoint);
  } catch (cause) {
    throw new CapabilityError("INVALID_EVIDENCE", "Capability suite endpoint is invalid.", { cause });
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
  if (
    (url.protocol !== "https:" && !(options.allowInsecureLoopback === true && url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new CapabilityError(
      "INVALID_EVIDENCE",
      "Capability suite endpoint must be HTTPS without credentials, query, or fragment.",
    );
  }
  return url;
}

function headers(options: CapabilitySuiteOptions, credential: string, stream: boolean): Record<string, string> {
  return {
    accept: stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${credential}`,
    "content-type": "application/json",
    ...(options.protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}),
  };
}

function signalFor(options: CapabilitySuiteOptions, extra?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(options.requestTimeoutMs ?? 120_000);
  const signals = [timeout, ...(options.signal ? [options.signal] : []), ...(extra ? [extra] : [])];
  return signals.length === 1 ? timeout : AbortSignal.any(signals);
}

async function post(
  options: CapabilitySuiteOptions,
  body: unknown,
  overrides: { readonly credential?: string; readonly signal?: AbortSignal } = {},
): Promise<Response> {
  return await (options.fetch ?? globalThis.fetch)(endpointUrl(options), {
    method: "POST",
    headers: headers(options, overrides.credential ?? options.credential.reveal(), false),
    body: JSON.stringify(body),
    redirect: "error",
    signal: signalFor(options, overrides.signal),
  });
}

function probeHeaders(response: Response): Pick<Probe, "requestId" | "requestedModel" | "deploymentId"> {
  const requestId = response.headers.get("x-apexnova-request-id") ?? undefined;
  const requestedModel = response.headers.get("x-apexnova-requested-model") ?? undefined;
  const deploymentId = response.headers.get("x-apexnova-deployment-id") ?? undefined;
  return {
    ...(requestId ? { requestId } : {}),
    ...(requestedModel ? { requestedModel } : {}),
    ...(deploymentId ? { deploymentId } : {}),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function jsonProbe(
  options: CapabilitySuiteOptions,
  body: unknown,
  overrides: { readonly credential?: string } = {},
): Promise<Probe> {
  let response: Response;
  try {
    response = await post(options, body, overrides);
  } catch (cause) {
    return { ok: false, status: 0, failure: truncate(`request failed: ${(cause as Error).name}`) };
  }
  const parsed = await readJson(response);
  return {
    ok: response.ok,
    status: response.status,
    ...probeHeaders(response),
    ...(parsed ? { body: parsed } : {}),
  };
}

/**
 * Reads the event names off an SSE stream. Only names are kept: the deltas are
 * model output, and evidence is published.
 */
async function streamProbe(
  options: CapabilitySuiteOptions,
  body: unknown,
  abortAfterEvents?: number,
): Promise<Probe> {
  const controller = new AbortController();
  let response: Response;
  try {
    response = await post(options, body, { signal: controller.signal });
  } catch (cause) {
    return { ok: false, status: 0, failure: truncate(`request failed: ${(cause as Error).name}`) };
  }
  if (!response.ok || !response.body) {
    const parsed = await readJson(response);
    return {
      ok: false,
      status: response.status,
      ...probeHeaders(response),
      ...(parsed ? { body: parsed } : {}),
      events: [],
    };
  }

  const events: string[] = [];
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let bytes = 0;
  let aborted = false;
  let named = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES || events.length >= MAX_STREAM_EVENTS) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("event:")) {
          named = true;
          events.push(line.slice("event:".length).trim());
        } else if (!named && line.startsWith("data:")) {
          // Both protocols name their frames in an `event:` line, but a server
          // that only sends `data:` frames still carries the name in the
          // payload -- reading it there keeps a terse stream from being
          // reported as a stream with no events at all.
          const payload = line.slice("data:".length).trim();
          if (payload.startsWith("{")) {
            try {
              const parsed = JSON.parse(payload) as { type?: unknown };
              if (typeof parsed.type === "string") events.push(parsed.type);
            } catch {
              // A partial frame is not a finding on its own.
            }
          }
        }
        if (abortAfterEvents !== undefined && events.length >= abortAfterEvents) {
          controller.abort();
          aborted = true;
          break;
        }
        newline = buffer.indexOf("\n");
      }
      if (aborted) break;
    }
  } catch (cause) {
    // An abort we asked for is the expected path, not a failure.
    if (!aborted) {
      return {
        ok: false,
        status: response.status,
        ...probeHeaders(response),
        events,
        failure: truncate(`stream failed: ${(cause as Error).name}`),
      };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return { ok: true, status: response.status, ...probeHeaders(response), events, aborted };
}

const WEATHER_TOOL_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
} as const;

function minimalBody(options: CapabilitySuiteOptions, stream: boolean): unknown {
  if (options.protocol === "openai-responses") {
    return {
      model: options.model,
      input: "Reply with exactly OK.",
      max_output_tokens: 16,
      store: false,
      stream,
    };
  }
  return {
    model: options.model,
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    stream,
  };
}

function longerStreamBody(options: CapabilitySuiteOptions): unknown {
  if (options.protocol === "openai-responses") {
    return {
      model: options.model,
      input: "Count slowly from one to forty, one number per line.",
      max_output_tokens: 256,
      store: false,
      stream: true,
    };
  }
  return {
    model: options.model,
    max_tokens: 256,
    messages: [{ role: "user", content: "Count slowly from one to forty, one number per line." }],
    stream: true,
  };
}

function toolBody(options: CapabilitySuiteOptions): unknown {
  if (options.protocol === "openai-responses") {
    return {
      model: options.model,
      input: "What is the weather in Oslo? Use the tool.",
      max_output_tokens: 256,
      store: false,
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Look up the current weather for a city.",
          parameters: WEATHER_TOOL_SCHEMA,
          strict: true,
        },
      ],
      tool_choice: "required",
    };
  }
  return {
    model: options.model,
    max_tokens: 256,
    messages: [{ role: "user", content: "What is the weather in Oslo? Use the tool." }],
    tools: [
      {
        name: "get_weather",
        description: "Look up the current weather for a city.",
        input_schema: WEATHER_TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "get_weather" },
  };
}

const STRUCTURED_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" }, degrees: { type: "number" } },
  required: ["city", "degrees"],
  additionalProperties: false,
} as const;

function structuredBody(options: CapabilitySuiteOptions): unknown {
  if (options.protocol === "openai-responses") {
    return {
      model: options.model,
      input: "Oslo is 7 degrees. Answer with the schema.",
      max_output_tokens: 256,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "capability_probe",
          strict: true,
          schema: STRUCTURED_SCHEMA,
        },
      },
    };
  }
  // Anthropic Messages has no separate structured-output mode; a tool whose
  // input schema is the target shape is the supported way, and the evidence
  // says so rather than reporting the capability as missing.
  return {
    model: options.model,
    max_tokens: 256,
    messages: [{ role: "user", content: "Oslo is 7 degrees. Answer with the schema." }],
    tools: [{ name: "report_weather", description: "Report a weather reading.", input_schema: STRUCTURED_SCHEMA }],
    tool_choice: { type: "tool", name: "report_weather" },
  };
}

function invalidBody(options: CapabilitySuiteOptions): unknown {
  return options.protocol === "openai-responses"
    ? { model: options.model, input: "Reply with exactly OK.", max_output_tokens: -1, store: false }
    : { model: options.model, max_tokens: -1, messages: [{ role: "user", content: "Reply with exactly OK." }] };
}

function usageNumbers(body: Record<string, unknown> | undefined): boolean {
  const usage = body?.usage;
  if (typeof usage !== "object" || usage === null) return false;
  const record = usage as Record<string, unknown>;
  const input = record.input_tokens ?? record.prompt_tokens;
  const output = record.output_tokens ?? record.completion_tokens;
  return typeof input === "number" && typeof output === "number";
}

function responseItems(body: Record<string, unknown> | undefined): readonly Record<string, unknown>[] {
  const items = body?.output ?? body?.content;
  return Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
}

function toolArguments(
  protocol: SuiteProtocol,
  body: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  for (const item of responseItems(body)) {
    if (protocol === "anthropic-messages" && item.type === "tool_use" && typeof item.input === "object" && item.input !== null) {
      return item.input as Record<string, unknown>;
    }
    if (protocol === "openai-responses" && item.type === "function_call" && typeof item.arguments === "string") {
      try {
        const parsed: unknown = JSON.parse(item.arguments);
        if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function outputText(body: Record<string, unknown> | undefined): string | undefined {
  for (const item of responseItems(body)) {
    if (typeof item.text === "string") return item.text;
    const content = item.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
      }
    }
  }
  return undefined;
}

function outcome(
  capabilityId: string,
  support: CapabilitySupport,
  detail: string,
  requestIds: readonly (string | undefined)[] = [],
): CapabilityOutcomeDetail {
  return {
    capabilityId,
    support,
    detail: truncate(detail),
    requestIds: requestIds.filter((id): id is string => id !== undefined),
  };
}

function bodyShapeOk(protocol: SuiteProtocol, body: Record<string, unknown> | undefined): boolean {
  if (!body || typeof body.id !== "string") return false;
  return protocol === "openai-responses"
    ? Array.isArray(body.output)
    : body.type === "message" && Array.isArray(body.content);
}

function streamOrder(protocol: SuiteProtocol): { readonly first: string; readonly last: string } {
  return protocol === "openai-responses"
    ? { first: "response.created", last: "response.completed" }
    : { first: "message_start", last: "message_stop" };
}

/**
 * Runs the first batch against one deployment and protocol. Every probe that
 * fails becomes an outcome, never an exception: a deployment that cannot stream
 * is a finding, not a broken run. Five of the seven requests are billable.
 */
export async function runCapabilitySuite(
  options: CapabilitySuiteOptions,
): Promise<CapabilitySuiteResult> {
  endpointUrl(options);
  const outcomes: CapabilityOutcomeDetail[] = [];
  const requestIds: string[] = [];
  const collect = (probe: Probe) => {
    if (probe.requestId) requestIds.push(probe.requestId);
    return probe;
  };

  const minimal = collect(await jsonProbe(options, minimalBody(options, false)));
  const rejected = collect(
    await jsonProbe(options, minimalBody(options, false), { credential: "apexnova-connect-invalid-credential" }),
  );

  outcomes.push(
    !minimal.ok
      ? outcome(
          "auth.endpoint-reachable",
          "unsupported",
          `the runtime credential was refused: HTTP ${minimal.status}${minimal.failure ? ` (${minimal.failure})` : ""}`,
          [minimal.requestId],
        )
      : rejected.status === 401 || rejected.status === 403
        ? outcome(
            "auth.endpoint-reachable",
            "supported",
            `HTTP ${minimal.status} with the credential, HTTP ${rejected.status} without it`,
            [minimal.requestId],
          )
        : outcome(
            "auth.endpoint-reachable",
            "unsupported",
            `an invalid credential was answered with HTTP ${rejected.status} instead of 401 or 403`,
            [minimal.requestId, rejected.requestId],
          ),
  );

  const modelMatches =
    minimal.requestedModel === options.model && minimal.deploymentId === options.deploymentId;
  outcomes.push(
    !minimal.ok
      ? outcome("protocol.model-id-mapping", "unknown", "no successful response to read the mapping from", [minimal.requestId])
      : modelMatches
        ? outcome(
            "protocol.model-id-mapping",
            typeof minimal.body?.model === "string" ? "supported" : "partial",
            typeof minimal.body?.model === "string"
              ? `requested ${options.model} was served by deployment ${options.deploymentId}`
              : `headers matched, but the body carried no model field`,
            [minimal.requestId],
          )
        : outcome(
            "protocol.model-id-mapping",
            "unsupported",
            `requested ${options.model} on ${options.deploymentId}, served as ${minimal.requestedModel ?? "unknown"} on ${minimal.deploymentId ?? "unknown"}`,
            [minimal.requestId],
          ),
  );

  const shapeOk = bodyShapeOk(options.protocol, minimal.body);
  outcomes.push(
    !minimal.ok
      ? outcome("protocol.non-streaming", "unsupported", `HTTP ${minimal.status}${minimal.failure ? ` (${minimal.failure})` : ""}`, [minimal.requestId])
      : shapeOk && usageNumbers(minimal.body)
        ? outcome("protocol.non-streaming", "supported", "response matched the protocol shape and reported usage", [minimal.requestId])
        : outcome(
            "protocol.non-streaming",
            "partial",
            shapeOk ? "response shape matched but usage was missing, so it cannot be reconciled" : "response did not match the protocol shape",
            [minimal.requestId],
          ),
  );

  const streamed = collect(await streamProbe(options, minimalBody(options, true)));
  const order = streamOrder(options.protocol);
  const events = streamed.events ?? [];
  outcomes.push(
    !streamed.ok
      ? outcome("protocol.streaming-order", "unsupported", `HTTP ${streamed.status}${streamed.failure ? ` (${streamed.failure})` : ""}`, [streamed.requestId])
      : events[0] === order.first && events[events.length - 1] === order.last
        ? outcome("protocol.streaming-order", "supported", `${events.length} events, ${order.first} first and ${order.last} last`, [streamed.requestId])
        : outcome(
            "protocol.streaming-order",
            "unsupported",
            `stream started with ${events[0] ?? "nothing"} and ended with ${events[events.length - 1] ?? "nothing"}`,
            [streamed.requestId],
          ),
  );

  const cancelled = collect(await streamProbe(options, longerStreamBody(options), 2));
  outcomes.push(
    cancelled.aborted === true
      ? outcome("protocol.cancellation", "supported", "the stream closed when the client aborted", [cancelled.requestId])
      : !cancelled.ok
        ? outcome("protocol.cancellation", "unsupported", `HTTP ${cancelled.status}${cancelled.failure ? ` (${cancelled.failure})` : ""}`, [cancelled.requestId])
        : outcome(
            "protocol.cancellation",
            "partial",
            `the response completed in ${(cancelled.events ?? []).length} events before it could be aborted`,
            [cancelled.requestId],
          ),
  );

  const invalid = collect(await jsonProbe(options, invalidBody(options)));
  const invalidError = invalid.body?.error;
  const structuredError =
    typeof invalidError === "object" && invalidError !== null &&
    typeof (invalidError as { message?: unknown }).message === "string";
  outcomes.push(
    invalid.status >= 400 && invalid.status < 500 && structuredError && invalid.requestId !== undefined
      ? outcome("protocol.error-semantics", "supported", `an invalid request returned HTTP ${invalid.status} with a structured error and a request ID`, [invalid.requestId])
      : invalid.status >= 400 && invalid.status < 500
        ? outcome(
            "protocol.error-semantics",
            "partial",
            `HTTP ${invalid.status}, but ${structuredError ? "without a request ID" : "without a structured error"}`,
            [invalid.requestId],
          )
        : outcome(
            "protocol.error-semantics",
            "unsupported",
            `an invalid request returned HTTP ${invalid.status}${invalid.failure ? ` (${invalid.failure})` : ""}`,
            [invalid.requestId],
          ),
  );

  const tool = collect(await jsonProbe(options, toolBody(options)));
  const toolArgs = toolArguments(options.protocol, tool.body);
  outcomes.push(
    !tool.ok
      ? outcome("agent.single-tool-call", "unsupported", `HTTP ${tool.status}${tool.failure ? ` (${tool.failure})` : ""}`, [tool.requestId])
      : toolArgs === undefined
        ? outcome("agent.single-tool-call", "unsupported", "the response carried no tool call", [tool.requestId])
        : typeof toolArgs.city === "string"
          ? outcome("agent.single-tool-call", "supported", "the tool was called with arguments matching the declared schema", [tool.requestId])
          : outcome("agent.single-tool-call", "partial", "a tool call came back with arguments that do not match the declared schema", [tool.requestId]),
  );

  const structured = collect(await jsonProbe(options, structuredBody(options)));
  const structuredValue =
    options.protocol === "anthropic-messages"
      ? toolArguments(options.protocol, structured.body)
      : parseJsonObject(outputText(structured.body));
  const schemaHonoured =
    structuredValue !== undefined &&
    typeof structuredValue.city === "string" &&
    typeof structuredValue.degrees === "number";
  outcomes.push(
    !structured.ok
      ? outcome("agent.structured-output", "unsupported", `HTTP ${structured.status}${structured.failure ? ` (${structured.failure})` : ""}`, [structured.requestId])
      : schemaHonoured
        ? outcome(
            "agent.structured-output",
            "supported",
            options.protocol === "anthropic-messages"
              ? "the schema was honoured through a tool, which is what this protocol offers"
              : "the response followed the requested JSON schema",
            [structured.requestId],
          )
        : outcome("agent.structured-output", "unsupported", "the response did not follow the requested schema", [structured.requestId]),
  );

  return {
    suite: { id: CAPABILITY_SUITE_ID, version: CAPABILITY_SUITE_VERSION },
    outcomes,
    requestIds,
    // The rejected credential and the invalid request are refused before inference.
    billableRequests: 5,
  };
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
