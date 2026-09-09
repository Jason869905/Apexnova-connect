import { SecretValue } from "@apexnova-connect/credential-store";

import { HubClientError } from "./errors.js";
import type {
  ApiKeySummary,
  CreateApiKeyInput,
  CreatedApiKey,
  CreateRuntimeCredentialInput,
  CreatedRuntimeCredential,
  HubAccountSummary,
  HubBalance,
  HubCatalogDeployment,
  HubCatalogModel,
  HubCatalogProtocol,
  HubCatalogProvider,
  HubCatalogSnapshot,
  HubPricingEstimate,
  HubPricingUsage,
  HubEvidenceListResult,
  HubEvidenceQuery,
  HubEvidenceRecord,
  HubEvidenceSubmission,
  HubTestSuiteListResult,
  HubTestSuiteRegistration,
  HubTestSuiteVersion,
  HubUsageRecord,
  EvidenceFingerprintMatch,
  EvidenceSignatureStatus,
  EvidenceStaleReason,
  RegisterTestSuiteInput,
  RuntimeCredentialSummary,
  UpdateApiKeyInput,
  UsageAggregateRecord,
  UsageAggregateResult,
  UsageListResult,
  UsageQuery,
  UsageSettlementStatus,
} from "./types.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MONEY = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export interface HubControlPlaneClientOptions {
  readonly baseUrl: string;
  readonly accessToken: (signal?: AbortSignal) => Promise<SecretValue>;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly allowInsecureLoopback?: boolean;
  readonly apiPrefix?: string;
}

type JsonObject = Record<string, unknown>;

function isInsecureLoopback(url: URL): boolean {
  return url.protocol === "http:" && (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  );
}

function object(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(field);
  }
  return value as JsonObject;
}

function string(value: unknown, field: string, maximum = 2_048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\u0000")) {
    throw invalid(field);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field, 64);
  if (!Number.isFinite(Date.parse(result))) throw invalid(field);
  return result;
}

function money(value: unknown, field: string): string {
  const result = string(value, field, 128);
  if (!MONEY.test(result)) throw invalid(field);
  return result;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 10_000) throw invalid(field);
  return value.map((item, index) => string(item, `${field}[${index}]`, 512));
}

function array<T>(value: unknown, field: string, parse: (item: unknown, index: number) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > 10_000) throw invalid(field);
  return value.map(parse);
}

function invalid(field: string): HubClientError {
  return new HubClientError("INVALID_RESPONSE", `Apexnova AI Hub returned an invalid ${field}.`);
}

function safeHttpsUrl(value: unknown, field: string, allowInsecureLoopback: boolean): string {
  const raw = string(value, field);
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid(field); }
  if ((url.protocol !== "https:" && !(allowInsecureLoopback && isInsecureLoopback(url))) || url.username || url.password || url.search || url.hash) throw invalid(field);
  return url.toString().replace(/\/$/, "");
}

function parseProvider(value: unknown): HubCatalogProvider {
  const item = object(value, "provider");
  const kind = string(item.kind, "provider.kind", 32);
  if (kind !== "platform") throw invalid("provider.kind");
  return {
    id: string(item.id, "provider.id", 256),
    name: string(item.name, "provider.name", 256),
    kind,
  };
}

function parseModel(value: unknown): HubCatalogModel {
  const item = object(value, "model");
  return {
    id: string(item.id, "model.id", 256),
    name: string(item.name, "model.name", 256),
    ...(item.publisher === undefined ? {} : { publisher: string(item.publisher, "model.publisher", 256) }),
    ...(item.publisherName === undefined ? {} : { publisherName: string(item.publisherName, "model.publisherName", 256) }),
    modelType: string(item.modelType, "model.modelType", 64),
    capabilities: strings(item.capabilities, "model.capabilities"),
    deploymentIds: strings(item.deploymentIds, "model.deploymentIds"),
  };
}

function parseProtocol(value: unknown, allowInsecureLoopback: boolean): HubCatalogProtocol {
  const item = object(value, "deployment.protocol");
  return {
    protocol: string(item.protocol, "deployment.protocol.protocol", 128),
    baseUrl: safeHttpsUrl(item.baseUrl, "deployment.protocol.baseUrl", allowInsecureLoopback),
  };
}

function parseDeployment(value: unknown, allowInsecureLoopback: boolean): HubCatalogDeployment {
  const item = object(value, "deployment");
  const availabilityObject = object(item.availability, "deployment.availability");
  const availability = string(availabilityObject.status, "deployment.availability.status", 32);
  if (!["available", "degraded", "maintenance", "unavailable"].includes(availability)) {
    throw invalid("deployment.availability.status");
  }
  const protocols = array(item.protocols, "deployment.protocols", (protocol) => parseProtocol(protocol, allowInsecureLoopback));
  if (protocols.length === 0) throw invalid("deployment.protocols");
  return {
    id: string(item.id, "deployment.id", 256),
    providerId: string(item.providerId, "deployment.providerId", 256),
    modelId: string(item.modelId, "deployment.modelId", 256),
    displayName: string(item.displayName, "deployment.displayName", 256),
    inferenceAlias: string(item.inferenceAlias, "deployment.inferenceAlias", 512),
    aliases: item.aliases === undefined ? [] : strings(item.aliases, "deployment.aliases"),
    protocols,
    // Both are null in the ordinary case -- no upstream line enabled, or no
    // implementation change ever observed -- so null has to read as absent.
    // Refusing it would make every catalog fetch fail on a deployment nobody
    // has changed.
    ...(item.implementationFingerprint === undefined || item.implementationFingerprint === null
      ? {}
      : { implementationFingerprint: string(item.implementationFingerprint, "deployment.implementationFingerprint", 128) }),
    ...(item.implementationChangedAt === undefined || item.implementationChangedAt === null
      ? {}
      : { implementationChangedAt: timestamp(item.implementationChangedAt, "deployment.implementationChangedAt") }),
    ...(item.limits === undefined ? {} : { limits: (() => {
      const limits = object(item.limits, "deployment.limits");
      const integer = (value: unknown, field: string) => {
        if (value === null || value === undefined) return undefined;
        if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalid(field);
        return value as number;
      };
      const contextWindow = integer(limits.contextWindow, "deployment.limits.contextWindow");
      const maxOutputTokens = integer(limits.maxOutputTokens, "deployment.limits.maxOutputTokens");
      return { ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}) };
    })() }),
    capabilities: strings(item.capabilities, "deployment.capabilities"),
    availability: {
      status: availability as HubCatalogDeployment["availability"]["status"],
      ...(availabilityObject.observedAt === null || availabilityObject.observedAt === undefined ? {} : { observedAt: timestamp(availabilityObject.observedAt, "deployment.availability.observedAt") }),
      ...(availabilityObject.source === undefined ? {} : { source: string(availabilityObject.source, "deployment.availability.source", 256) }),
    },
  };
}

const SETTLEMENT_STATUSES: readonly UsageSettlementStatus[] = ["pending", "settled", "not-billable", "failed"];

function settlementStatus(value: unknown): UsageSettlementStatus {
  const status = string(value, "usage record.settlementStatus", 32);
  if (!SETTLEMENT_STATUSES.includes(status as UsageSettlementStatus)) throw invalid("usage record.settlementStatus");
  return status as UsageSettlementStatus;
}

function apiKeyKind(value: unknown): "user" | "runtime" {
  const kind = string(value, "usage record.apiKeyKind", 32);
  if (kind !== "user" && kind !== "runtime") throw invalid("usage record.apiKeyKind");
  return kind;
}

function parseUsageRecord(value: unknown): HubUsageRecord {
  const item = object(value, "usage record");
  // Null until billing settles: whether a request succeeded is only known once
  // there is a usage record behind it, so `pending` and `failed` carry no status.
  const status = item.status === null || item.status === undefined
    ? undefined
    : string(item.status, "usage record.status", 32);
  if (status !== undefined && status !== "success" && status !== "error") throw invalid("usage record.status");
  const usage = object(item.usage, "usage record.usage");
  const integer = (value: unknown, field: string): number | undefined => {
    if (value === null || value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(field);
    return value as number;
  };
  const statusCode = integer(item.statusCode, "usage record.statusCode");
  const inputTokens = integer(usage.inputTokens, "usage record.usage.inputTokens");
  const outputTokens = integer(usage.outputTokens, "usage record.usage.outputTokens");
  const cachedInputTokens = integer(usage.cachedInputTokens, "usage record.usage.cachedInputTokens");
  const usageItems = integer(usage.items, "usage record.usage.items");
  return {
    id: string(item.id, "usage record.id", 256),
    requestId: string(item.requestId, "usage record.requestId", 512),
    at: timestamp(item.at, "usage record.at"),
    ...(status === undefined ? {} : { status }),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(item.requestedModel === null || item.requestedModel === undefined ? {} : { requestedModel: string(item.requestedModel, "usage record.requestedModel", 512) }),
    ...(item.requestedDeploymentId === null || item.requestedDeploymentId === undefined ? {} : { requestedDeploymentId: string(item.requestedDeploymentId, "usage record.requestedDeploymentId", 256) }),
    resolvedModel: string(item.resolvedModel, "usage record.resolvedModel", 512),
    ...(item.resolvedDeploymentId === null || item.resolvedDeploymentId === undefined ? {} : { resolvedDeploymentId: string(item.resolvedDeploymentId, "usage record.resolvedDeploymentId", 256) }),
    ...(item.fallbackApplied === undefined ? {} : typeof item.fallbackApplied === "boolean" ? { fallbackApplied: item.fallbackApplied } : (() => { throw invalid("usage record.fallbackApplied"); })()),
    ...(item.workspaceId === null || item.workspaceId === undefined ? {} : { workspaceId: string(item.workspaceId, "usage record.workspaceId", 256) }),
    source: string(item.source, "usage record.source", 64),
    usage: {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(usageItems === undefined ? {} : { items: usageItems }),
    },
    currency: string(item.currency, "usage record.currency", 3),
    // Null means unsettled, not free. Reading it as "0.000000" is exactly the
    // ambiguity gap (d) removed, so an absent amount stays absent here.
    ...(item.amount === null || item.amount === undefined ? {} : { amount: money(item.amount, "usage record.amount") }),
    ...(item.settlementStatus === null || item.settlementStatus === undefined ? {} : { settlementStatus: settlementStatus(item.settlementStatus) }),
    ...(item.abortedAt === null || item.abortedAt === undefined ? {} : { abortedAt: timestamp(item.abortedAt, "usage record.abortedAt") }),
    // Every money field on this record is nullable in the contract, and a null
    // in any one of them must not take the whole record down: rejecting the
    // record is indistinguishable, from the caller's side, from Hub never
    // having written it.
    ...(item.promoCovered === null || item.promoCovered === undefined ? {} : { promoCovered: money(item.promoCovered, "usage record.promoCovered") }),
    ...(item.balanceCovered === null || item.balanceCovered === undefined ? {} : { balanceCovered: money(item.balanceCovered, "usage record.balanceCovered") }),
    ...(item.discountRate === null || item.discountRate === undefined ? {} : { discountRate: money(item.discountRate, "usage record.discountRate") }),
    ...(item.apiKeyId === null || item.apiKeyId === undefined ? {} : { apiKeyId: string(item.apiKeyId, "usage record.apiKeyId", 256) }),
    ...(item.apiKeyName === null || item.apiKeyName === undefined ? {} : { apiKeyName: string(item.apiKeyName, "usage record.apiKeyName", 256) }),
    ...(item.apiKeyKind === null || item.apiKeyKind === undefined ? {} : { apiKeyKind: apiKeyKind(item.apiKeyKind) }),
  };
}

function parseApiKeySummary(value: unknown): ApiKeySummary {
  const item = object(value, "api key");
  const kind = string(item.kind, "api key.kind", 32);
  if (kind !== "user") throw invalid("api key.kind");
  return {
    id: string(item.id, "api key.id", 256),
    name: string(item.name, "api key.name", 256),
    prefix: string(item.prefix, "api key.prefix", 256),
    kind,
    ...(item.workspaceId === null || item.workspaceId === undefined ? {} : { workspaceId: string(item.workspaceId, "api key.workspaceId", 256) }),
    protocols: item.protocols === undefined ? [] : strings(item.protocols, "api key.protocols"),
    publicDeploymentIds: item.publicDeploymentIds === undefined ? [] : strings(item.publicDeploymentIds, "api key.publicDeploymentIds"),
    ...(item.expiresAt === null || item.expiresAt === undefined ? {} : { expiresAt: timestamp(item.expiresAt, "api key.expiresAt") }),
    createdAt: timestamp(item.createdAt, "api key.createdAt"),
    ...(item.lastUsedAt === null || item.lastUsedAt === undefined ? {} : { lastUsedAt: timestamp(item.lastUsedAt, "api key.lastUsedAt") }),
  };
}

function parseUsageAggregate(value: unknown): UsageAggregateRecord {
  const item = object(value, "usage aggregate");
  const integer = (v: unknown, field: string): number | undefined => {
    if (v === null || v === undefined) return undefined;
    if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid(field);
    return v as number;
  };
  const requestCount = integer(item.requestCount, "usage aggregate.requestCount") ?? 0;
  const inputTokens = integer(item.inputTokens, "usage aggregate.inputTokens");
  const outputTokens = integer(item.outputTokens, "usage aggregate.outputTokens");
  const cachedTokens = integer(item.cachedTokens, "usage aggregate.cachedTokens");
  return {
    bucketStart: timestamp(item.bucketStart, "usage aggregate.bucketStart"),
    ...(item.apiKeyId === null || item.apiKeyId === undefined ? {} : { apiKeyId: string(item.apiKeyId, "usage aggregate.apiKeyId", 256) }),
    ...(item.apiKeyName === null || item.apiKeyName === undefined ? {} : { apiKeyName: string(item.apiKeyName, "usage aggregate.apiKeyName", 256) }),
    ...(item.publicDeploymentId === null || item.publicDeploymentId === undefined ? {} : { publicDeploymentId: string(item.publicDeploymentId, "usage aggregate.publicDeploymentId", 256) }),
    ...(item.requestedModel === null || item.requestedModel === undefined ? {} : { requestedModel: string(item.requestedModel, "usage aggregate.requestedModel", 512) }),
    ...(item.resolvedModel === null || item.resolvedModel === undefined ? {} : { resolvedModel: string(item.resolvedModel, "usage aggregate.resolvedModel", 512) }),
    requestCount,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    normalCost: money(item.normalCost, "usage aggregate.normalCost"),
    ...(item.promoCost === undefined ? {} : { promoCost: money(item.promoCost, "usage aggregate.promoCost") }),
    currency: string(item.currency, "usage aggregate.currency", 3),
  };
}

const SIGNATURE_STATUSES: readonly EvidenceSignatureStatus[] = ["none", "unverified", "valid", "invalid"];
const STALE_REASONS: readonly EvidenceStaleReason[] = ["implementation-changed", "implementation-unknown", "suite-major-superseded"];
const FINGERPRINT_MATCHES: readonly EvidenceFingerprintMatch[] = ["match", "stale", "unknown", "absent"];

/** Hub writes `null` for "not set" throughout the compatibility blocks. */
function nullableString(value: unknown, field: string, max: number): string | undefined {
  return value === null || value === undefined ? undefined : string(value, field, max);
}

function nullableTimestamp(value: unknown, field: string): string | undefined {
  return value === null || value === undefined ? undefined : timestamp(value, field);
}

function nullableBoolean(value: unknown, field: string): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid(field);
  return value;
}

function nullableCount(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(field);
  return value as number;
}

function member<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw invalid(field);
  return value as T;
}

function present<T>(key: string, value: T | undefined): Record<string, T> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

function parseEvidenceRecord(value: unknown): HubEvidenceRecord {
  const item = object(value, "evidence record");
  const received = item.received === null || item.received === undefined ? {} : object(item.received, "evidence record.received");
  const derived = item.derived === null || item.derived === undefined ? {} : object(item.derived, "evidence record.derived");
  const fingerprint = derived.fingerprint === null || derived.fingerprint === undefined
    ? undefined
    : (() => {
        const view = object(derived.fingerprint, "evidence record.derived.fingerprint");
        return {
          ...present("subject", nullableString(view.subject, "evidence record.derived.fingerprint.subject", 128)),
          ...present("received", nullableString(view.received, "evidence record.derived.fingerprint.received", 128)),
          ...present("current", nullableString(view.current, "evidence record.derived.fingerprint.current", 128)),
          match: member(string(view.match, "evidence record.derived.fingerprint.match", 32), FINGERPRINT_MATCHES, "evidence record.derived.fingerprint.match")!,
        };
      })();
  return {
    id: string(item.id, "evidence record.id", 256),
    // Returned verbatim by contract, so it is carried through untouched rather
    // than re-parsed into a shape of ours.
    payload: object(item.payload, "evidence record.payload"),
    received: {
      ...present("receivedAt", nullableTimestamp(received.receivedAt, "evidence record.received.receivedAt")),
      ...present("submittedBy", nullableString(received.submittedBy, "evidence record.received.submittedBy", 256)),
      ...present("signatureStatus", member(nullableString(received.signatureStatus, "evidence record.received.signatureStatus", 32), SIGNATURE_STATUSES, "evidence record.received.signatureStatus")),
      ...present("payloadBytes", nullableCount(received.payloadBytes, "evidence record.received.payloadBytes")),
      ...present("implementationFingerprint", nullableString(received.implementationFingerprint, "evidence record.received.implementationFingerprint", 128)),
      ...present("revokedAt", nullableTimestamp(received.revokedAt, "evidence record.received.revokedAt")),
      ...present("revokedReason", nullableString(received.revokedReason, "evidence record.received.revokedReason", 1_024)),
    },
    derived: {
      ...present("recordExpired", nullableBoolean(derived.recordExpired, "evidence record.derived.recordExpired")),
      capabilityStatus: derived.capabilityStatus === null || derived.capabilityStatus === undefined
        ? []
        : array(derived.capabilityStatus, "evidence record.derived.capabilityStatus", (entry) => {
            const status = object(entry, "evidence record.derived.capabilityStatus[]");
            const expired = nullableBoolean(status.expired, "evidence record.derived.capabilityStatus[].expired");
            if (expired === undefined) throw invalid("evidence record.derived.capabilityStatus[].expired");
            return {
              ...present("capabilityId", nullableString(status.capabilityId, "evidence record.derived.capabilityStatus[].capabilityId", 256)),
              ...present("expiresAt", nullableTimestamp(status.expiresAt, "evidence record.derived.capabilityStatus[].expiresAt")),
              expired,
            };
          }),
      ...present("staleReason", member(nullableString(derived.staleReason, "evidence record.derived.staleReason", 64), STALE_REASONS, "evidence record.derived.staleReason")),
      ...present("supersededBy", nullableString(derived.supersededBy, "evidence record.derived.supersededBy", 256)),
      ...present("fingerprint", fingerprint),
      ...present("supportsCurrentVerdict", nullableBoolean(derived.supportsCurrentVerdict, "evidence record.derived.supportsCurrentVerdict")),
    },
  };
}

function parseTestSuiteVersion(value: unknown): HubTestSuiteVersion {
  const item = object(value, "test suite");
  if (!Number.isSafeInteger(item.majorVersion) || (item.majorVersion as number) < 0) throw invalid("test suite.majorVersion");
  return {
    suiteId: string(item.suiteId, "test suite.suiteId", 256),
    version: string(item.version, "test suite.version", 64),
    majorVersion: item.majorVersion as number,
    capabilityDigest: object(item.capabilityDigest, "test suite.capabilityDigest"),
    ttlTable: object(item.ttlTable, "test suite.ttlTable"),
    ...present("environment", nullableString(item.environment, "test suite.environment", 512)),
    registeredAt: timestamp(item.registeredAt, "test suite.registeredAt"),
  };
}

export class HubControlPlaneClient {
  readonly #baseUrl: URL;
  readonly #accessToken: HubControlPlaneClientOptions["accessToken"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestTimeoutMs: number;
  readonly #allowInsecureLoopback: boolean;
  readonly #apiPrefix: string;

  constructor(options: HubControlPlaneClientOptions) {
    try { this.#baseUrl = new URL(options.baseUrl); } catch (cause) {
      throw new HubClientError("INVALID_CONFIG", "Hub baseUrl is invalid.", { cause });
    }
    if ((this.#baseUrl.protocol !== "https:" && !(options.allowInsecureLoopback && isInsecureLoopback(this.#baseUrl))) || this.#baseUrl.username || this.#baseUrl.password || this.#baseUrl.pathname !== "/" || this.#baseUrl.search || this.#baseUrl.hash) {
      throw new HubClientError("INVALID_CONFIG", "Hub baseUrl must be an HTTPS origin.");
    }
    if (options.requestTimeoutMs !== undefined && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)) {
      throw new HubClientError("INVALID_CONFIG", "requestTimeoutMs must be positive.");
    }
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#allowInsecureLoopback = options.allowInsecureLoopback ?? false;
    this.#apiPrefix = options.apiPrefix ?? "";
  }

  #path(path: string): string {
    return `${this.#apiPrefix}${path}`;
  }

  async #request(path: string, init: { readonly method?: "GET" | "POST" | "PATCH" | "DELETE"; readonly body?: unknown; readonly signal?: AbortSignal } = {}): Promise<unknown> {
    return (await this.#send(path, init)).body;
  }

  /**
   * The status matters for the idempotent compatibility endpoints -- 201 means
   * Hub took the record, 200 means it already had it -- so the raw status is
   * kept here and `#request` drops it for everyone else.
   */
  async #send(path: string, init: { readonly method?: "GET" | "POST" | "PATCH" | "DELETE"; readonly body?: unknown; readonly signal?: AbortSignal } = {}): Promise<{ readonly status: number; readonly body: unknown }> {
    const token = await this.#accessToken(init.signal);
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(this.#requestTimeoutMs)]) : AbortSignal.timeout(this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token.reveal()}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: "error",
        signal,
      });
    } catch (cause) {
      throw new HubClientError("NETWORK_ERROR", "Apexnova AI Hub request failed.", { cause, retryable: true });
    }
    const requestId = response.headers.get("x-apexnova-request-id") ?? undefined;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw invalid("response size");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw invalid("response size");
    let body: unknown = null;
    if (bytes.byteLength > 0) {
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch (cause) { throw new HubClientError("INVALID_RESPONSE", "Hub response is not valid JSON.", { cause, ...(requestId ? { requestId } : {}) }); }
    }
    if (!response.ok) {
      const error = typeof body === "object" && body !== null ? (body as JsonObject).error : undefined;
      const api = typeof error === "object" && error !== null ? error as JsonObject : {};
      const apiCode = typeof api.code === "string" ? api.code : undefined;
      const message = typeof api.message === "string" && api.message.length <= 2_048 ? api.message : "Apexnova AI Hub rejected the request.";
      const retryable = typeof api.retryable === "boolean" ? api.retryable : response.status >= 500;
      const retryAfter = Number(response.headers.get("retry-after"));
      const code = response.status === 401 ? "UNAUTHENTICATED" : response.status === 403 && apiCode === "insufficient_scope" ? "INSUFFICIENT_SCOPE" : response.status === 403 && apiCode === "key_ttl_policy" ? "KEY_TTL_POLICY" : response.status === 403 ? "FORBIDDEN" : response.status === 404 ? "NOT_FOUND" : response.status === 429 ? "RATE_LIMITED" : apiCode === "insufficient_balance" || apiCode === "budget_exceeded" ? "BILLING_BLOCKED" : "API_ERROR";
      throw new HubClientError(code, message, {
        retryable,
        ...(apiCode ? { apiCode } : {}),
        ...(requestId ? { requestId } : {}),
        ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}),
      });
    }
    return { status: response.status, body };
  }

  async me(signal?: AbortSignal): Promise<HubAccountSummary> {
    const item = object(await this.#request(this.#path("/v1/me"), signal ? { signal } : {}), "account");
    const context = object(item.context, "account.context");
    const contextType = string(context.type, "account.context.type", 32);
    if (contextType !== "personal" && contextType !== "organization") throw invalid("account.context.type");
    const plan = item.plan === null || item.plan === undefined ? undefined : object(item.plan, "account.plan");
    const device = item.device === null || item.device === undefined ? undefined : object(item.device, "account.device");
    return {
      ...(item.accountId === null || item.accountId === undefined ? {} : { accountId: string(item.accountId, "account.accountId", 256) }),
      userId: string(item.userId, "account.userId", 256),
      displayName: string(item.displayName, "account.displayName", 256),
      ...(item.email === undefined ? {} : { email: string(item.email, "account.email", 320) }),
      ...(plan === undefined ? {} : { plan: { id: string(plan.id, "account.plan.id", 128), name: string(plan.name, "account.plan.name", 256) } }),
      defaultCurrency: string(item.defaultCurrency, "account.defaultCurrency", 3),
      createdAt: timestamp(item.createdAt, "account.createdAt"),
      context: {
        type: contextType,
        ...(context.organizationId === undefined ? {} : { organizationId: string(context.organizationId, "account.context.organizationId", 256) }),
        ...(context.role === undefined ? {} : { role: string(context.role, "account.context.role", 128) }),
        ...(context.readOnly === undefined ? {} : typeof context.readOnly === "boolean" ? { readOnly: context.readOnly } : (() => { throw invalid("account.context.readOnly"); })()),
      },
      ...(device?.id === undefined ? {} : { deviceId: string(device.id, "account.device.id", 256) }),
      scopes: strings(item.scopes, "account.scopes"),
    };
  }

  async balance(signal?: AbortSignal): Promise<HubBalance> {
    const item = object(await this.#request(this.#path("/v1/billing/balance"), signal ? { signal } : {}), "balance");
    return {
      currency: string(item.currency, "balance.currency", 3),
      normalBalance: money(item.normalBalance, "balance.normalBalance"),
      held: money(item.held, "balance.held"),
      normalAvailable: money(item.normalAvailable, "balance.normalAvailable"),
      promoCredits: array(item.promoCredits, "balance.promoCredits", (value) => {
        const promo = object(value, "promo credit");
        return { id: string(promo.id, "promo.id", 256), remaining: money(promo.remaining, "promo.remaining"), eligibleModelAliases: strings(promo.eligibleModelAliases, "promo.eligibleModelAliases"), ...(promo.expiresAt === null || promo.expiresAt === undefined ? {} : { expiresAt: timestamp(promo.expiresAt, "promo.expiresAt") }) };
      }),
      asOf: timestamp(item.asOf, "balance.asOf"),
      ...(item.eligiblePromo === undefined ? {} : { eligiblePromo: money(item.eligiblePromo, "balance.eligiblePromo") }),
      ...(item.effectiveAvailable === undefined ? {} : { effectiveAvailable: money(item.effectiveAvailable, "balance.effectiveAvailable") }),
    };
  }

  async usage(requestId: string, signal?: AbortSignal): Promise<HubUsageRecord | undefined> {
    if (!requestId || requestId.length > 512 || /[\u0000-\u001f\u007f]/.test(requestId)) {
      throw new HubClientError("INVALID_CONFIG", "requestId is invalid.");
    }
    const root = object(await this.#request(this.#path(`/v1/billing/usage?requestId=${encodeURIComponent(requestId)}`), signal ? { signal } : {}), "usage list");
    const items = array(root.items, "usage.items", parseUsageRecord);
    return items[0];
  }

  async estimatePricing(
    deploymentId: string,
    usage: HubPricingUsage,
    signal?: AbortSignal,
  ): Promise<HubPricingEstimate> {
    if (!deploymentId || deploymentId.length > 256) {
      throw new HubClientError("INVALID_CONFIG", "deploymentId is invalid.");
    }
    const item = object(await this.#request(this.#path("/v1/pricing/estimate"), {
      method: "POST",
      body: { deploymentId, usage },
      ...(signal ? { signal } : {}),
    }), "pricing estimate");
    if (item.estimateOnly !== true || item.deploymentId !== deploymentId) throw invalid("pricing estimate");
    return {
      deploymentId: string(item.deploymentId, "pricing estimate.deploymentId", 256),
      model: string(item.model, "pricing estimate.model", 512),
      currency: string(item.currency, "pricing estimate.currency", 3),
      billingMode: string(item.billingMode, "pricing estimate.billingMode", 64),
      listAmount: money(item.listAmount, "pricing estimate.listAmount"),
      ...(item.discountRate === undefined ? {} : { discountRate: money(item.discountRate, "pricing estimate.discountRate") }),
      ...(item.discount === undefined || item.discount === null ? {} : (() => {
        const discount = object(item.discount, "pricing estimate.discount");
        return {
          discount: {
            rate: money(discount.rate, "pricing estimate.discount.rate"),
            ...(discount.source === undefined || discount.source === null ? {} : { source: string(discount.source, "pricing estimate.discount.source", 256) }),
            ...(discount.appliesTo === undefined || discount.appliesTo === null ? {} : { appliesTo: string(discount.appliesTo, "pricing estimate.discount.appliesTo", 256) }),
            ...(discount.expiresAt === undefined || discount.expiresAt === null ? {} : { expiresAt: timestamp(discount.expiresAt, "pricing estimate.discount.expiresAt") }),
          },
        };
      })()),
      amount: money(item.amount, "pricing estimate.amount"),
      ...(item.priceVersion === undefined ? {} : { priceVersion: timestamp(item.priceVersion, "pricing estimate.priceVersion") }),
      estimateOnly: true,
    };
  }

  async catalog(signal?: AbortSignal): Promise<HubCatalogSnapshot> {
    const item = object(await this.#request(this.#path("/v1/catalog/snapshot"), signal ? { signal } : {}), "catalog snapshot");
    return {
      schemaVersion: string(item.schemaVersion, "catalog.schemaVersion", 32), catalogVersion: string(item.catalogVersion, "catalog.catalogVersion", 256),
      generatedAt: timestamp(item.generatedAt, "catalog.generatedAt"), expiresAt: timestamp(item.expiresAt, "catalog.expiresAt"),
      providers: array(item.providers, "catalog.providers", parseProvider), models: array(item.models, "catalog.models", parseModel), deployments: array(item.deployments, "catalog.deployments", (deployment) => parseDeployment(deployment, this.#allowInsecureLoopback)),
    };
  }

  async createRuntimeCredential(input: CreateRuntimeCredentialInput, signal?: AbortSignal): Promise<CreatedRuntimeCredential> {
    if (!input.name.trim() || input.protocols.length === 0 || input.publicDeploymentIds.length === 0 || (input.expiresIn !== undefined && (!Number.isSafeInteger(input.expiresIn) || input.expiresIn <= 0 || input.expiresIn > 86_400))) {
      throw new HubClientError("INVALID_CONFIG", "Runtime credential request is invalid.");
    }
    const item = object(await this.#request(this.#path("/v1/runtime-credentials"), { method: "POST", body: input, ...(signal ? { signal } : {}) }), "runtime credential response");
    return {
      credentialId: string(item.credentialId, "runtime credential.credentialId", 256),
      secret: SecretValue.from(string(item.secret, "runtime credential secret", 65_536)),
      expiresAt: timestamp(item.expiresAt, "runtime credential.expiresAt"),
      ...(item.workspaceId === null || item.workspaceId === undefined ? {} : { workspaceId: string(item.workspaceId, "runtime credential.workspaceId", 256) }),
      ...(item.deviceId === undefined ? {} : { deviceId: string(item.deviceId, "runtime credential.deviceId", 256) }),
    };
  }

  async runtimeCredentials(signal?: AbortSignal): Promise<readonly RuntimeCredentialSummary[]> {
    const root = object(await this.#request(this.#path("/v1/runtime-credentials"), signal ? { signal } : {}), "runtime credentials");
    return array(root.items, "runtime credentials.items", (value) => {
      const item = object(value, "runtime credential");
      return {
        credentialId: string(item.credentialId, "runtime credential.credentialId", 256),
        name: string(item.name, "runtime credential.name", 256),
        prefix: string(item.prefix, "runtime credential.prefix", 256),
        ...(item.deviceId === null || item.deviceId === undefined ? {} : { deviceId: string(item.deviceId, "runtime credential.deviceId", 256) }),
        ...(item.workspaceId === null || item.workspaceId === undefined ? {} : { workspaceId: string(item.workspaceId, "runtime credential.workspaceId", 256) }),
        protocols: strings(item.protocols, "runtime credential.protocols"),
        publicDeploymentIds: strings(item.publicDeploymentIds, "runtime credential.publicDeploymentIds"),
        ...(item.expiresAt === null || item.expiresAt === undefined ? {} : { expiresAt: timestamp(item.expiresAt, "runtime credential.expiresAt") }),
        createdAt: timestamp(item.createdAt, "runtime credential.createdAt"),
        ...(item.lastUsedAt === null || item.lastUsedAt === undefined ? {} : { lastUsedAt: timestamp(item.lastUsedAt, "runtime credential.lastUsedAt") }),
      };
    });
  }

  async revokeRuntimeCredential(id: string, signal?: AbortSignal): Promise<void> {
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new HubClientError("INVALID_CONFIG", "Runtime credential id is invalid.");
    await this.#request(this.#path(`/v1/runtime-credentials/${encodeURIComponent(id)}`), { method: "DELETE", ...(signal ? { signal } : {}) });
  }

  async createApiKey(input: CreateApiKeyInput, signal?: AbortSignal): Promise<CreatedApiKey> {
    if (!input.name.trim() || (input.expiresIn !== undefined && input.expiresIn !== null && (!Number.isSafeInteger(input.expiresIn) || input.expiresIn <= 0))) {
      throw new HubClientError("INVALID_CONFIG", "API key request is invalid.");
    }
    const body: Record<string, unknown> = { name: input.name, scopes: input.scopes ?? ["inference"] };
    if (input.workspaceId !== undefined) body.workspaceId = input.workspaceId;
    if (input.protocols !== undefined) body.protocols = input.protocols;
    if (input.publicDeploymentIds !== undefined) body.publicDeploymentIds = input.publicDeploymentIds;
    body.expiresIn = input.expiresIn ?? null;
    const item = object(await this.#request(this.#path("/v1/api-keys"), { method: "POST", body, ...(signal ? { signal } : {}) }), "api key response");
    const kind = string(item.kind, "api key.kind", 32);
    if (kind !== "user") throw invalid("api key.kind");
    return {
      id: string(item.id, "api key.id", 256),
      name: string(item.name, "api key.name", 256),
      prefix: string(item.prefix, "api key.prefix", 256),
      secret: SecretValue.from(string(item.secret, "api key secret", 65_536)),
      kind,
      ...(item.workspaceId === null || item.workspaceId === undefined ? {} : { workspaceId: string(item.workspaceId, "api key.workspaceId", 256) }),
      protocols: item.protocols === undefined ? [] : strings(item.protocols, "api key.protocols"),
      publicDeploymentIds: item.publicDeploymentIds === undefined ? [] : strings(item.publicDeploymentIds, "api key.publicDeploymentIds"),
      ...(item.expiresAt === null || item.expiresAt === undefined ? {} : { expiresAt: timestamp(item.expiresAt, "api key.expiresAt") }),
      createdAt: timestamp(item.createdAt, "api key.createdAt"),
      ...(item.lastUsedAt === null || item.lastUsedAt === undefined ? {} : { lastUsedAt: timestamp(item.lastUsedAt, "api key.lastUsedAt") }),
    };
  }

  async apiKeys(signal?: AbortSignal): Promise<readonly ApiKeySummary[]> {
    const root = object(await this.#request(this.#path("/v1/api-keys"), signal ? { signal } : {}), "api keys");
    return array(root.items, "api keys.items", parseApiKeySummary);
  }

  async apiKey(id: string, signal?: AbortSignal): Promise<ApiKeySummary> {
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new HubClientError("INVALID_CONFIG", "API key id is invalid.");
    return parseApiKeySummary(await this.#request(this.#path(`/v1/api-keys/${encodeURIComponent(id)}`), signal ? { signal } : {}));
  }

  async updateApiKey(id: string, input: UpdateApiKeyInput, signal?: AbortSignal): Promise<ApiKeySummary> {
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new HubClientError("INVALID_CONFIG", "API key id is invalid.");
    if (input.name === undefined && input.protocols === undefined && input.publicDeploymentIds === undefined && input.expiresIn === undefined) {
      throw new HubClientError("INVALID_CONFIG", "API key update is empty.");
    }
    if (input.expiresIn !== undefined && input.expiresIn !== null && (!Number.isSafeInteger(input.expiresIn) || input.expiresIn <= 0)) {
      throw new HubClientError("INVALID_CONFIG", "API key expiresIn is invalid.");
    }
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.protocols !== undefined) body.protocols = input.protocols;
    if (input.publicDeploymentIds !== undefined) body.publicDeploymentIds = input.publicDeploymentIds;
    if (input.expiresIn !== undefined) body.expiresIn = input.expiresIn;
    return parseApiKeySummary(await this.#request(this.#path(`/v1/api-keys/${encodeURIComponent(id)}`), { method: "PATCH", body, ...(signal ? { signal } : {}) }));
  }

  async revokeApiKey(id: string, signal?: AbortSignal): Promise<void> {
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new HubClientError("INVALID_CONFIG", "API key id is invalid.");
    await this.#request(this.#path(`/v1/api-keys/${encodeURIComponent(id)}`), { method: "DELETE", ...(signal ? { signal } : {}) });
  }

  /**
   * Submits one evidence record. Idempotent on the content hash: `created` is
   * false when Hub already held this exact record, which makes a retry after a
   * dropped connection safe. Hub is not allowed to alter the submission, so the
   * record comes back with its payload untouched beside Hub's own two blocks.
   */
  async submitCompatibilityEvidence(
    evidence: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<HubEvidenceSubmission> {
    const response = await this.#send(this.#path("/v1/compatibility/evidence"), {
      method: "POST",
      body: evidence,
      ...(signal ? { signal } : {}),
    });
    return { record: parseEvidenceRecord(response.body), created: response.status === 201 };
  }

  async compatibilityEvidence(query: HubEvidenceQuery = {}, signal?: AbortSignal): Promise<HubEvidenceListResult> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (key === "limit") {
        if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 200) {
          throw new HubClientError("INVALID_CONFIG", "limit must be 1..200.");
        }
        params.set(key, String(value));
        continue;
      }
      params.set(key, String(value));
    }
    const suffix = params.toString();
    const root = object(await this.#request(this.#path(`/v1/compatibility/evidence${suffix ? `?${suffix}` : ""}`), signal ? { signal } : {}), "evidence list");
    return {
      items: array(root.items, "evidence list.items", parseEvidenceRecord),
      ...(root.nextCursor === null || root.nextCursor === undefined ? {} : { nextCursor: string(root.nextCursor, "evidence list.nextCursor", 1_024) }),
    };
  }

  async compatibilityEvidenceById(evidenceId: string, signal?: AbortSignal): Promise<HubEvidenceRecord> {
    if (!evidenceId || evidenceId.length > 256 || /[^A-Za-z0-9._-]/.test(evidenceId)) {
      throw new HubClientError("INVALID_CONFIG", "evidenceId is invalid.");
    }
    return parseEvidenceRecord(await this.#request(this.#path(`/v1/compatibility/evidence/${encodeURIComponent(evidenceId)}`), signal ? { signal } : {}));
  }

  /**
   * Revocation keeps the record and writes why it was pulled. Hub requires the
   * reason, and revoking twice is the same outcome as revoking once -- the
   * first reason stands.
   */
  async revokeCompatibilityEvidence(evidenceId: string, reason: string, signal?: AbortSignal): Promise<HubEvidenceRecord> {
    if (!evidenceId || evidenceId.length > 256 || /[^A-Za-z0-9._-]/.test(evidenceId)) {
      throw new HubClientError("INVALID_CONFIG", "evidenceId is invalid.");
    }
    if (!reason.trim() || reason.length > 1_000) {
      throw new HubClientError("INVALID_CONFIG", "A revocation reason of 1..1000 characters is required.");
    }
    return parseEvidenceRecord(await this.#request(this.#path(`/v1/compatibility/evidence/${encodeURIComponent(evidenceId)}/revoke`), {
      method: "POST",
      body: { reason },
      ...(signal ? { signal } : {}),
    }));
  }

  /**
   * Registers what a suite version stands for. Idempotent on (suiteId,
   * version); re-registering a version with a different definition is refused,
   * because evidence already points at this version and editing it in place
   * would rewrite what those records mean.
   */
  async registerCompatibilityTestSuite(input: RegisterTestSuiteInput, signal?: AbortSignal): Promise<HubTestSuiteRegistration> {
    if (!input.suiteId.trim() || !input.version.trim()) {
      throw new HubClientError("INVALID_CONFIG", "suiteId and version are required.");
    }
    const response = await this.#send(this.#path("/v1/compatibility/test-suites"), {
      method: "POST",
      body: {
        suiteId: input.suiteId,
        version: input.version,
        capabilityDigest: input.capabilityDigest,
        ttlTable: input.ttlTable,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      },
      ...(signal ? { signal } : {}),
    });
    return { suite: parseTestSuiteVersion(response.body), created: response.status === 201 };
  }

  async compatibilityTestSuites(signal?: AbortSignal): Promise<HubTestSuiteListResult> {
    const root = object(await this.#request(this.#path("/v1/compatibility/test-suites"), signal ? { signal } : {}), "test suite list");
    return {
      items: array(root.items, "test suite list.items", parseTestSuiteVersion),
      ...(root.nextCursor === null || root.nextCursor === undefined ? {} : { nextCursor: string(root.nextCursor, "test suite list.nextCursor", 1_024) }),
    };
  }

  async usageQuery(query: UsageQuery, signal?: AbortSignal): Promise<UsageAggregateResult | UsageListResult> {
    const params = new URLSearchParams();
    if (query.requestId) {
      if (query.requestId.length > 512 || /[\u0000-\u001f\u007f]/.test(query.requestId)) throw new HubClientError("INVALID_CONFIG", "requestId is invalid.");
      params.set("requestId", query.requestId);
    }
    if (query.apiKeyId) params.set("apiKeyId", query.apiKeyId);
    if (query.workspaceId) params.set("workspaceId", query.workspaceId);
    if (query.model) params.set("model", query.model);
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    if (query.granularity) params.set("granularity", query.granularity);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit !== undefined) {
      if (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > 500) throw new HubClientError("INVALID_CONFIG", "limit must be 1..500.");
      params.set("limit", String(query.limit));
    }
    const root = object(await this.#request(this.#path(`/v1/billing/usage?${params.toString()}`), signal ? { signal } : {}), "usage query");
    const nextCursor = root.nextCursor === undefined || root.nextCursor === null ? undefined : string(root.nextCursor, "usage.nextCursor", 1_024);
    const asOf = root.asOf === undefined || root.asOf === null ? undefined : timestamp(root.asOf, "usage.asOf");
    if (query.granularity) {
      return {
        granularity: query.granularity,
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        items: array(root.items, "usage.items", parseUsageAggregate),
        ...(nextCursor ? { nextCursor } : {}),
        ...(asOf ? { asOf } : {}),
      } as UsageAggregateResult;
    }
    return {
      items: array(root.items, "usage.items", parseUsageRecord),
      ...(nextCursor ? { nextCursor } : {}),
      ...(asOf ? { asOf } : {}),
    } as UsageListResult;
  }
}
