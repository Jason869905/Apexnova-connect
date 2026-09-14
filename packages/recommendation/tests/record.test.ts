import { describe, expect, it } from "vitest";

import recommendationSchema from "@apexnova-connect/schemas/recommendation" with { type: "json" };
import {
  CAPABILITY_DEFINITIONS,
  createEvidence,
  type CapabilitySupport,
  type CompatibilityEvidence,
  type EvidenceSubject,
} from "@apexnova-connect/capabilities";

import {
  CODING_GENERAL,
  RECOMMENDATION_SCHEMA_VERSION,
  RecommendationError,
  recommend,
  recommendationRecord,
  validateRecommendation,
  type RecommendOptions,
  type RecommendationCandidate,
} from "../src/index.js";

const NOW = new Date("2026-09-20T10:00:00.000Z");
const OBSERVED_AT = "2026-09-15T10:00:00.000Z";

const subject: EvidenceSubject = {
  agentId: "opencode",
  agentVersion: "1.18.29",
  integrationId: "opencode",
  integrationVersion: "0.1.0",
  deploymentId: "model.cheap",
  protocol: "openai-responses",
  platform: "linux-x64",
};

function evidenceFor(
  modelId: string,
  overrides: Readonly<Record<string, CapabilitySupport>> = {},
): CompatibilityEvidence {
  return createEvidence({
    sourceType: "maintainer-test",
    subject: { ...subject, deploymentId: modelId },
    observedAt: OBSERVED_AT,
    outcomes: CAPABILITY_DEFINITIONS.map((definition) => ({
      capabilityId: definition.id,
      support: overrides[definition.id] ?? "supported",
    })),
  });
}

function candidate(modelId: string): RecommendationCandidate {
  return {
    modelId,
    displayName: modelId,
    protocols: ["openai-responses"],
    availability: "available",
    pricing: { currency: "USD", billingMode: "token", unit: 1_000_000, input: "0.6", output: "2.2" },
    contextWindow: 128_000,
  };
}

function options(overrides: Partial<RecommendOptions> = {}): RecommendOptions {
  return {
    scenario: CODING_GENERAL,
    agentId: "opencode",
    agentVersion: "1.18.29",
    integrationId: "opencode",
    integrationVersion: "0.1.0",
    platform: "linux-x64",
    agentProtocols: ["openai-responses"],
    catalogVersion: "cat_1",
    candidates: [candidate("model.cheap")],
    evidence: [evidenceFor("model.cheap")],
    now: NOW,
    ...overrides,
  };
}

describe("recommendationRecord", () => {
  it("emits exactly the fields the frozen schema allows, and no others", () => {
    const record = recommendationRecord(recommend(options()));

    expect(validateRecommendation(record)).toMatchObject({ valid: true });
    // The drift this replaces was silent because nothing compared the two. The
    // published object is checked against the schema's own property list, so a
    // field invented in code fails here rather than in whatever reads it.
    const allowed = new Set(Object.keys(recommendationSchema.properties));
    expect(Object.keys(record).filter((key) => !allowed.has(key))).toEqual([]);
    const candidateProperties = recommendationSchema.properties.candidates.items.properties;
    const allowedCandidate = new Set(Object.keys(candidateProperties));
    for (const entry of record.candidates) {
      expect(Object.keys(entry).filter((key) => !allowedCandidate.has(key))).toEqual([]);
    }
  });

  it("names the Scenario profile that produced it, not just the Scenario", () => {
    const record = recommendationRecord(recommend(options()));

    expect(record).toMatchObject({
      schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
      scenarioId: "coding-general",
      profileVersion: CODING_GENERAL.profileVersion,
    });

    // Two profiles of one Scenario require different capabilities and order the
    // priorities differently. Without this field both documents say
    // "coding-general, coding.v1" and nothing distinguishes the requirement sets
    // they rest on -- the same identity gap the evidence subject already closed.
    const revised = recommendationRecord(
      recommend(options({ scenario: { ...CODING_GENERAL, profileVersion: "2.0.0" } })),
    );
    expect(revised.profileVersion).toBe("2.0.0");
    expect(revised.id).not.toBe(record.id);
  });

  it("refuses a record with no profile version, now that the schema requires one", () => {
    const record = recommendationRecord(recommend(options()));
    const { profileVersion: _dropped, ...without } = record;

    expect(validateRecommendation(without)).toMatchObject({ valid: false });
  });

  it("carries the platform and each dimension's numbers into reasons", () => {
    const record = recommendationRecord(recommend(options()));

    const reasons = record.candidates[0]!.reasons.join("\n");
    // The schema has no field for either, and dropping them would leave a rank
    // with nothing behind it.
    expect(reasons).toContain("linux-x64");
    expect(reasons).toContain("compatibility scored 1.00 at weight");
  });

  it("carries an unmeasured priority at the top level, once, not once per model", () => {
    const scenario = { ...CODING_GENERAL, priorities: ["compatibility", "quality", "cost"] as const };
    const result = recommend(options({ scenario: { ...scenario, priorities: [...scenario.priorities] } }));

    expect(result.unmeasured.map((entry) => entry.priority)).toContain("quality");
    // It is a property of the ranking, and schemaVersion 0.3 gave it a field of
    // its own. It used to be copied into every candidate's `reasons`, the only
    // field that survived `additionalProperties: false` -- forty-six models each
    // repeating the same sentences.
    const record = recommendationRecord(result);
    expect(record.unmeasured?.map((entry) => entry.priority)).toContain("quality");
    expect(record.unmeasured?.every((entry) => entry.why.length > 0)).toBe(true);
    expect(record.candidates[0]!.reasons.join("\n")).not.toContain("Not measured");
  });

  it("puts what a reader asks of a ranking on the candidate itself", () => {
    const published = {
      ...candidate("model.cheap"),
      publisher: "DeepSeek",
    };
    const record = recommendationRecord(recommend(options({ candidates: [published] })));

    // Rank, model, who publishes it, what it costs, what it scored: the five
    // things the ranking is read for used to need the catalog beside it.
    expect(record.candidates[0]).toMatchObject({
      rank: 1,
      modelId: "model.cheap",
      publisher: "DeepSeek",
      basis: "evidence",
      currency: "USD",
    });
    expect(record.candidates[0]!.pricePerMillion).toBeCloseTo(1, 6);
    expect(record.candidates[0]!.score).toBeGreaterThan(0);
    expect(validateRecommendation(record)).toMatchObject({ valid: true });
  });

  it("expires with the first evidence it rests on", () => {
    const evidence = evidenceFor("model.cheap");
    const record = recommendationRecord(recommend(options({ evidence: [evidence] })));

    expect(record.expiresAt).toBe(evidence.expiresAt);
  });

  it("expires when the price it ranked on stops being the price", () => {
    // The catalog quotes some models by time of day. A ranking computed at
    // 17:00 on a number that doubles at 22:00 is not good for the four weeks its
    // evidence has left, and used to claim exactly that.
    const priced = {
      ...candidate("model.cheap"),
      pricing: {
        currency: "USD",
        billingMode: "token",
        unit: 1_000_000,
        input: "0.66",
        output: "1.98",
        priceValidUntil: "2026-09-20T22:00:00.000Z",
      },
    };
    const evidence = evidenceFor("model.cheap");
    const record = recommendationRecord(recommend(options({ candidates: [priced], evidence: [evidence] })));

    expect(evidence.expiresAt > "2026-09-20T22:00:00.000Z").toBe(true);
    expect(record.expiresAt).toBe("2026-09-20T22:00:00.000Z");
  });

  it("ignores the validity of a price it never read", () => {
    // No ceiling, no evidence for it, so this candidate's price decided nothing.
    const unused = {
      ...candidate("model.unreachable"),
      protocols: ["anthropic-messages"],
      pricing: {
        currency: "USD",
        billingMode: "token",
        unit: 1_000_000,
        input: "0.66",
        output: "1.98",
        priceValidUntil: "2026-09-20T22:00:00.000Z",
      },
    };
    const evidence = evidenceFor("model.cheap");
    const record = recommendationRecord(
      recommend(options({ candidates: [candidate("model.cheap"), unused], evidence: [evidence] })),
    );

    expect(record.expiresAt).toBe(evidence.expiresAt);
  });

  it("expires where it was created when it rests on nothing", () => {
    // No evidence, so nothing is cited. A window it cannot support would be a
    // claim about records that do not exist. The models are still ranked --
    // on Hub's catalog order, which is what `basis` says.
    const record = recommendationRecord(recommend(options({ evidence: [] })));

    expect(record.expiresAt).toBe(record.createdAt);
    expect(record.candidates.every((entry) => entry.evidenceRefs.length === 0)).toBe(true);
    expect(record.candidates.every((entry) => entry.basis === "catalog-order")).toBe(true);
  });

  it("gives the same ranking the same id, and a changed one a different id", () => {
    const first = recommendationRecord(recommend(options()));
    const second = recommendationRecord(recommend(options()));

    expect(first.id).toMatch(/^rec\.sha256\.[0-9a-f]{64}$/);
    expect(second.id).toBe(first.id);

    const changed = recommendationRecord(recommend(options({ catalogVersion: "cat_2" })));
    expect(changed.id).not.toBe(first.id);
  });

  it("records the constraints that were applied", () => {
    const constraints = { maxBlendedPricePerMillion: "5.0" };
    const record = recommendationRecord(recommend(options({ constraints })), constraints);

    expect(record.constraints).toEqual(constraints);
    expect(validateRecommendation(record)).toMatchObject({ valid: true });
  });

  it("refuses to publish a recommendation that considered nothing", () => {
    // `candidates` is minItems: 1. An empty ranking cannot be expressed, and
    // inventing one would assert a choice nobody made.
    const empty = recommend(options({ candidates: [] }));

    expect(empty.candidates).toEqual([]);
    expect(() => recommendationRecord(empty)).toThrowError(RecommendationError);
    expect(() => recommendationRecord(empty)).toThrowError(/considered nothing|no recommendation to record/i);
  });
});
