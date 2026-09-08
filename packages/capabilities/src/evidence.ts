import { createHash } from "node:crypto";

import compatibilityEvidenceSchema from "@apexnova-connect/schemas/compatibility-evidence" with {
  type: "json",
};
import commonDefinitions from "@apexnova-connect/schemas/common-definitions" with {
  type: "json",
};
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import {
  CAPABILITY_SUITE_ID,
  CAPABILITY_SUITE_VERSION,
  capabilityDefinition,
} from "./definitions.js";

export type EvidenceSourceType =
  | "provider-claim"
  | "official-test"
  | "maintainer-test"
  | "community-test"
  | "runtime-observation";

export type EvidenceVerdict = "verified" | "compatible" | "partial" | "incompatible" | "unknown";

export type CapabilitySupport = "supported" | "partial" | "unsupported" | "unknown";

export interface EvidenceSubject {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly integrationId: string;
  readonly integrationVersion: string;
  readonly deploymentId: string;
  readonly protocol: string;
  readonly platform: string;
  readonly scenarioId?: string;
}

export interface CapabilityStatement {
  readonly capabilityId: string;
  readonly support: CapabilitySupport;
  readonly sourceType: EvidenceSourceType;
  readonly value?: unknown;
  readonly unit?: string;
  readonly evidenceRefs?: readonly string[];
  readonly observedAt?: string;
  readonly expiresAt?: string;
  readonly confidence?: number;
}

export interface EvidenceTestSuite {
  readonly id: string;
  readonly version: string;
  readonly environment?: string;
}

export interface EvidenceResult {
  readonly verdict: EvidenceVerdict;
  readonly passed: number;
  readonly failed: number;
  readonly summary?: string;
  readonly capabilities?: readonly CapabilityStatement[];
}

export interface CompatibilityEvidence {
  readonly schemaVersion: string;
  readonly id: string;
  readonly sourceType: EvidenceSourceType;
  readonly subject: EvidenceSubject;
  readonly testSuite: EvidenceTestSuite;
  readonly result: EvidenceResult;
  readonly artifactDigest?: string;
  readonly supersedes?: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature?: string;
}

export type CapabilityErrorCode =
  | "INVALID_EVIDENCE"
  | "UNKNOWN_CAPABILITY"
  | "EVIDENCE_IMMUTABLE"
  | "EVIDENCE_REDACTION_FAILED";

export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode;

  constructor(code: CapabilityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CapabilityError";
    this.code = code;
  }
}

export const EVIDENCE_SCHEMA_VERSION = "0.1";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Domain contracts are validated here rather than in the integration SDK: ADR
 * 0001 keeps the adapter delivery contract separate from the product domain
 * contracts, and evidence belongs to the second group.
 */
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: {
    "date-time": (value: string) => ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)),
  },
});
ajv.addSchema(commonDefinitions);

let validate: ValidateFunction<CompatibilityEvidence> | undefined;

export interface EvidenceValidationIssue {
  readonly instancePath: string;
  readonly message: string;
}

export type EvidenceValidationResult =
  | { readonly valid: true; readonly value: CompatibilityEvidence }
  | { readonly valid: false; readonly errors: readonly EvidenceValidationIssue[] };

export function validateCompatibilityEvidence(value: unknown): EvidenceValidationResult {
  validate ??= ajv.compile<CompatibilityEvidence>(compatibilityEvidenceSchema);
  if (validate(value)) return { valid: true, value };
  return {
    valid: false,
    errors: (validate.errors ?? []).map((error: ErrorObject) => ({
      instancePath: error.instancePath,
      message: error.message ?? "Schema validation failed.",
    })),
  };
}

export function assertCompatibilityEvidence(value: unknown): asserts value is CompatibilityEvidence {
  const result = validateCompatibilityEvidence(value);
  if (!result.valid) {
    throw new CapabilityError(
      "INVALID_EVIDENCE",
      `Invalid compatibility evidence: ${result.errors
        .map((issue) => `${issue.instancePath || "/"}: ${issue.message}`)
        .join("; ")}.`,
    );
  }
}

/**
 * Nothing a test run produces should ever contain a credential, so a record
 * that looks like it does is refused before it can reach disk. This is a guard
 * against a mistake upstream, not a substitute for not collecting secrets.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /anrt_[A-Za-z0-9]{4,}/,
  /\bsk-[A-Za-z0-9-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
  /\b[A-Za-z0-9-_]{16,}\.[A-Za-z0-9-_]{16,}\.[A-Za-z0-9-_]{16,}\b/,
];

export function assertRedacted(evidence: CompatibilityEvidence): void {
  const serialized = JSON.stringify(evidence);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new CapabilityError(
        "EVIDENCE_REDACTION_FAILED",
        "Evidence looks like it carries a credential; it was not stored.",
      );
    }
  }
}

/**
 * Key order must not change a record's identity, so every object is serialized
 * with its keys sorted, all the way down.
 */
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

function canonical(evidence: Omit<CompatibilityEvidence, "id">): string {
  return JSON.stringify(canonicalize(evidence));
}

/** Content-addressed, so writing the same run twice is idempotent rather than a conflict. */
export function evidenceId(evidence: Omit<CompatibilityEvidence, "id">): string {
  return `evidence.${createHash("sha256").update(canonical(evidence)).digest("hex").slice(0, 32)}`;
}

export function evidenceDigest(evidence: CompatibilityEvidence): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(evidence))).digest("hex")}`;
}

export function addDays(timestamp: string, days: number): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new CapabilityError("INVALID_EVIDENCE", `Timestamp is not a date-time: ${timestamp}.`);
  }
  return new Date(parsed + days * 86_400_000).toISOString();
}

export interface CapabilityOutcome {
  readonly capabilityId: string;
  readonly support: CapabilitySupport;
  readonly value?: unknown;
  readonly unit?: string;
  readonly confidence?: number;
}

export interface EvidenceInput {
  readonly sourceType: EvidenceSourceType;
  readonly subject: EvidenceSubject;
  readonly observedAt: string;
  readonly outcomes: readonly CapabilityOutcome[];
  readonly testSuite?: EvidenceTestSuite;
  readonly summary?: string;
  readonly artifactDigest?: string;
  readonly supersedes?: string;
}

/**
 * A record's verdict describes the run itself, over the levels the definitions
 * default to. The aggregate verdict for a subject is a separate computation
 * (`computeVerdict`), because that one answers a specific Agent's requirements
 * and has to account for records expiring at different times.
 */
function runVerdict(outcomes: readonly CapabilityOutcome[]): EvidenceVerdict {
  let partial = false;
  for (const outcome of outcomes) {
    const definition = capabilityDefinition(outcome.capabilityId);
    const required = definition?.defaultLevel === "required";
    if (outcome.support === "unsupported" && required) return "incompatible";
    if (outcome.support === "unknown" && required) return "unknown";
    if (outcome.support === "partial" || outcome.support === "unsupported") partial = true;
  }
  return partial ? "partial" : "verified";
}

export function createEvidence(input: EvidenceInput): CompatibilityEvidence {
  if (input.outcomes.length === 0) {
    throw new CapabilityError("INVALID_EVIDENCE", "Evidence must record at least one capability.");
  }

  const capabilities: CapabilityStatement[] = [];
  let earliestExpiry: string | undefined;
  for (const outcome of input.outcomes) {
    const definition = capabilityDefinition(outcome.capabilityId);
    if (!definition) {
      throw new CapabilityError(
        "UNKNOWN_CAPABILITY",
        `Capability ${outcome.capabilityId} is not in the registry; evidence cannot claim it.`,
      );
    }
    const expiresAt = addDays(input.observedAt, definition.ttlDays);
    if (earliestExpiry === undefined || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
    capabilities.push({
      capabilityId: outcome.capabilityId,
      support: outcome.support,
      sourceType: input.sourceType,
      ...(outcome.value === undefined ? {} : { value: outcome.value }),
      ...(outcome.unit === undefined ? {} : { unit: outcome.unit }),
      ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
      observedAt: input.observedAt,
      expiresAt,
    });
  }

  const withoutId: Omit<CompatibilityEvidence, "id"> = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    sourceType: input.sourceType,
    subject: input.subject,
    testSuite: input.testSuite ?? { id: CAPABILITY_SUITE_ID, version: CAPABILITY_SUITE_VERSION },
    result: {
      verdict: runVerdict(input.outcomes),
      passed: input.outcomes.filter((outcome) => outcome.support === "supported").length,
      failed: input.outcomes.filter((outcome) => outcome.support === "unsupported").length,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      capabilities,
    },
    ...(input.artifactDigest === undefined ? {} : { artifactDigest: input.artifactDigest }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    observedAt: input.observedAt,
    // The record as a whole stops supporting a live verdict when its
    // shortest-lived statement does; the statements keep their own expiry.
    expiresAt: earliestExpiry ?? input.observedAt,
  };

  const evidence: CompatibilityEvidence = { ...withoutId, id: evidenceId(withoutId) };
  assertCompatibilityEvidence(evidence);
  assertRedacted(evidence);
  return evidence;
}

function majorVersion(version: string): string {
  return version.split(".")[0] ?? version;
}

/**
 * Whether the suite that produced a record still stands. A different major is a
 * different suite, so its results do not carry; a record from some other suite
 * is not this registry's to retire.
 */
export function isSuiteCurrent(evidence: CompatibilityEvidence): boolean {
  if (evidence.testSuite.id !== CAPABILITY_SUITE_ID) return true;
  return majorVersion(evidence.testSuite.version) === majorVersion(CAPABILITY_SUITE_VERSION);
}

/**
 * Whether the record as a whole is still current -- its `expiresAt` is the
 * earliest of its statements, so this goes false as soon as any part of it
 * ages out. Individual statements keep their own TTL from the M0 freshness
 * table (`isStatementLive`): a 90-day protocol result is not thrown away
 * because it shared a run with a 30-day streaming test. Nothing here deletes:
 * an expired record is still reported, it just cannot support `compatible`.
 */
export function isEvidenceLive(evidence: CompatibilityEvidence, now: Date): boolean {
  return isSuiteCurrent(evidence) && Date.parse(evidence.expiresAt) > now.getTime();
}

export function isStatementLive(
  statement: CapabilityStatement,
  now: Date,
  fallbackExpiresAt?: string,
): boolean {
  const expiresAt = statement.expiresAt ?? fallbackExpiresAt;
  return expiresAt === undefined || Date.parse(expiresAt) > now.getTime();
}
