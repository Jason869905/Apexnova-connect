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
  /** When this quote stops being the price in force, where the catalog says so. */
  readonly priceValidUntil?: string;
}

export interface RecommendationCandidate {
  readonly modelId: string;
  readonly displayName: string;
  readonly protocols: readonly string[];
  readonly availability: string;
  readonly pricing?: RecommendationPricing;
  readonly contextWindow?: number;
  /** The implementation at recommendation time; part of the evidence subject. */
  readonly implementationFingerprint?: string;
  /**
   * Who publishes the model, as the catalog names it -- DeepSeek, MiniMax,
   * Zhipu AI. This is the "provider" a reader means when they ask whose model
   * they are about to use, and it is what the ranking shows in that column.
   *
   * It is not who operates it: the public catalog reports one platform Provider
   * for everything, so this cannot answer "who sees the request".
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
  /** Protocols this Agent speaks; a model offering none of them is out. */
  readonly agentProtocols: readonly string[];
  readonly catalogVersion: string;
  /** In the order Hub returned them: that order is the fallback ranking. */
  readonly candidates: readonly RecommendationCandidate[];
  readonly evidence: readonly CompatibilityEvidence[];
  readonly now: Date;
  readonly constraints?: RecommendationConstraints;
}

export interface RecommendationConstraints {
  /** Only these models are considered, if given. */
  readonly modelIds?: readonly string[];
  /** Blended price ceiling per million tokens, as a decimal string. */
  readonly maxBlendedPricePerMillion?: string;
}

export interface ScoredDimension {
  readonly priority: ScenarioPriority;
  readonly score: number;
  readonly weight: number;
  readonly detail: string;
}

/**
 * What put a candidate where it is.
 *
 * `evidence` -- it was scored, because live evidence covers what this Scenario
 * requires of it. `catalog-order` -- nothing has been measured against it yet,
 * so it holds the position Hub gave it and carries no score.
 */
export type RankingBasis = "evidence" | "catalog-order";

export interface RecommendationCandidateResult {
  readonly modelId: string;
  readonly displayName: string;
  readonly rank: number;
  readonly eligible: boolean;
  /** Absent on an excluded candidate: nothing ranked it. */
  readonly basis?: RankingBasis;
  /** The catalog's publisher, shown as the provider column. */
  readonly publisher?: string;
  readonly protocol?: string;
  /**
   * One line saying what put this model where it is, for a renderer that has
   * one column to say it in. The long form stays in `reasons`.
   */
  readonly headline: string;
  /** Blended price per million tokens, when the catalog publishes one. */
  readonly pricePerMillion?: number;
  readonly currency?: string;
  readonly contextWindow?: number;
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
 * Zero is a price now. It was not always: requirement 12H was raised because the
 * catalog published `0` for every model, where it was indistinguishable
 * from "we do not publish one" and would have ranked the dearest model first.
 * Hub has since shipped both halves -- real prices, and an explicit `null` for
 * the projections that carry none -- so `null` holds the absence and a published
 * `0` gets its meaning back. One of the models priced at zero is named
 * "North Mini Code (free)".
 *
 * A negative or unparseable price is still no price: neither is a statement
 * anyone can rank on.
 */
function blendedPricePerMillion(pricing: RecommendationPricing | undefined): number | undefined {
  if (pricing === undefined) return undefined;
  const perUnit = Number(pricing.input) * SCORING_RULE.inputShare + Number(pricing.output) * SCORING_RULE.outputShare;
  if (!Number.isFinite(perUnit) || perUnit < 0) return undefined;
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
    // The evidence subject keeps Hub's spelling because its ID is a hash of
    // this object; the value is the model id either way.
    deploymentId: candidate.modelId,
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
  /** Its position in the catalog Hub returned, which is the fallback order. */
  readonly catalogIndex: number;
  readonly eligible: boolean;
  readonly basis?: RankingBasis;
  readonly headline: string;
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
 * Ranks models for one Scenario, on one platform.
 *
 * There is always a ranked list. Three things can take a model out of it, and
 * each one is something the catalog or the evidence positively says: the Agent
 * speaks none of its protocols, the catalog reports it as not serving, or it
 * sits outside a price ceiling the run asked for. Evidence removes a model only
 * when it *failed* a required capability -- a measured incompatibility, not a
 * gap in what has been measured.
 *
 * What evidence does otherwise is decide the order:
 *
 * - a model with live evidence covering this Scenario's requirements is scored,
 *   and the scored models come first, best first;
 * - a model nothing has been measured against keeps the position Hub gave it in
 *   the catalog, and carries no score.
 *
 * That fallback is the whole difference from the first cut of this function,
 * which made "nobody has tested this yet" an exclusion and so answered an empty
 * ranking on any platform with no evidence -- the honest answer to a question
 * nobody asked. "Which of these should I use" is still answerable from the
 * catalog alone; what changes without evidence is how much the answer is worth,
 * and `basis` says which one a reader is holding, per model.
 */
export function recommend(options: RecommendOptions): RecommendationResult {
  const considered = (options.constraints?.modelIds
    ? options.candidates.filter((candidate) => options.constraints!.modelIds!.includes(candidate.modelId))
    : options.candidates
  ).map((candidate, catalogIndex) => ({ candidate, catalogIndex }));

  const ceiling = options.constraints?.maxBlendedPricePerMillion === undefined
    ? undefined
    : Number(options.constraints.maxBlendedPricePerMillion);
  // Every price this ranking actually read, so the result can say how long the
  // reading stays true. A price that was never consulted cannot invalidate it.
  const pricesUsed: string[] = [];

  const assessed: readonly AssessedCandidate[] = considered.map(({ candidate, catalogIndex }): AssessedCandidate => {
    const excludedFor = (reasons: readonly string[], extra: Partial<AssessedCandidate> = {}): AssessedCandidate => ({
      candidate,
      catalogIndex,
      eligible: false,
      // The first reason is the exclusion; a renderer with one column shows it
      // rather than inventing a shorter one that says something else.
      headline: reasons[0] ?? "excluded",
      reasons,
      evidenceRefs: [] as readonly string[],
      ...extra,
    });

    const usable = candidate.protocols.filter((protocol) => options.agentProtocols.includes(protocol)).sort();
    if (usable.length === 0) {
      return excludedFor([
        `The model offers ${candidate.protocols.join(", ") || "no protocol"}, and this Agent speaks ${options.agentProtocols.join(", ")}.`,
      ]);
    }
    if (candidate.availability !== "available" && candidate.availability !== "degraded") {
      return excludedFor([`The catalog reports the model as ${candidate.availability}.`]);
    }
    const blended = blendedPricePerMillion(candidate.pricing);
    if (blended !== undefined && candidate.pricing?.priceValidUntil !== undefined) {
      pricesUsed.push(candidate.pricing.priceValidUntil);
    }
    if (ceiling !== undefined && blended === undefined) {
      // A ceiling asks to be shown the model fits in it, and a model
      // the catalog prices at nothing shows no such thing. Letting it through
      // made `--max-price` silently match everything while reading as "filtered
      // to your budget": unknown is not a pass.
      return excludedFor([
        `The catalog publishes no usable price, so this model cannot be shown to be within the ${ceiling} ceiling. Unknown is not within budget.`,
      ]);
    }
    if (ceiling !== undefined && blended !== undefined && blended > ceiling) {
      return excludedFor([
        `Blended price ${blended.toFixed(4)} ${candidate.pricing!.currency} per million is above the ${ceiling} ceiling.`,
      ]);
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

    if (best.verdict.verdict === "incompatible") {
      // The one thing evidence still removes a model for: it was tried, and a
      // capability this Scenario requires did not work. The verdict already
      // names which one, which is the whole point of the exclusion.
      return excludedFor(best.verdict.reasons.map((reason) => `${best.protocol}: ${reason}`), {
        protocol: best.protocol,
        evidenceRefs: best.evidenceRefs,
      });
    }
    if (best.tested === 0 || best.verdict.verdict === "unknown") {
      // Untested, or tested incompletely. Not a defect of the model and not a
      // reason to hide it -- it keeps Hub's position and says what it is.
      return {
        candidate,
        catalogIndex,
        eligible: true,
        basis: "catalog-order",
        headline: best.tested === 0
          ? "not tested yet, so it holds Hub's catalog order"
          : `tested on ${best.tested} of ${options.scenario.requirements.length} requirements, so it holds Hub's catalog order`,
        protocol: best.protocol,
        reasons: [
          best.tested === 0
            ? `No compatibility evidence for ${options.agentId} ${options.agentVersion} on ${options.platform} yet, so this keeps the catalog position Hub gave it. Evidence from another platform does not carry over.`
            : `Evidence covers ${best.tested} of ${options.scenario.requirements.length} requirements on ${best.protocol}, not all of them, so this keeps the catalog position Hub gave it.`,
        ],
        evidenceRefs: best.evidenceRefs,
      };
    }

    return {
      candidate,
      catalogIndex,
      eligible: true,
      basis: "evidence",
      headline: `every required capability passed on ${best.protocol}; ${best.supportedPreferred} of ${best.totalPreferred} preferred supported`,
      protocol: best.protocol,
      compatibility: best.totalPreferred === 0 ? 1 : best.supportedPreferred / best.totalPreferred,
      compatibilityDetail: `${best.supportedPreferred}/${best.totalPreferred} preferred capabilities supported on ${best.protocol}; every required one passed`,
      confidence: best.tested / options.scenario.requirements.length,
      reasons: best.verdict.reasons.map((reason) => `${best.protocol}: ${reason}`),
      evidenceRefs: best.evidenceRefs,
    };
  });

  // A dimension nothing in the scored set has data for is dropped for this
  // run and reported, exactly like a priority nothing measures. Scoring every
  // candidate zero would keep the weight while carrying no information; scoring
  // them all one would rank on a number the bill contradicts.
  //
  // The set looked in is the scored one, not everything eligible: a model
  // ranked by catalog order is not scored on any dimension, so whether it
  // carries a price says nothing about whether `cost` can order the rest.
  const scoredEntries = assessed.filter((entry) => entry.basis === "evidence");
  // With nothing scored there is no set to look in, and "no scored model has a
  // price" would report every dimension as unmeasured on the strength of an
  // empty set. Nothing was measured because nothing was scored, which is a
  // different statement and is what `basis` already says.
  const anyScored = scoredEntries.length > 0;
  const unavailable = new Set<ScenarioPriority>();
  const runtimeUnmeasured: { readonly priority: string; readonly why: string }[] = [];
  if (anyScored && !scoredEntries.some((entry) => blendedPricePerMillion(entry.candidate.pricing) !== undefined)) {
    unavailable.add("cost");
    runtimeUnmeasured.push({
      priority: "cost",
      why: "the catalog publishes no usable price for any scored model",
    });
  }
  if (anyScored && !scoredEntries.some((entry) => entry.candidate.contextWindow !== undefined)) {
    unavailable.add("context");
    runtimeUnmeasured.push({
      priority: "context",
      why: "the catalog publishes no context window for any scored model",
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
    if (entry.basis !== "evidence") return entry;
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
          ? "the catalog publishes no usable price for this model, so it scores zero rather than being assumed cheap"
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
          ? "the catalog publishes no context window for this model, so it scores zero rather than being assumed large"
          : `${window} tokens against a ${SCORING_RULE.targetContextWindow} target`,
      });
    }
    return {
      ...entry,
      dimensions,
      score: dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0),
    };
  });

  // Scored first, then the ones holding Hub's order, then what was excluded.
  // Inside each group the catalog's own order breaks every tie, so the only
  // thing that reorders a model is a score -- and two runs over the same
  // catalog produce the same bytes, which is what the repeatability exit
  // condition means in practice.
  const ordered = [...scored].sort(
    (left, right) =>
      groupOf(left) - groupOf(right) ||
      (right.score ?? 0) - (left.score ?? 0) ||
      left.catalogIndex - right.catalogIndex,
  );

  const candidates: RecommendationCandidateResult[] = ordered.map((entry, index) => {
    const blended = blendedPricePerMillion(entry.candidate.pricing);
    return {
      modelId: entry.candidate.modelId,
      displayName: entry.candidate.displayName,
      rank: index + 1,
      eligible: entry.eligible,
      headline: entry.headline,
      ...(entry.basis === undefined ? {} : { basis: entry.basis }),
      ...(entry.candidate.publisher === undefined ? {} : { publisher: entry.candidate.publisher }),
      ...(entry.protocol === undefined ? {} : { protocol: entry.protocol }),
      ...(blended === undefined
        ? {}
        : { pricePerMillion: Number(blended.toFixed(6)), currency: entry.candidate.pricing!.currency }),
      ...(entry.candidate.contextWindow === undefined ? {} : { contextWindow: entry.candidate.contextWindow }),
      ...(entry.score === undefined ? {} : { score: Number(entry.score.toFixed(6)) }),
      ...(entry.confidence === undefined ? {} : { confidence: Number(entry.confidence.toFixed(6)) }),
      ...(entry.dimensions === undefined ? {} : { dimensions: entry.dimensions }),
      reasons: entry.reasons,
      evidenceRefs: entry.evidenceRefs,
      // Never an input to the score above: the exit condition "no hidden
      // commercial scoring" is held by there being nothing to hide.
      sponsored: false,
    };
  });

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
    summary: summarise(candidates, options),
    createdAt: options.now.toISOString(),
    expiresAt: horizon(earliestExpiry(options.evidence, candidates), pricesUsed, options.now),
  };
}

/** Scored, then catalog order, then excluded. */
function groupOf(entry: AssessedCandidate): number {
  return entry.basis === "evidence" ? 0 : entry.eligible ? 1 : 2;
}

/**
 * One sentence: how many models are ranked, what put the top one there, and --
 * only when something was dropped -- how many and what the commonest cause was.
 *
 * Naming one cause was wrong as soon as there was more than one: the summary
 * said "none with live evidence" however they were excluded, so a price ceiling
 * that removed everything was reported as an evidence problem. The reasons are
 * templated, so the identical ones group, and the largest group is named with
 * its count rather than presented as the only cause.
 */
function summarise(
  candidates: readonly RecommendationCandidateResult[],
  options: RecommendOptions,
): string {
  const ranked = candidates.filter((candidate) => candidate.eligible);
  const excluded = candidates.filter((candidate) => !candidate.eligible);
  const scored = ranked.filter((candidate) => candidate.basis === "evidence").length;
  if (ranked.length === 0) {
    return `No model is left for ${options.scenario.id} on ${options.platform}: ${candidates.length} considered, all excluded.${commonestExclusion(excluded)}`;
  }
  const top = ranked[0]!;
  const how = top.basis === "evidence"
    ? `on compatibility evidence, scoring ${top.score?.toFixed(3)}`
    : "on Hub's catalog order, because nothing has been measured against it yet";
  return [
    `${top.displayName} ranks first for ${options.scenario.id} on ${options.platform} ${how}.`,
    ` ${ranked.length} of ${candidates.length} models ranked, ${scored} of them scored from evidence.`,
    excluded.length === 0 ? "" : ` ${excluded.length} excluded.${commonestExclusion(excluded)}`,
  ].join("");
}

function commonestExclusion(excluded: readonly RecommendationCandidateResult[]): string {
  const counts = new Map<string, number>();
  for (const candidate of excluded) {
    const reason = candidate.reasons[0];
    if (reason !== undefined) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const top = ranked[0];
  if (top === undefined) return "";
  return counts.size === 1
    ? ` Every one: ${top[0]}`
    : ` Most common (${top[1]} of ${excluded.length}): ${top[0]}`;
}

/**
 * The ranking stops standing when the first thing under it does. That is not
 * only the evidence: the catalog prices some models by time of day, so a
 * ranking computed at 17:00 can rest on a number that doubles at 22:00. Reading
 * the price without its expiry produced documents claiming four weeks of
 * validity from an input with six hours left.
 *
 * Never earlier than `createdAt`: a catalog quoting an already-stale validity
 * should not make a document that was born expired.
 */
function horizon(evidenceExpiry: string | undefined, pricesUsed: readonly string[], now: Date): string {
  const createdAt = now.toISOString();
  const bounds = [...(evidenceExpiry === undefined ? [] : [evidenceExpiry]), ...pricesUsed].sort();
  const earliest = bounds[0];
  if (earliest === undefined) return createdAt;
  return earliest < createdAt ? createdAt : earliest;
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
