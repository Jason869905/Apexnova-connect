import { SecretValue } from "@apexnova-connect/credential-store";

import { HubClientError } from "./errors.js";
import type { HubInferenceVerification } from "./types.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface VerifyHubInferenceOptions {
  readonly endpoint: string;
  readonly protocol: "openai-responses" | "openai-chat";
  readonly model: string;
  readonly deploymentId: string;
  readonly runtimeCredential: SecretValue;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly allowInsecureLoopback?: boolean;
  readonly loopbackHostAlias?: string;
  readonly signal?: AbortSignal;
}

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HubClientError("INVALID_RESPONSE", `Hub inference response is missing a valid ${name} header.`);
  }
  return value;
}

function validateOptions(options: VerifyHubInferenceOptions): URL {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch (cause) {
    throw new HubClientError("INVALID_CONFIG", "Hub inference endpoint is invalid.", { cause });
  }
  const insecureLoopback = endpoint.protocol === "http:" && isLoopback(endpoint);
  if (
    (endpoint.protocol !== "https:" && !(options.allowInsecureLoopback && insecureLoopback)) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash
  ) {
    throw new HubClientError("INVALID_CONFIG", "Hub inference endpoint must be HTTPS without credentials, query, or fragment.");
  }
  const expectedSuffix = options.protocol === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
  if (!endpoint.pathname.endsWith(expectedSuffix)) {
    throw new HubClientError("INVALID_CONFIG", `Hub inference endpoint does not match ${options.protocol}.`);
  }
  if (!options.model || options.model.length > 512 || !options.deploymentId || options.deploymentId.length > 256) {
    throw new HubClientError("INVALID_CONFIG", "Hub inference model or deployment is invalid.");
  }
  if (options.requestTimeoutMs !== undefined && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)) {
    throw new HubClientError("INVALID_CONFIG", "requestTimeoutMs must be positive.");
  }
  if (options.loopbackHostAlias !== undefined) {
    if (!options.allowInsecureLoopback || !endpoint.hostname.endsWith(".localhost") || !LOOPBACK_HOSTS.has(options.loopbackHostAlias)) {
      throw new HubClientError("INVALID_CONFIG", "loopbackHostAlias is only valid for a .localhost endpoint in loopback mode.");
    }
    endpoint.hostname = options.loopbackHostAlias;
  }
  return endpoint;
}

function requestBody(protocol: VerifyHubInferenceOptions["protocol"], model: string): unknown {
  return protocol === "openai-responses"
    ? { model, input: "Reply with exactly OK.", max_output_tokens: 8, stream: false, store: false }
    : { model, messages: [{ role: "user", content: "Reply with exactly OK." }], max_tokens: 8, stream: false };
}

function errorCode(status: number, apiCode: string | undefined) {
  if (status === 401) return "UNAUTHENTICATED" as const;
  if (status === 403) return "FORBIDDEN" as const;
  if (status === 404) return "NOT_FOUND" as const;
  if (status === 429) return "RATE_LIMITED" as const;
  if (status === 402 || apiCode === "insufficient_balance" || apiCode === "budget_exceeded") return "BILLING_BLOCKED" as const;
  return "API_ERROR" as const;
}

export async function verifyHubInference(options: VerifyHubInferenceOptions): Promise<HubInferenceVerification> {
  const endpoint = validateOptions(options);
  const timeoutSignal = AbortSignal.timeout(options.requestTimeoutMs ?? 120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.runtimeCredential.reveal()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody(options.protocol, options.model)),
      redirect: "error",
      signal,
    });
  } catch (cause) {
    throw new HubClientError("NETWORK_ERROR", "Hub live inference verification failed.", { cause, retryable: true });
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new HubClientError("INVALID_RESPONSE", "Hub inference response is too large.");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new HubClientError("INVALID_RESPONSE", "Hub inference response is too large.");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new HubClientError("INVALID_RESPONSE", "Hub inference response is not valid JSON.", { cause });
  }
  const requestId = response.headers.get("x-apexnova-request-id") ?? undefined;
  if (!response.ok) {
    const root = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const rawError = typeof root.error === "object" && root.error !== null ? root.error as Record<string, unknown> : {};
    const apiCode = typeof rawError.code === "string" ? rawError.code : undefined;
    const message = typeof rawError.message === "string" && rawError.message.length <= 2_048
      ? rawError.message
      : "Apexnova AI Hub rejected the inference verification request.";
    throw new HubClientError(errorCode(response.status, apiCode), message, {
      retryable: response.status >= 500 || response.status === 429,
      ...(requestId ? { requestId } : {}),
    });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HubClientError("INVALID_RESPONSE", "Hub inference response body is invalid.");
  }
  const root = body as Record<string, unknown>;
  if (options.protocol === "openai-responses") {
    if (typeof root.id !== "string" || !Array.isArray(root.output)) {
      throw new HubClientError("INVALID_RESPONSE", "Hub Responses API verification payload is invalid.");
    }
  } else if (typeof root.id !== "string" || !Array.isArray(root.choices)) {
    throw new HubClientError("INVALID_RESPONSE", "Hub Chat Completions verification payload is invalid.");
  }

  const verifiedRequestId = requiredHeader(response, "x-apexnova-request-id");
  const providerId = requiredHeader(response, "x-apexnova-provider-id");
  const requestedModel = requiredHeader(response, "x-apexnova-requested-model");
  const resolvedModel = requiredHeader(response, "x-apexnova-resolved-model");
  const deploymentId = requiredHeader(response, "x-apexnova-deployment-id");
  if (requestedModel !== options.model || deploymentId !== options.deploymentId) {
    throw new HubClientError("INVALID_RESPONSE", "Hub inference response does not match the requested model deployment.", { requestId: verifiedRequestId });
  }
  return {
    status: response.status,
    protocol: options.protocol,
    requestId: verifiedRequestId,
    providerId,
    requestedModel,
    resolvedModel,
    deploymentId,
  };
}
