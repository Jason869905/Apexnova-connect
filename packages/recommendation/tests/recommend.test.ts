import { describe, expect, it } from "vitest";

import {
  CAPABILITY_DEFINITIONS,
  createEvidence,
  type CapabilitySupport,
  type CompatibilityEvidence,
  type EvidenceSubject,
} from "@apexnova-connect/capabilities";

import {
  CODING_GENERAL,
  assertScenarioIsSatisfiable,
  recommend,
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
  patch: Partial<EvidenceSubject> = {},
): CompatibilityEvidence {
  return createEvidence({
    sourceType: "maintainer-test",
    subject: { ...subject, deploymentId: modelId, ...patch },
    observedAt: OBSERVED_AT,
    outcomes: CAPABILITY_DEFINITIONS.map((definition) => ({
      capabilityId: definition.id,
      support: overrides[definition.id] ?? "supported",
    })),
  });
}

function candidate(
  modelId: string,
  overrides: Partial<Record<keyof RecommendationCandidate, unknown>> = {},
): RecommendationCandidate {
  const base = {
    modelId,
    displayName: modelId,
    protocols: ["openai-responses"],
    availability: "available",
    pricing: { currency: "USD", billingMode: "token", unit: 1_000_000, input: "0.6", output: "2.2" },
    contextWindow: 128_000,
    ...overrides,
  };
  // A candidate the catalog carries no price for has no `pricing` key at all,
  // which is not the same as one whose price is zero.
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined)) as unknown as RecommendationCandidate;
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

describe("recommend", () => {
  it("ranks a model whose required capabilities all passed, and says what carried it", () => {
    const result = recommend(options());

    expect(result.candidates).toHaveLength(1);
    const top = result.candidates[0]!;
    expect(top).toMatchObject({ rank: 1, eligible: true, protocol: "openai-responses", sponsored: false });
    expect(top.evidenceRefs.length).toBeGreaterThan(0);
    // Every scored dimension names its own number, so the ranking can be checked
    // rather than believed.
    expect(top.dimensions?.map((dimension) => dimension.priority)).toEqual(["compatibility", "cost", "context"]);
    expect(top.dimensions?.every((dimension) => dimension.detail.length > 0)).toBe(true);
    expect(result.ruleVersion).toBe("coding.v1");
  });

  it("reports the priorities nothing measures instead of scoring them", () => {
    const result = recommend(options({
      scenario: { ...CODING_GENERAL, priorities: ["quality", "compatibility", "cost", "latency"] },
    }));

    expect(result.unmeasured.map((entry) => entry.priority)).toEqual(["quality", "latency"]);
    expect(result.unmeasured.every((entry) => entry.why.length > 0)).toBe(true);
    // Unmeasured priorities carry no weight at all -- not a default one.
    expect(result.candidates[0]?.dimensions?.map((dimension) => dimension.priority)).toEqual(["compatibility", "cost"]);
    const weights = result.candidates[0]!.dimensions!.reduce((sum, dimension) => sum + dimension.weight, 0);
    expect(weights).toBeCloseTo(1, 10);
  });

  it("excludes a model whose required capability failed, rather than scoring it down", () => {
    const result = recommend(options({
      candidates: [candidate("model.cheap"), candidate("model.broken")],
      evidence: [
        evidenceFor("model.cheap"),
        // Cheapest possible and a required capability failed: no weighting may
        // rescue it.
        evidenceFor("model.broken", { "agent.single-tool-call": "unsupported" }),
      ],
    }));

    const broken = result.candidates.find((entry) => entry.modelId === "model.broken")!;
    expect(broken.eligible).toBe(false);
    expect(broken.score).toBeUndefined();
    expect(broken.reasons.join(" ")).toContain("agent.single-tool-call");
    // Ineligible candidates rank below every eligible one.
    expect(result.candidates[0]?.modelId).toBe("model.cheap");
  });

  it("refuses to answer for a platform it has no evidence for", () => {
    const result = recommend(options({ platform: "win32-x64" }));

    const only = result.candidates[0]!;
    expect(only.eligible).toBe(false);
    expect(only.reasons.join(" ")).toContain("win32-x64");
    expect(only.reasons.join(" ")).toContain("does not carry over");
    expect(result.summary).toContain("No model can be recommended");
  });

  it("does not treat evidence from a different implementation as current", () => {
    const result = recommend(options({
      candidates: [candidate("model.cheap", { implementationFingerprint: "impl-999999999999" })],
      evidence: [evidenceFor("model.cheap", {}, { implementationFingerprint: "impl-a1b2c3d4e5f6" })],
    }));

    expect(result.candidates[0]?.eligible).toBe(false);
    expect(result.candidates[0]?.reasons.join(" ")).toContain("No compatibility evidence");
  });

  it("prefers the cheaper model when compatibility ties, and says why", () => {
    const result = recommend(options({
      candidates: [
        candidate("model.dear", { pricing: { currency: "USD", billingMode: "token", unit: 1_000_000, input: "6", output: "18" } }),
        candidate("model.cheap"),
      ],
      evidence: [evidenceFor("model.cheap"), evidenceFor("model.dear")],
    }));

    expect(result.candidates.map((entry) => entry.modelId)).toEqual(["model.cheap", "model.dear"]);
    expect(result.candidates[0]?.dimensions?.find((dimension) => dimension.priority === "cost")?.detail)
      .toContain("per million blended");
  });

  it("scores one unpriced model at zero rather than assuming it is cheap", () => {
    const result = recommend(options({
      candidates: [candidate("model.cheap"), candidate("model.unpriced", { pricing: undefined })],
      evidence: [evidenceFor("model.cheap"), evidenceFor("model.unpriced")],
    }));

    const unpriced = result.candidates.find((entry) => entry.modelId === "model.unpriced")!;
    const cost = unpriced.dimensions!.find((dimension) => dimension.priority === "cost")!;
    expect(cost.score).toBe(0);
    expect(cost.detail).toContain("rather than being assumed cheap");
    expect(result.candidates[0]?.modelId).toBe("model.cheap");
  });

  it("drops cost entirely when nothing eligible has a price, and says so", () => {
    const result = recommend(options({
      candidates: [candidate("model.a", { pricing: undefined }), candidate("model.b", { pricing: undefined })],
      evidence: [evidenceFor("model.a"), evidenceFor("model.b")],
    }));

    // Scoring every candidate zero would keep cost's weight while carrying no
    // information; dropping it and reporting why is the honest equivalent of an
    // unmeasured priority.
    expect(result.unmeasured.map((entry) => entry.priority)).toContain("cost");
    expect(result.candidates[0]?.dimensions?.map((dimension) => dimension.priority)).toEqual(["compatibility", "context"]);
  });

  it("treats a published price of zero as free, now that null carries the absence", () => {
    // 12H was raised because the catalog quoted every model at 0, where it
    // could not be told apart from "no price published" and would have ranked
    // the dearest model first. Hub now publishes real prices and an explicit
    // null for the projections that carry none, so a published zero means what
    // it says -- one of the live ones is named "North Mini Code (free)".
    const free = { currency: "USD", billingMode: "token", unit: 1_000_000, input: "0", output: "0" };
    const result = recommend(options({
      candidates: [candidate("model.zero", { pricing: free }), candidate("model.cheap")],
      evidence: [evidenceFor("model.zero"), evidenceFor("model.cheap")],
    }));

    const zero = result.candidates.find((entry) => entry.modelId === "model.zero")!;
    const cost = zero.dimensions!.find((dimension) => dimension.priority === "cost")!;
    expect(cost.score).toBe(1);
    expect(cost.detail).toContain("0.0000 USD per million");
    // Free beats cheap on cost, and cost is enough to decide it here.
    expect(result.candidates[0]?.modelId).toBe("model.zero");
  });

  it("still refuses a price it cannot rank on", () => {
    // Absent and negative are not zero: neither is a statement anyone can rank.
    const negative = { currency: "USD", billingMode: "token", unit: 1_000_000, input: "-1", output: "-1" };
    const result = recommend(options({
      candidates: [candidate("model.negative", { pricing: negative })],
      evidence: [evidenceFor("model.negative")],
      constraints: { maxBlendedPricePerMillion: "5" },
    }));

    expect(result.candidates[0]?.eligible).toBe(false);
    expect(result.candidates[0]?.reasons[0]).toContain("no usable price");
  });

  it("excludes what the Agent cannot speak to, or the catalog has withdrawn", () => {
    const result = recommend(options({
      candidates: [
        candidate("model.other-protocol", { protocols: ["apexnova-media-videos"] }),
        candidate("model.down", { availability: "maintenance" }),
        candidate("model.cheap"),
      ],
      evidence: [evidenceFor("model.cheap")],
    }));

    const byId = new Map(result.candidates.map((entry) => [entry.modelId, entry]));
    expect(byId.get("model.other-protocol")?.eligible).toBe(false);
    expect(byId.get("model.other-protocol")?.reasons[0]).toContain("this Agent speaks");
    expect(byId.get("model.down")?.reasons[0]).toContain("maintenance");
  });

  it("honours a price ceiling as a filter with a stated reason", () => {
    const result = recommend(options({
      candidates: [candidate("model.dear", { pricing: { currency: "USD", billingMode: "token", unit: 1_000_000, input: "6", output: "18" } })],
      evidence: [evidenceFor("model.dear")],
      constraints: { maxBlendedPricePerMillion: "1" },
    }));

    expect(result.candidates[0]?.eligible).toBe(false);
    expect(result.candidates[0]?.reasons[0]).toContain("above the 1 ceiling");
  });

  it("refuses to count an unpriced model as inside a price ceiling", () => {
    // The catalog publishes zero for every model (12H), which `recommend`
    // reads as no price. Letting those through made `--max-price` match
    // everything while reading as "filtered to your budget": the ceiling had no
    // effect and nothing said so. Required capabilities already work this way --
    // unknown is not a pass -- and a budget is no different.
    const result = recommend(options({
      candidates: [candidate("model.unpriced", { pricing: undefined })],
      evidence: [evidenceFor("model.unpriced")],
      constraints: { maxBlendedPricePerMillion: "1" },
    }));

    expect(result.candidates[0]?.eligible).toBe(false);
    expect(result.candidates[0]?.reasons[0]).toContain("no usable price");
    expect(result.candidates[0]?.reasons[0]).toContain("Unknown is not within budget");
  });

  it("leaves an unpriced model alone when no ceiling was asked for", () => {
    const result = recommend(options({
      candidates: [candidate("model.unpriced", { pricing: undefined })],
      evidence: [evidenceFor("model.unpriced")],
    }));

    // Nothing was claimed about price, so nothing has to be proven about it.
    expect(result.candidates[0]?.eligible).toBe(true);
    expect(result.unmeasured.map((entry) => entry.priority)).toContain("cost");
  });

  it("names what actually excluded everything, rather than one fixed cause", () => {
    const result = recommend(options({
      candidates: [candidate("model.unpriced", { pricing: undefined })],
      evidence: [evidenceFor("model.unpriced")],
      constraints: { maxBlendedPricePerMillion: "1" },
    }));

    // The summary used to say "none with live evidence for every required
    // capability" however they were excluded, so a ceiling that removed
    // everything was reported as an evidence problem.
    expect(result.summary).toContain("none eligible");
    expect(result.summary).toContain("no usable price");
    expect(result.summary).not.toContain("live evidence");
  });

  it("does not call a dimension unmeasured on the strength of an empty set", () => {
    const result = recommend(options({
      candidates: [candidate("model.priced")],
      evidence: [evidenceFor("model.priced")],
      constraints: { maxBlendedPricePerMillion: "0.0001" },
    }));

    expect(result.candidates.every((entry) => !entry.eligible)).toBe(true);
    // Nothing eligible means no set to look in. "No eligible model has a
    // price" is vacuously true and would report every runtime dimension as
    // unmeasured; what happened is that nothing got that far, and the exclusion
    // reasons are where that belongs.
    expect(result.unmeasured.map((entry) => entry.priority)).not.toContain("cost");
    expect(result.unmeasured.map((entry) => entry.priority)).not.toContain("context");
  });

  it("excludes a publisher the run refuses, and says which", () => {
    const result = recommend(options({
      candidates: [
        candidate("model.cheap", { publisher: "Zhipu AI" }),
        candidate("model.other", { publisher: "DeepSeek" }),
      ],
      evidence: [evidenceFor("model.cheap"), evidenceFor("model.other")],
      constraints: { excludePublishers: ["zhipu ai"] },
    }));

    const byId = new Map(result.candidates.map((entry) => [entry.modelId, entry]));
    // Matched case-insensitively: nobody should have to guess the catalog's
    // capitalisation to keep their code away from a publisher.
    expect(byId.get("model.cheap")?.eligible).toBe(false);
    expect(byId.get("model.cheap")?.reasons[0]).toContain("Published by Zhipu AI");
    expect(byId.get("model.other")?.eligible).toBe(true);
  });

  it("will not pass a model whose publisher the catalog does not name", () => {
    const result = recommend(options({
      candidates: [candidate("model.cheap", { publisher: undefined })],
      evidence: [evidenceFor("model.cheap")],
      constraints: { excludePublishers: ["Anthropic"] },
    }));

    // Same rule as the price ceiling: it cannot be shown not to be the excluded
    // publisher, and a constraint that lets the unprovable through is not one.
    expect(result.candidates[0]?.eligible).toBe(false);
    expect(result.candidates[0]?.reasons[0]).toContain("does not name a publisher");
  });

  it("leaves an unnamed publisher alone when no publisher was excluded", () => {
    const result = recommend(options({
      candidates: [candidate("model.cheap", { publisher: undefined })],
      evidence: [evidenceFor("model.cheap")],
    }));

    expect(result.candidates[0]?.eligible).toBe(true);
  });

  it("considers only the models an allowlist names", () => {
    const result = recommend(options({
      candidates: [candidate("model.cheap"), candidate("model.other"), candidate("model.third")],
      evidence: [
        evidenceFor("model.cheap"),
        evidenceFor("model.other"),
        evidenceFor("model.third"),
      ],
      constraints: { modelIds: ["model.cheap", "model.third"] },
    }));

    // Not "ranked lower": the ones outside the list never entered, so they are
    // absent from the record rather than sitting in it as excluded.
    expect(result.candidates.map((entry) => entry.modelId)).toEqual([
      "model.cheap",
      "model.third",
    ]);
  });

  it("produces the same bytes twice for the same input", () => {
    const input = options({
      candidates: [candidate("model.b"), candidate("model.a"), candidate("model.c")],
      evidence: [evidenceFor("model.a"), evidenceFor("model.b"), evidenceFor("model.c")],
    });

    // Same score for all three, so only the tiebreak keeps the order stable.
    const first = JSON.stringify(recommend(input));
    const second = JSON.stringify(recommend({ ...input, candidates: [...input.candidates].reverse() }));

    expect(first).toBe(second);
    expect(JSON.parse(first).candidates.map((entry: { modelId: string }) => entry.modelId))
      .toEqual(["model.a", "model.b", "model.c"]);
  });

  it("keeps sponsorship out of the ranking", () => {
    const result = recommend(options());

    // The first batch has no sponsored placements, and the scorer has no input
    // for one: the exit condition holds because there is nothing to hide.
    expect(result.candidates.every((entry) => entry.sponsored === false)).toBe(true);
    expect(JSON.stringify(result.candidates[0]?.dimensions)).not.toContain("sponsor");
  });

  it("names every priority nothing measures, instead of leaving it off the list", () => {
    const result = recommend(options());

    // Dropping them from `priorities` scored them at zero without saying so,
    // which reads as "this Scenario does not care" rather than "nobody measured
    // it" -- the same substitution ADR 0007 refused when it refused a default
    // score. availability is here too: it filters candidates and scores none.
    expect(result.unmeasured.map((entry) => entry.priority)).toEqual([
      "availability",
      "latency",
      "quality",
      "privacy",
    ]);
    expect(result.unmeasured.every((entry) => entry.why.length > 0)).toBe(true);
  });

  it("gives an unmeasured priority no weight, so naming it cannot move the ranking", () => {
    const scoredOnly = { ...CODING_GENERAL, priorities: ["compatibility", "cost", "context"] as const };

    const withUnmeasured = recommend(options());
    const withoutThem = recommend(
      options({ scenario: { ...scoredOnly, priorities: [...scoredOnly.priorities] } }),
    );

    // `weightsFor` drops what nothing measures before it computes any weight, so
    // the two rankings have to agree on every number. If they ever stop
    // agreeing, naming a priority has started diluting the ones that are real.
    expect(withUnmeasured.candidates.map((entry) => entry.score)).toEqual(
      withoutThem.candidates.map((entry) => entry.score),
    );
    expect(withUnmeasured.candidates[0]?.dimensions).toEqual(withoutThem.candidates[0]?.dimensions);
  });

  it("only asks for capabilities the registry defines", () => {
    expect(() => assertScenarioIsSatisfiable(CODING_GENERAL)).not.toThrow();
    expect(() =>
      assertScenarioIsSatisfiable({
        ...CODING_GENERAL,
        requirements: [{ capabilityId: "agent.invented", level: "required" }],
      }),
    ).toThrowError(/not in the capability registry/);
  });
});
