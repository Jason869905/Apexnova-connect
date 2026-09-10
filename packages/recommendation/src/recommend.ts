import {
  computeVerdict,
  type CompatibilityEvidence,
  type EvidenceSubject,
} from "@apexnova-connect/capabilities";

import {
  SCORING_RULE,
  UNMEASURED_PRIORITIES,
  type ScenarioPriority,
  type ScenarioProfile,
} from "./scenarios.js";

export interface RecommendationPricing {
  readonly currency: string;
  readonly billingMode: string;
  readonly unit: number;
  readonly input: string;
  readonly output: string;
}

export interface RecommendationCandidate {
  readonly deploymentId: string;
  readonly displayName: string;
  readonly protocols: readonly string[];
  readonly availability: string;
  readonly pricing?: RecommendationPricing;
  readonly contextWindow?: number;
  /** The implementation at recommendation time; part of the evidence subject. */
  readonly implementationFingerprint?: string;
  /**
   * Who publishes the model, as the catalog names it. Not who operates it: the
   * public catalog reports one platform Provider for everything, so this
   * answers "whose model is this" and cannot answer "who sees the request".
   */
  readonly publisher?: string;
}

export interface RecommendOptions {
  readonly scenario: ScenarioProfile;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly integrationId: string;
  readonly integrationVersion: string;
  /** The platform the recommendation is for. Evidence from another one does not apply. */
  readonly platform: string;
  /** Protocols this Agent speaks; a deployment offering none of them is out. */
  readonly agentProtocols: readonly string[];
  readonly catalogVersion: string;
  readonly candidates: readonly RecommendationCandidate[];
  readonly evidence: readonly CompatibilityEvidence[];
  readonly now: Date;
  readonly constraints?: RecommendationConstraints;
}

export interface RecommendationConstraints {
  /** Only these deployments are considered, if given. */
  readonly deploymentIds?: readonly string[];
  /** Blended price ceiling per million tokens, as a decimal string. */
  readonly maxBlendedPricePerMillion?: string;
  /** Publishers whose models must not be recommended, matched case-insensitively. */
  readonly excludePublishers?: readonly string[];
}

export interface ScoredDimension {
  readonly priority: ScenarioPriority;
  readonly score: number;
  readonly weight: number;
  readonly detail: string;
}

export interface RecommendationCandidateResult {
  readonly deploymentId: string;
  readonly displayName: string;
  readonly rank: number;
  readonly eligible: boolean;
  readonly protocol?: string;
  readonly score?: number;
  readonly confidence?: number;
  readonly dimensions?: readonly ScoredDimension[];
  readonly reasons: readonly string[];
  readonly evidenceRefs: readonly string[];
  /** Always false in the first batch, and never an input to the score. */
  readonly sponsored: boolean;
}

export interface RecommendationResult {
  readonly schemaVersion: string;
  readonly id: string;
  readonly agentId: string;
  readonly scenarioId: string;
  /** Which revision of that Scenario ranked this, since a revision changes what is required. */
  readonly profileVersion: string;
  readonly catalogVersion: string;
  readonly ruleVersion: string;
  readonly platform: string;
  readonly priorities: readonly string[];
  /** Priorities the Scenario asks for that nothing measures yet, with why. */
  readonly unmeasured: readonly { readonly priority: string; readonly why: string }[];
  readonly candidates: readonly RecommendationCandidateResult[];
  readonly summary: string;
  readonly createdAt: string;
  /**
   * When the ranking stops standing. It rests on the evidence it cites, so it
   * expires with the first of those records -- the same rule `createEvidence`
   * uses on its own statements. A ranking that cites nothing has nothing to
   * outlive, so it expires where it was created rather than claiming a window
   * it cannot support.
   */
  readonly expiresAt: string;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Blended price per million tokens under the rule's input/output mix, or
 * undefined when the catalog does not actually publish one.
 *
 * A published zero is treated as absent, not as free. The public catalog
 * currently reports `0` for every deployment while the estimate endpoint quotes
 * real amounts for the same models and usage bills real money -- so a zero here
 * means the price is not in this projection, and scoring it as the cheapest
 * possible option would rank on a number that contradicts the bill.
 */
function blendedPricePerMillion(pricing: RecommendationPricing | undefined): number | undefined {
  if (pricing === undefined) return undefined;
  const perUnit = Number(pricing.input) * SCORING_RULE.inputShare + Number(pricing.output) * SCORING_RULE.outputShare;
  if (!Number.isFinite(perUnit) || perUnit <= 0) return undefined;
  return (perUnit / pricing.unit) * 1_000_000;
}

/**
 * No `scenarioId`, deliberately. This asks a technical-compatibility question,
 * and a Scenario-scoped measurement is a different subject: the Scenario here
 * decides which capabilities are required and how they are weighed, not which
 * records may answer.
 */
function subjectFor(options: RecommendOptions, candidate: RecommendationCandidate, protocol: string): EvidenceSubject {
  return {
    agentId: options.agentId,
    agentVersion: options.agentVersion,
    integrationId: options.integrationId,
    integrationVersion: options.integrationVersion,
    deploymentId: candidate.deploymentId,
    protocol,
    platform: options.platform,
    ...(candidate.implementationFingerprint === undefined
      ? {}
      : { implementationFingerprint: candidate.implementationFingerprint }),
  };
}

interface ProtocolAssessment {
  readonly protocol: string;
  readonly verdict: ReturnType<typeof computeVerdict>;
  readonly tested: number;
  readonly supportedPreferred: number;
  readonly totalPreferred: number;
  readonly evidenceRefs: readonly string[];
}

function assess(options: RecommendOptions, candidate: RecommendationCandidate, protocol: string): ProtocolAssessment {
  const requirements = options.scenario.requirements.map((requirement) => ({
    capabilityId: requirement.capabilityId,
    level: requirement.level,
  }));
  const verdict = computeVerdict({
    subject: subjectFor(options, candidate, protocol),
    evidence: options.evidence,
    now: options.now,
    requirements,
  });
  const asked = new Set(options.scenario.requirements.map((requirement) => requirement.capabilityId));
  const relevant = verdict.capabilities.filter((capability) => asked.has(capability.capabilityId));
  const preferred = relevant.filter((capability) => capability.level === "preferred");
  return {
    protocol,
    verdict,
    tested: relevant.filter((capability) => capability.evidenceId !== undefined && !capability.stale).length,
    supportedPreferred: preferred.filter((capability) => capability.support === "supported").length,
    totalPreferred: preferred.length,
    evidenceRefs: [
      ...new Set(relevant.map((capability) => capability.evidenceId).filter((id): id is string => id !== undefined)),
    ].sort(),
  };
}

/** One candidate as it moves through the two passes: filter, then score. */
interface AssessedCandidate {
  readonly candidate: RecommendationCandidate;
  readonly eligible: boolean;
  readonly protocol?: string;
  readonly compatibility?: number;
  readonly compatibilityDetail?: string;
  readonly confidence?: number;
  readonly reasons: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly dimensions?: readonly ScoredDimension[];
  readonly score?: number;
}

const VERDICT_RANK: Readonly<Record<string, number>> = {
  compatible: 0,
  partial: 1,
  unknown: 2,
  incompatible: 3,
};

/**
 * Weights come from the order of `priorities`, over the dimensions that can
 * actually be scored. A priority nothing measures drops out and its weight is
 * not silently handed to the next one -- the result says which priorities were
 * dropped, because a ranking that quietly reweights is a ranking nobody can
 * check.
 */
function weightsFor(
  priorities: readonly ScenarioPriority[],
  unavailable: ReadonlySet<ScenarioPriority>,
): Map<ScenarioPriority, number> {
  const scorable = priorities.filter(
    (priority) => UNMEASURED_PRIORITIES[priority] === undefined && !unavailable.has(priority),
  );
  const total = scorable.reduce((sum, _priority, index) => sum + (scorable.length - index), 0);
  const weights = new Map<ScenarioPriority, number>();
  scorable.forEach((priority, index) => weights.set(priority, (scorable.length - index) / total));
  return weights;
}

/**
 * Ranks deployments for one Scenario, on one platform, from the evidence on
 * hand.
 *
 * Hard requirements filter rather than deduct: a required capability that
 * failed, or that has no live evidence, makes a candidate ineligible with a
 * reason. A total score that can outweigh a failed requirement is how a
 * recommendation starts lying, and M3's rule -- never show untested as
 * supported -- has to survive being turned into a number.
 *
 * Evidence is matched on the full subject, platform included. A conclusion
 * reached on Linux says nothing about Windows, so on a platform with no
 * evidence every candidate is ineligible and says so.
 */
export function recommend(options: RecommendOptions): RecommendationResult {
  const considered = options.constraints?.deploymentIds
    ? options.candidates.filter((candidate) => options.constraints!.deploymentIds!.includes(candidate.deploymentId))
    : options.candidates;

  const ceiling = options.constraints?.maxBlendedPricePerMillion === undefined
    ? undefined
    : Number(options.constraints.maxBlendedPricePerMillion);
  const excluded = new Set(
    (options.constraints?.excludePublishers ?? []).map((publisher) => publisher.toLowerCase()),
  );

  const assessed: readonly AssessedCandidate[] = considered.map((candidate): AssessedCandidate => {
    const reasons: string[] = [];
    const usable = candidate.protocols.filter((protocol) => options.agentProtocols.includes(protocol)).sort();
    if (usable.length === 0) {
      return {
        candidate,
        eligible: false,
        reasons: [`The deployment offers ${candidate.protocols.join(", ") || "no protocol"}, and this Agent speaks ${options.agentProtocols.join(", ")}.`],
        evidenceRefs: [] as readonly string[],
      };
    }
    if (candidate.availability !== "available" && candidate.availability !== "degraded") {
      return {
        candidate,
        eligible: false,
        reasons: [`The catalog reports the deployment as ${candidate.availability}.`],
        evidenceRefs: [] as readonly string[],
      };
    }
    if (excluded.size > 0) {
      const publisher = candidate.publisher?.toLowerCase();
      if (publisher === undefined) {
        // Same rule as the price ceiling and as a required capability: a
        // deployment whose publisher the catalog does not name cannot be shown
        // not to be one of the excluded ones, and a constraint that lets the
        // unprovable through is not a constraint.
        return {
          candidate,
          eligible: false,
          reasons: [
            `The catalog does not name a publisher, so this deployment cannot be shown not to be published by ${[...excluded].sort().join(", ")}.`,
          ],
          evidenceRefs: [] as readonly string[],
        };
      }
      if (excluded.has(publisher)) {
        return {
          candidate,
          eligible: false,
          reasons: [`Published by ${candidate.publisher}, which this run excludes.`],
          evidenceRefs: [] as readonly string[],
        };
      }
    }
    const blended = blendedPricePerMillion(candidate.pricing);
    if (ceiling !== undefined && blended === undefined) {
      // A ceiling asks to be shown the deployment fits in it, and a deployment
      // the catalog prices at nothing shows no such thing. Letting it through
      // made `--max-price` silently match everything while reading as "filtered
      // to your budget" -- the same rule required capabilities already follow:
      // unknown is not a pass.
      return {
        candidate,
        eligible: false,
        reasons: [
          `The catalog publishes no usable price, so this deployment cannot be shown to be within the ${ceiling} ceiling. Unknown is not within budget.`,
        ],
        evidenceRefs: [] as readonly string[],
      };
    }
    if (ceiling !== undefined && blended !== undefined && blended > ceiling) {
      return {
        candidate,
        eligible: false,
        reasons: [
          `Blended price ${blended.toFixed(4)} ${candidate.pricing!.currency} per million is above the ${ceiling} ceiling.`,
        ],
        evidenceRefs: [] as readonly string[],
      };
    }

    // Every protocol the Agent can use is assessed; the best answer wins, ties
    // broken by protocol name so the result does not depend on catalog order.
    const assessments = usable.map((protocol) => assess(options, candidate, protocol));
    const best = [...assessments].sort(
      (left, right) =>
        VERDICT_RANK[left.verdict.verdict]! - VERDICT_RANK[right.verdict.verdict]! ||
        right.supportedPreferred - left.supportedPreferred ||
        left.protocol.localeCompare(right.protocol),
    )[0]!;

    if (best.tested === 0) {
      return {
        candidate,
        eligible: false,
        protocol: best.protocol,
        reasons: [
          `No compatibility evidence has been collected for ${options.agentId} ${options.agentVersion} on ${options.platform} against this deployment. Evidence from another platform does not carry over.`,
        ],
        evidenceRefs: [] as readonly string[],
      };
    }
    if (best.verdict.verdict === "incompatible" || best.verdict.verdict === "unknown") {
      return {
        candidate,
        eligible: false,
        protocol: best.protocol,
        // The verdict already names which required capability failed or has no
        // live evidence; repeating it here is the whole point of the exclusion.
        reasons: best.verdict.reasons.map((reason) => `${best.protocol}: ${reason}`),
        evidenceRefs: best.evidenceRefs,
      };
    }

    reasons.push(...best.verdict.reasons.map((reason) => `${best.protocol}: ${reason}`));
    return {
      candidate,
      eligible: true,
      protocol: best.protocol,
      compatibility: best.totalPreferred === 0 ? 1 : best.supportedPreferred / best.totalPreferred,
      compatibilityDetail: `${best.supportedPreferred}/${best.totalPreferred} preferred capabilities supported on ${best.protocol}; every required one passed`,
      confidence: best.tested / options.scenario.requirements.length,
      reasons,
      evidenceRefs: best.evidenceRefs,
    };
  });

  // A dimension nothing in the eligible set has data for is dropped for this
  // run and reported, exactly like a priority nothing measures. Scoring every
  // candidate zero would keep the weight while carrying no information; scoring
  // them all one would rank on a number the bill contradicts.
  const eligibleEntries = assessed.filter((entry) => entry.eligible);
  // With nothing eligible there is no set to look in, and "no eligible
  // deployment has a price" would report every dimension as unmeasured on the
  // strength of an empty set. Nothing was measured because nothing got that
  // far, which is a different statement and belongs to the exclusion reasons.
  const anyEligible = eligibleEntries.length > 0;
  const unavailable = new Set<ScenarioPriority>();
  const runtimeUnmeasured: { readonly priority: string; readonly why: string }[] = [];
  if (anyEligible && !eligibleEntries.some((entry) => blendedPricePerMillion(entry.candidate.pricing) !== undefined)) {
    unavailable.add("cost");
    runtimeUnmeasured.push({
      priority: "cost",
      why: "the catalog publishes no usable price for any eligible deployment; ranking on a published zero would contradict what the estimate and the bill say",
    });
  }
  if (anyEligible && !eligibleEntries.some((entry) => entry.candidate.contextWindow !== undefined)) {
    unavailable.add("context");
    runtimeUnmeasured.push({
      priority: "context",
      why: "the catalog publishes no context window for any eligible deployment",
    });
  }

  const weights = weightsFor(options.scenario.priorities, unavailable);
  const unmeasured = [
    ...options.scenario.priorities
      .filter((priority) => UNMEASURED_PRIORITIES[priority] !== undefined)
      .map((priority) => ({ priority: priority as string, why: UNMEASURED_PRIORITIES[priority]! })),
    ...runtimeUnmeasured,
  ];

  const scored: readonly AssessedCandidate[] = assessed.map((entry): AssessedCandidate => {
    if (!entry.eligible) return entry;
    const dimensions: ScoredDimension[] = [];
    if (weights.has("compatibility")) {
      dimensions.push({
        priority: "compatibility",
        score: entry.compatibility!,
        weight: weights.get("compatibility")!,
        detail: entry.compatibilityDetail!,
      });
    }
    if (weights.has("cost")) {
      const blended = blendedPricePerMillion(entry.candidate.pricing);
      dimensions.push({
        priority: "cost",
        score: blended === undefined ? 0 : clamp01(1 - blended / SCORING_RULE.priceCeilingPerMillion),
        weight: weights.get("cost")!,
        detail: blended === undefined
          ? "the catalog publishes no usable price for this deployment, so it scores zero rather than being assumed cheap"
          : `${blended.toFixed(4)} ${entry.candidate.pricing!.currency} per million blended at ${SCORING_RULE.inputShare}/${SCORING_RULE.outputShare} input/output, against a ${SCORING_RULE.priceCeilingPerMillion} ceiling`,
      });
    }
    if (weights.has("context")) {
      const window = entry.candidate.contextWindow;
      dimensions.push({
        priority: "context",
        score: window === undefined ? 0 : clamp01(window / SCORING_RULE.targetContextWindow),
        weight: weights.get("context")!,
        detail: window === undefined
          ? "the catalog publishes no context window for this deployment, so it scores zero rather than being assumed large"
          : `${window} tokens against a ${SCORING_RULE.targetContextWindow} target`,
      });
    }
    return {
      ...entry,
      dimensions,
      score: dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0),
    };
  });

  // Deterministic order: eligible first, then score, then deployment ID. Two
  // runs over the same input have to produce the same bytes, which is what the
  // repeatability exit condition means in practice.
  const ordered = [...scored].sort(
    (left, right) =>
      Number(right.eligible) - Number(left.eligible) ||
      (right.score ?? 0) - (left.score ?? 0) ||
      left.candidate.deploymentId.localeCompare(right.candidate.deploymentId),
  );

  const candidates: RecommendationCandidateResult[] = ordered.map((entry, index) => ({
    deploymentId: entry.candidate.deploymentId,
    displayName: entry.candidate.displayName,
    rank: index + 1,
    eligible: entry.eligible,
    ...(entry.protocol === undefined ? {} : { protocol: entry.protocol }),
    ...(entry.score === undefined ? {} : { score: Number(entry.score.toFixed(6)) }),
    ...(entry.confidence === undefined ? {} : { confidence: Number(entry.confidence.toFixed(6)) }),
    ...(entry.dimensions === undefined ? {} : { dimensions: entry.dimensions }),
    reasons: entry.reasons,
    evidenceRefs: entry.evidenceRefs,
    // Never an input to the score above: the exit condition "no hidden
    // commercial scoring" is held by there being nothing to hide.
    sponsored: false,
  }));

  const eligible = candidates.filter((candidate) => candidate.eligible);
  const summary = eligible.length === 0
    ? `No deployment can be recommended for ${options.scenario.id} on ${options.platform}: ${candidates.length} considered, none eligible.${commonestExclusion(candidates)}`
    : `${eligible[0]!.displayName} ranks first for ${options.scenario.id} on ${options.platform}, from ${eligible.length} eligible of ${candidates.length} considered.`;

  return {
    schemaVersion: "0.1",
    id: options.scenario.id,
    agentId: options.agentId,
    scenarioId: options.scenario.id,
    profileVersion: options.scenario.profileVersion,
    catalogVersion: options.catalogVersion,
    ruleVersion: options.scenario.scoringRuleVersion,
    platform: options.platform,
    priorities: [...options.scenario.priorities],
    unmeasured,
    candidates,
    summary,
    createdAt: options.now.toISOString(),
    expiresAt: earliestExpiry(options.evidence, candidates) ?? options.now.toISOString(),
  };
}

/**
 * Naming one cause was wrong as soon as there was more than one: the summary
 * said "none with live evidence" however they were excluded, so a price ceiling
 * that removed everything was reported as an evidence problem. The reasons are
 * templated, so the identical ones group, and the largest group is named with
 * its count rather than presented as the only cause.
 */
function commonestExclusion(candidates: readonly RecommendationCandidateResult[]): string {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const reason = candidate.reasons[0];
    if (reason !== undefined) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const top = ranked[0];
  if (top === undefined) return "";
  return counts.size === 1
    ? ` Every one: ${top[0]}`
    : ` Most common (${top[1]} of ${candidates.length}): ${top[0]}`;
}

function earliestExpiry(
  evidence: readonly CompatibilityEvidence[],
  candidates: readonly RecommendationCandidateResult[],
): string | undefined {
  const cited = new Set(candidates.flatMap((candidate) => candidate.evidenceRefs));
  const expiries = evidence
    .filter((record) => cited.has(record.id))
    .map((record) => record.expiresAt)
    .sort();
  return expiries[0];
}
