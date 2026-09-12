import type { SecretValue } from "@apexnova-connect/credential-store";

import { CAPABILITY_SUITE_ID, CAPABILITY_SUITE_VERSION } from "./definitions.js";
import { CapabilityError, type CapabilityOutcome, type CapabilitySupport } from "./evidence.js";

/**
 * The protocol families the suite can measure.
 *
 * ADR 0004 fixed the first two; `openai-chat-completions` was added once
 * [ADR 0023](../../../docs/decisions/0023-integration-status-ladder.md) made
 * "declared means measured" a checked condition and two Integrations turned out
 * to declare a protocol no instrument here could reach.
 */
export type SuiteProtocol = "openai-responses" | "anthropic-messages" | "openai-chat-completions";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_EVENTS = 512;
const MAX_DETAIL = 240;
/** Chat Completions ends its stream with this rather than a named frame. */
const DONE_SENTINEL = "[DONE]";
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
  /**
   * Requests refused before authentication. Hub answers them with a request ID
   * but writes no ledger row -- there is no account to bill yet -- so
   * reconciliation must not wait for one.
   */
  readonly preAuthRequestIds: readonly string[];
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
    // A broken transport -- a replay with no recording for this request, say --
    // is a problem with the harness, not a finding about the deployment.
    if (cause instanceof CapabilityError) throw cause;
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
    if (cause instanceof CapabilityError) throw cause;
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
          // Responses and Messages name their frames in an `event:` line, but a
          // server that only sends `data:` frames still carries the name in the
          // payload -- reading it there keeps a terse stream from being
          // reported as a stream with no events at all.
          //
          // Chat Completions never names frames: every one is an object whose
          // `object` field says what it is, and the stream ends with the
          // sentinel `data: [DONE]`, which is not JSON at all. Both are read
          // here so that protocol has an order to check rather than looking
          // like a stream of nothing.
          const payload = line.slice("data:".length).trim();
          if (payload === DONE_SENTINEL) {
            events.push(DONE_SENTINEL);
          } else if (payload.startsWith("{")) {
            try {
              const parsed = JSON.parse(payload) as { type?: unknown; object?: unknown };
              if (typeof parsed.type === "string") events.push(parsed.type);
              else if (typeof parsed.object === "string") events.push(parsed.object);
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
  if (options.protocol === "openai-chat-completions") {
    return {
      model: options.model,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      max_tokens: 16,
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
  if (options.protocol === "openai-chat-completions") {
    return {
      model: options.model,
      messages: [{ role: "user", content: "Count slowly from one to forty, one number per line." }],
      max_tokens: 256,
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

/**
 * Declares one tool and asks for it, without forcing the choice. Forcing is a
 * stronger claim than the capability makes -- an Agent loop offers tools and
 * lets the model decide -- and some deployments reject a forced `tool_choice`
 * outright, which would report tool calling as broken on a model that calls
 * tools perfectly well.
 */
function toolBody(options: CapabilitySuiteOptions): unknown {
  if (options.protocol === "openai-responses") {
    return {
      model: options.model,
      input: "What is the weather in Oslo? Use the get_weather tool to answer.",
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
    };
  }
  if (options.protocol === "openai-chat-completions") {
    return {
      model: options.model,
      messages: [{ role: "user", content: "What is the weather in Oslo? Use the get_weather tool to answer." }],
      max_tokens: 256,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Look up the current weather for a city.",
            parameters: WEATHER_TOOL_SCHEMA,
          },
        },
      ],
    };
  }
  return {
    model: options.model,
    max_tokens: 256,
    messages: [{ role: "user", content: "What is the weather in Oslo? Use the get_weather tool to answer." }],
    tools: [
      {
        name: "get_weather",
        description: "Look up the current weather for a city.",
        input_schema: WEATHER_TOOL_SCHEMA,
      },
    ],
  };
}

/**
 * The same tool, forced by name. This is a different question from offering it:
 * an endpoint can call tools perfectly well and still refuse `tool_choice`, and
 * because a forced named tool is how a schema is carried on protocols with no
 * structured-output mode, the two failures look identical from the outside
 * until they are asked separately.
 */
function forcedToolBody(options: CapabilitySuiteOptions): unknown {
  if (options.protocol === "openai-responses") {
    return {
      model: options.model,
      input: "What is the weather in Oslo?",
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
      tool_choice: { type: "function", name: "get_weather" },
    };
  }
  if (options.protocol === "openai-chat-completions") {
    return {
      model: options.model,
      messages: [{ role: "user", content: "What is the weather in Oslo?" }],
      max_tokens: 256,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Look up the current weather for a city.",
            parameters: WEATHER_TOOL_SCHEMA,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    };
  }
  return {
    model: options.model,
    max_tokens: 256,
    messages: [{ role: "user", content: "What is the weather in Oslo?" }],
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
  if (options.protocol === "openai-chat-completions") {
    // Chat Completions has a structured-output mode of its own, so unlike
    // Anthropic Messages it is asked directly rather than through a tool.
    return {
      model: options.model,
      messages: [{ role: "user", content: "Oslo is 7 degrees. Answer with the schema." }],
      max_tokens: 256,
      response_format: {
        type: "json_schema",
        json_schema: { name: "capability_probe", strict: true, schema: STRUCTURED_SCHEMA },
      },
    };
  }
  // Anthropic Messages has no separate structured-output mode; a tool whose
  // input schema is the target shape is the supported way, and the evidence
  // says so rather than reporting the capability as missing. Forcing the choice
  // is inherent to that mechanism, unlike the tool-call probe above.
  return {
    model: options.model,
    max_tokens: 256,
    messages: [{ role: "user", content: "Oslo is 7 degrees. Answer with the schema." }],
    tools: [{ name: "report_weather", description: "Report a weather reading.", input_schema: STRUCTURED_SCHEMA }],
    tool_choice: { type: "tool", name: "report_weather" },
  };
}

function invalidBody(options: CapabilitySuiteOptions): unknown {
  // Chat Completions and Anthropic Messages take the same shape here, and a
  // negative token ceiling is invalid in both.
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
  // Chat Completions puts the call under the message rather than in the
  // content list, so it is read before the shared item walk below.
  if (protocol === "openai-chat-completions") {
    for (const call of chatToolCalls(body)) {
      const args = (call.function as { arguments?: unknown } | undefined)?.arguments;
      if (typeof args === "string") return parseJsonObject(args);
    }
    return undefined;
  }
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

/** `choices[0].message`, which is where Chat Completions puts its answer. */
function chatMessage(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const choices = body?.choices;
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  return typeof message === "object" && message !== null ? message as Record<string, unknown> : undefined;
}

function chatToolCalls(body: Record<string, unknown> | undefined): readonly Record<string, unknown>[] {
  const calls = chatMessage(body)?.tool_calls;
  return Array.isArray(calls)
    ? calls.filter((call): call is Record<string, unknown> => typeof call === "object" && call !== null)
    : [];
}

function outputText(body: Record<string, unknown> | undefined): string | undefined {
  const chat = chatMessage(body)?.content;
  if (typeof chat === "string") return chat;
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

/** The gateway's own error text, which is not model output, capped and trimmed. */
function apiMessage(probe: Probe): string {
  const error = probe.body?.error;
  if (typeof error !== "object" || error === null) return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? `: ${truncate(message.slice(0, 120))}` : "";
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
  if (protocol === "openai-responses") return Array.isArray(body.output);
  if (protocol === "openai-chat-completions") {
    return body.object === "chat.completion" && Array.isArray(body.choices);
  }
  return body.type === "message" && Array.isArray(body.content);
}

function streamOrder(protocol: SuiteProtocol): { readonly first: string; readonly last: string } {
  if (protocol === "openai-responses") return { first: "response.created", last: "response.completed" };
  // Chat Completions has no lifecycle frames: the contract is that every frame
  // is a chunk and the sentinel closes the stream. That is the whole of its
  // ordering guarantee, so it is the whole of what this asks for.
  if (protocol === "openai-chat-completions") return { first: "chat.completion.chunk", last: DONE_SENTINEL };
  return { first: "message_start", last: "message_stop" };
}

/**
 * Runs the first batch against one deployment and protocol. Every probe that
 * fails becomes an outcome, never an exception: a deployment that cannot stream
 * is a finding, not a broken run. Six of the eight requests are billable.
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
          `the runtime credential was refused: HTTP ${minimal.status}${minimal.failure ? ` (${minimal.failure})` : apiMessage(minimal)}`,
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
      ? outcome("protocol.non-streaming", "unsupported", `HTTP ${minimal.status}${minimal.failure ? ` (${minimal.failure})` : apiMessage(minimal)}`, [minimal.requestId])
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
      ? outcome("protocol.streaming-order", "unsupported", `HTTP ${streamed.status}${streamed.failure ? ` (${streamed.failure})` : apiMessage(streamed)}`, [streamed.requestId])
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
        ? outcome("protocol.cancellation", "unsupported", `HTTP ${cancelled.status}${cancelled.failure ? ` (${cancelled.failure})` : apiMessage(cancelled)}`, [cancelled.requestId])
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
            `an invalid request returned HTTP ${invalid.status}${invalid.failure ? ` (${invalid.failure})` : apiMessage(invalid)}`,
            [invalid.requestId],
          ),
  );

  const tool = collect(await jsonProbe(options, toolBody(options)));
  const toolArgs = toolArguments(options.protocol, tool.body);
  outcomes.push(
    !tool.ok
      ? outcome("agent.single-tool-call", "unsupported", `HTTP ${tool.status}${tool.failure ? ` (${tool.failure})` : apiMessage(tool)}`, [tool.requestId])
      : toolArgs === undefined
        ? outcome("agent.single-tool-call", "unsupported", "the model answered without calling the offered tool", [tool.requestId])
        : typeof toolArgs.city === "string"
          ? outcome("agent.single-tool-call", "supported", "the tool was called with arguments matching the declared schema", [tool.requestId])
          : outcome("agent.single-tool-call", "partial", "a tool call came back with arguments that do not match the declared schema", [tool.requestId]),
  );

  const forced = collect(await jsonProbe(options, forcedToolBody(options)));
  const forcedArgs = toolArguments(options.protocol, forced.body);
  outcomes.push(
    !forced.ok
      ? outcome(
          "agent.forced-tool-choice",
          "unsupported",
          `HTTP ${forced.status}${forced.failure ? ` (${forced.failure})` : apiMessage(forced)}`,
          [forced.requestId],
        )
      : forcedArgs === undefined
        // Accepted the parameter and ignored it. Worth telling apart from a
        // refusal: the request succeeds, so a caller relying on the forced call
        // gets prose back and no error.
        ? outcome(
            "agent.forced-tool-choice",
            "partial",
            "the forced tool_choice was accepted but the model answered without calling the tool",
            [forced.requestId],
          )
        : outcome(
            "agent.forced-tool-choice",
            "supported",
            "the named tool was forced and called",
            [forced.requestId],
          ),
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
      ? outcome("agent.structured-output", "unsupported", `HTTP ${structured.status}${structured.failure ? ` (${structured.failure})` : apiMessage(structured)}`, [structured.requestId])
      : schemaHonoured
        ? outcome(
            "agent.structured-output",
            "supported",
            options.protocol === "anthropic-messages"
              ? "the schema was honoured through a tool, which is what this protocol offers"
              : "the response followed the requested JSON schema",
            [structured.requestId],
          )
        : outcome(
            "agent.structured-output",
            "unsupported",
            structuredValue === undefined
              ? options.protocol === "anthropic-messages"
                ? "the response carried no tool call to hold the schema"
                : "the response body did not parse as JSON at all"
              : "the response parsed as JSON but did not match the requested fields",
            [structured.requestId],
          ),
  );

  return {
    suite: { id: CAPABILITY_SUITE_ID, version: CAPABILITY_SUITE_VERSION },
    outcomes,
    requestIds,
    // The invalid request is refused after authentication and does get a
    // not-billable ledger row; the rejected credential never reaches an
    // account, so nothing is ever written for it.
    preAuthRequestIds: rejected.requestId === undefined ? [] : [rejected.requestId],
    // The rejected credential and the invalid request are refused before inference.
    billableRequests: 6,
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
