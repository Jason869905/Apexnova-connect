import { evidenceContentHash } from "@apexnova-connect/capabilities";
import recommendationSchema from "@apexnova-connect/schemas/recommendation" with { type: "json" };
import commonDefinitions from "@apexnova-connect/schemas/common-definitions" with { type: "json" };
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import type { RecommendationConstraints, RecommendationResult } from "./recommend.js";

/**
 * The published Recommendation, exactly as `recommendation.schema.json` freezes
 * it. `recommend()` keeps a wider result for rendering -- display names, typed
 * dimensions, the platform -- the same split the compatibility matrix already
 * uses between its rows and the artifact it publishes.
 *
 * The schema is `additionalProperties: false` in both objects, so anything the
 * ranking wants to say that has no field of its own goes into `reasons`, which
 * is where ADR 0007 said it would go.
 */
export interface RecommendationRecordCandidate {
  readonly modelId: string;
  readonly rank: number;
  readonly eligible: boolean;
  readonly score?: number;
  readonly confidence?: number;
  readonly reasons: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly sponsored: boolean;
}

/**
 * Bumped from 0.1 when `profileVersion` became required. A document that must
 * name the profile behind it is not the same contract as one that need not, and
 * this field is how a reader tells which one they are holding.
 */
export const RECOMMENDATION_SCHEMA_VERSION = "0.2";

export interface RecommendationRecord {
  readonly schemaVersion: string;
  readonly id: string;
  readonly agentId: string;
  readonly scenarioId: string;
  readonly profileVersion: string;
  readonly catalogVersion: string;
  readonly ruleVersion: string;
  readonly constraints?: Readonly<Record<string, unknown>>;
  readonly priorities?: readonly string[];
  readonly candidates: readonly RecommendationRecordCandidate[];
  readonly summary?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export class RecommendationError extends Error {
  readonly code: "INVALID_RECOMMENDATION" | "NOTHING_CONSIDERED";

  constructor(code: "INVALID_RECOMMENDATION" | "NOTHING_CONSIDERED", message: string) {
    super(message);
    this.name = "RecommendationError";
    this.code = code;
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

let validate: ValidateFunction<RecommendationRecord> | undefined;

export interface RecommendationValidationIssue {
  readonly instancePath: string;
  readonly message: string;
}

export type RecommendationValidationResult =
  | { readonly valid: true; readonly value: RecommendationRecord }
  | { readonly valid: false; readonly errors: readonly RecommendationValidationIssue[] };

export function validateRecommendation(value: unknown): RecommendationValidationResult {
  validate ??= ajv.compile<RecommendationRecord>(recommendationSchema);
  if (validate(value)) return { valid: true, value };
  return {
    valid: false,
    errors: (validate.errors ?? []).map((error: ErrorObject) => ({
      instancePath: error.instancePath,
      message: error.message ?? "Schema validation failed.",
    })),
  };
}

export function assertRecommendation(value: unknown): asserts value is RecommendationRecord {
  const result = validateRecommendation(value);
  if (!result.valid) {
    throw new RecommendationError(
      "INVALID_RECOMMENDATION",
      `Invalid recommendation: ${result.errors
        .map((issue) => `${issue.instancePath || "/"}: ${issue.message}`)
        .join("; ")}.`,
    );
  }
}

/**
 * A dimension is a number, a weight and a sentence. The schema has no field for
 * the first two, so they are written into the sentence rather than dropped: a
 * ranking whose numbers are not on the page is the thing M4 exists not to ship.
 */
function dimensionLines(candidate: RecommendationResult["candidates"][number]): readonly string[] {
  return (candidate.dimensions ?? []).map(
    (dimension) =>
      `${dimension.priority} scored ${dimension.score.toFixed(2)} at weight ${dimension.weight.toFixed(2)}: ${dimension.detail}`,
  );
}

function candidateReasons(
  result: RecommendationResult,
  candidate: RecommendationResult["candidates"][number],
): readonly string[] {
  const heading = [
    `${candidate.displayName} on ${result.platform}`,
    ...(candidate.protocol === undefined ? [] : [`over ${candidate.protocol}`]),
  ].join(", ");
  return [
    heading,
    ...dimensionLines(candidate),
    ...candidate.reasons,
    // Not measured is a property of the ranking, not of one candidate, but the
    // schema has nowhere else that survives `additionalProperties: false`, and
    // a priority nothing measures has to reach whoever reads a candidate.
    ...result.unmeasured.map((entry) => `Not measured — ${entry.priority}: ${entry.why}`),
  ].map((reason) => (reason.length <= 500 ? reason : `${reason.slice(0, 497)}...`));
}

/**
 * Reshapes a ranking into the frozen record and refuses to hand back one that
 * does not validate. Nothing else in the codebase may build this object: the
 * reason the published shape drifted from the schema in the first place is that
 * it was assembled inline and checked by nobody.
 */
export function recommendationRecord(
  result: RecommendationResult,
  constraints?: RecommendationConstraints,
): RecommendationRecord {
  if (result.candidates.length === 0) {
    // `candidates` is `minItems: 1`. A run that considered nothing -- an empty
    // catalog, or `--model` naming something the catalog does not carry --
    // has no Recommendation to publish, and inventing an empty one would be a
    // document asserting a choice nobody made.
    throw new RecommendationError(
      "NOTHING_CONSIDERED",
      "No candidate was considered, so there is no recommendation to record.",
    );
  }

  const withoutId = {
    schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    agentId: result.agentId,
    scenarioId: result.scenarioId,
    profileVersion: result.profileVersion,
    catalogVersion: result.catalogVersion,
    ruleVersion: result.ruleVersion,
    ...(constraints === undefined || Object.keys(constraints).length === 0
      ? {}
      : { constraints: { ...constraints } }),
    priorities: [...result.priorities],
    candidates: result.candidates.map((candidate) => ({
      modelId: candidate.modelId,
      rank: candidate.rank,
      eligible: candidate.eligible,
      ...(candidate.score === undefined ? {} : { score: candidate.score }),
      ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
      reasons: candidateReasons(result, candidate),
      evidenceRefs: [...candidate.evidenceRefs],
      sponsored: candidate.sponsored,
    })),
    summary: result.summary.length <= 1200 ? result.summary : `${result.summary.slice(0, 1197)}...`,
    createdAt: result.createdAt,
    expiresAt: result.expiresAt,
  };

  // Content-addressed like evidence, and for the same reason: the same ranking
  // computed twice is the same document, and a document that changed is a
  // different id rather than a quiet edit.
  const record = {
    ...withoutId,
    id: `rec.sha256.${evidenceContentHash(withoutId)}`,
  };
  assertRecommendation(record);
  return record;
}
