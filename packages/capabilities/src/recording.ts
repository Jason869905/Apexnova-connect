import { createHash } from "node:crypto";

import { CAPABILITY_SUITE_ID, CAPABILITY_SUITE_VERSION } from "./definitions.js";
import { CapabilityError } from "./evidence.js";
import type { SuiteProtocol } from "./suite.js";

/** Response headers a probe reads. Everything else is dropped rather than filtered. */
const RECORDED_HEADERS: readonly string[] = [
  "content-type",
  "x-apexnova-request-id",
  "x-apexnova-requested-model",
  "x-apexnova-deployment-id",
  "x-apexnova-provider-id",
];

const MAX_RECORDED_BYTES = 256 * 1024;

/** The credential a replay authenticates with; nothing real is ever recorded. */
export const REPLAY_CREDENTIAL = "replayed-credential";

const SECRET_PATTERNS: readonly RegExp[] = [
  /anrt_[A-Za-z0-9]{4,}/g,
  /\bsk-[A-Za-z0-9-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\b[A-Za-z0-9-_]{16,}\.[A-Za-z0-9-_]{16,}\.[A-Za-z0-9-_]{16,}\b/g,
];

export function redact(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[redacted]");
  return redacted;
}

export interface RecordedInteraction {
  readonly key: string;
  readonly authorized: boolean;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated?: boolean;
}

export interface CapabilityRecording {
  readonly version: 1;
  readonly recordedAt: string;
  readonly suite: { readonly id: string; readonly version: string };
  readonly endpoint: string;
  readonly protocol: SuiteProtocol;
  readonly model: string;
  readonly deploymentId: string;
  readonly interactions: readonly RecordedInteraction[];
}

/**
 * Identifies a request by what it asks for, not by when it was sent, so a
 * recording keeps replaying after the probes are reordered. The authorization
 * header never enters the key -- only whether it was the real credential, which
 * is what separates the auth probe from the one beside it.
 */
export function interactionKey(path: string, body: string, authorized: boolean): string {
  const digest = createHash("sha256").update(`${path}\n${body}`).digest("hex").slice(0, 32);
  return `${authorized ? "auth" : "unauth"}:${digest}`;
}

function requestKey(input: RequestInfo | URL, init: RequestInit | undefined, credential: string): string {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const authorized = headers.authorization === `Bearer ${credential}`;
  return interactionKey(url.pathname, String(init?.body ?? ""), authorized);
}

function recordedHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = redact(value);
  }
  return headers;
}

export interface RecordingFetch {
  readonly fetch: typeof globalThis.fetch;
  /** The interactions captured so far, in the order they happened. */
  readonly interactions: () => readonly RecordedInteraction[];
}

/**
 * Wraps a fetch so a real run leaves something replayable behind. Request
 * headers are never recorded -- that is where the credential lives -- and both
 * bodies and the headers that are kept go through the same redaction the
 * evidence store applies.
 */
export function createRecordingFetch(options: {
  readonly fetch?: typeof globalThis.fetch;
  readonly credential: string;
}): RecordingFetch {
  const interactions: RecordedInteraction[] = [];
  const inner = options.fetch ?? globalThis.fetch;

  const recording: typeof globalThis.fetch = async (input, init) => {
    const response = await inner(input, init);
    const raw = await response.text();
    const truncated = raw.length > MAX_RECORDED_BYTES;
    interactions.push({
      key: requestKey(input, init, options.credential),
      authorized: requestKey(input, init, options.credential).startsWith("auth:"),
      status: response.status,
      headers: recordedHeaders(response),
      body: redact(truncated ? raw.slice(0, MAX_RECORDED_BYTES) : raw),
      ...(truncated ? { truncated: true } : {}),
    });
    // The body was consumed to record it, so the caller gets an equivalent one.
    return new Response(raw, { status: response.status, headers: response.headers });
  };

  return { fetch: recording, interactions: () => interactions };
}

export function buildRecording(options: {
  readonly endpoint: string;
  readonly protocol: SuiteProtocol;
  readonly model: string;
  readonly deploymentId: string;
  readonly recordedAt: string;
  readonly interactions: readonly RecordedInteraction[];
}): CapabilityRecording {
  return {
    version: 1,
    recordedAt: options.recordedAt,
    suite: { id: CAPABILITY_SUITE_ID, version: CAPABILITY_SUITE_VERSION },
    endpoint: options.endpoint,
    protocol: options.protocol,
    model: options.model,
    deploymentId: options.deploymentId,
    interactions: options.interactions,
  };
}

function isRecordedInteraction(value: unknown): value is RecordedInteraction {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<RecordedInteraction>;
  return (
    typeof item.key === "string" &&
    typeof item.authorized === "boolean" &&
    Number.isInteger(item.status) &&
    typeof item.body === "string" &&
    typeof item.headers === "object" &&
    item.headers !== null
  );
}

export function parseRecording(value: unknown): CapabilityRecording {
  if (typeof value !== "object" || value === null) {
    throw new CapabilityError("INVALID_EVIDENCE", "Recording is not an object.");
  }
  const item = value as Partial<CapabilityRecording>;
  if (
    item.version !== 1 ||
    typeof item.endpoint !== "string" ||
    (item.protocol !== "openai-responses" && item.protocol !== "anthropic-messages") ||
    typeof item.model !== "string" ||
    typeof item.deploymentId !== "string" ||
    typeof item.recordedAt !== "string" ||
    !Array.isArray(item.interactions) ||
    !item.interactions.every(isRecordedInteraction)
  ) {
    throw new CapabilityError("INVALID_EVIDENCE", "Recording is not a valid capability recording.");
  }
  return item as CapabilityRecording;
}

/**
 * Serves a recording back to the suite. A request the recording does not cover
 * is an error rather than a miss: replaying part of a run and reporting the rest
 * as failures would turn a stale recording into findings about a deployment.
 */
export function createReplayFetch(recording: CapabilityRecording): typeof globalThis.fetch {
  const remaining = new Map<string, RecordedInteraction[]>();
  for (const interaction of recording.interactions) {
    const bucket = remaining.get(interaction.key);
    if (bucket) bucket.push(interaction);
    else remaining.set(interaction.key, [interaction]);
  }

  return async (input, init) => {
    const key = requestKey(input, init, REPLAY_CREDENTIAL);
    const next = remaining.get(key)?.shift();
    if (!next) {
      throw new CapabilityError(
        "RECORDING_INCOMPLETE",
        "The recording does not cover this request; re-record it against the deployment.",
      );
    }
    return new Response(next.body, { status: next.status, headers: { ...next.headers } });
  };
}
