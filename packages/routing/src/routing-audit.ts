import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import routingAuditSchema from "@apexnova-connect/schemas/routing-audit" with { type: "json" };
import commonDefinitions from "@apexnova-connect/schemas/common-definitions" with { type: "json" };
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export const ROUTING_AUDIT_SCHEMA_VERSION = "0.1";

export type RoutingAuditEvent = "selected" | "attributed" | "released";

export type RoutingGrounds = "explicit" | "recommendation" | "existing" | "interactive" | "restore";

export interface RoutingAttributionShare {
  readonly apiKeyId: string;
  readonly apiKeyName?: string;
  readonly deploymentId?: string;
  readonly resolvedModel?: string;
  readonly requestCount: number;
}

export interface RoutingAttribution {
  /**
   * `unconfirmed` is not `confirmed`. Settlement lags, so a ledger with nothing
   * in it proves nothing, and saying so is the difference between an audit and
   * a reassurance.
   */
  readonly status: "confirmed" | "mismatched" | "unconfirmed";
  readonly requestCount?: number;
  readonly billedTo?: readonly RoutingAttributionShare[];
}

export interface RoutingAuditEntry {
  readonly schemaVersion: string;
  readonly id: string;
  readonly event: RoutingAuditEvent;
  readonly agentId: string;
  readonly integrationId?: string;
  readonly profile: string;
  readonly command?: string;
  readonly deploymentId?: string;
  readonly providerId?: string;
  readonly protocol?: string;
  readonly grounds?: RoutingGrounds;
  readonly recommendationId?: string;
  readonly catalogVersion?: string;
  readonly transactionId?: string;
  readonly changePlanId?: string;
  readonly credentialId?: string;
  readonly selectionId?: string;
  readonly attribution?: RoutingAttribution;
  readonly recordedAt: string;
}

export class RoutingAuditError extends Error {
  readonly code: "INVALID_AUDIT_ENTRY";

  constructor(message: string) {
    super(message);
    this.name = "RoutingAuditError";
    this.code = "INVALID_AUDIT_ENTRY";
  }
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: {
    "date-time": (value: string) => ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)),
  },
});
ajv.addSchema(commonDefinitions);

let validate: ValidateFunction<RoutingAuditEntry> | undefined;

export interface RoutingAuditIssue {
  readonly instancePath: string;
  readonly message: string;
}

export type RoutingAuditValidation =
  | { readonly valid: true; readonly value: RoutingAuditEntry }
  | { readonly valid: false; readonly errors: readonly RoutingAuditIssue[] };

export function validateRoutingAuditEntry(value: unknown): RoutingAuditValidation {
  validate ??= ajv.compile<RoutingAuditEntry>(routingAuditSchema);
  if (validate(value)) return { valid: true, value };
  return {
    valid: false,
    errors: (validate.errors ?? []).map((error: ErrorObject) => ({
      instancePath: error.instancePath,
      message: error.message ?? "Schema validation failed.",
    })),
  };
}

/** Key order must not change an entry's identity, so keys are sorted all the way down. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalize(source[key])]),
    );
  }
  return value;
}

function entryId(entry: Readonly<Record<string, unknown>>): string {
  const { id: _id, ...rest } = entry;
  const hash = createHash("sha256").update(JSON.stringify(canonicalize(rest)), "utf8").digest("hex");
  return `audit.sha256.${hash}`;
}

/**
 * Builds an entry and refuses to return one the frozen schema rejects. Nothing
 * else may assemble this object: the reason the published Recommendation drifted
 * from its schema was that it was built inline and checked by nobody.
 */
export function createRoutingAuditEntry(input: Omit<RoutingAuditEntry, "id" | "schemaVersion">): RoutingAuditEntry {
  const withoutId = { schemaVersion: ROUTING_AUDIT_SCHEMA_VERSION, ...input };
  const entry = { ...withoutId, id: entryId(withoutId) };
  const result = validateRoutingAuditEntry(entry);
  if (!result.valid) {
    throw new RoutingAuditError(
      `Invalid routing audit entry: ${result.errors
        .map((issue) => `${issue.instancePath || "/"}: ${issue.message}`)
        .join("; ")}.`,
    );
  }
  return entry;
}

export interface RoutingAuditLogOptions {
  readonly path: string;
}

/**
 * Append-only, one JSON entry per line. A decision and what it later cost are
 * two entries rather than one amended record: the second is not known when the
 * first is made, and rewriting the first would destroy the thing an audit is
 * for -- what was believed at the time it was believed.
 */
export class RoutingAuditLog {
  readonly #path: string;

  constructor(options: RoutingAuditLogOptions) {
    this.#path = options.path;
  }

  get path(): string {
    return this.#path;
  }

  async append(entry: RoutingAuditEntry): Promise<RoutingAuditEntry> {
    const result = validateRoutingAuditEntry(entry);
    if (!result.valid) {
      throw new RoutingAuditError("Refusing to append a routing audit entry that does not validate.");
    }
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  async list(): Promise<readonly RoutingAuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const entries: RoutingAuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A damaged line is reported by its absence rather than by taking the
        // rest of the log down with it; the log is evidence, not a database.
        continue;
      }
      const result = validateRoutingAuditEntry(parsed);
      if (result.valid) entries.push(result.value);
    }
    return entries;
  }
}

export function routingAuditPath(stateRoot: string): string {
  return join(stateRoot, "audit", "routing.jsonl");
}
