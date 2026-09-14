import { CAPABILITY_DEFINITIONS, capabilityDefinition, type CapabilityLevel } from "@apexnova-connect/capabilities";

/**
 * What a Scenario asks of a Model. The shape is frozen in
 * `scenario-profile.schema.json`; this is the typed view of it.
 *
 * `priorities` is ordered, most important first, and the order is the only
 * thing that decides weight -- a Scenario does not carry numbers, because a
 * number invites tuning it until the answer comes out right.
 */
export type ScenarioPriority =
  | "compatibility"
  | "quality"
  | "cost"
  | "latency"
  | "availability"
  | "context";

export interface ScenarioRequirement {
  readonly capabilityId: string;
  readonly level: CapabilityLevel;
  readonly reason?: string;
}

export interface ScenarioProfile {
  readonly schemaVersion: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly domain: string;
  readonly profileVersion: string;
  readonly requirements: readonly ScenarioRequirement[];
  readonly priorities: readonly ScenarioPriority[];
  readonly applicability?: string;
  readonly scoringRuleVersion: string;
}

/**
 * The scoring rule, versioned separately from the Scenario because the same
 * Scenario scored under a different rule is a different answer. Every constant
 * here is a published assumption rather than a tuned parameter, and each one is
 * quoted back in the reason a candidate carries.
 */
export const SCORING_RULE_VERSION = "coding.v1";

export const SCORING_RULE = {
  /** An Agent editing code reads far more than it writes. */
  inputShare: 0.75,
  outputShare: 0.25,
  /** Blended price at or above which `cost` scores zero, per million tokens. */
  priceCeilingPerMillion: 10,
  /** Context at or above which `context` scores one. */
  targetContextWindow: 128_000,
} as const;

/**
 * The M4 first batch: one Scenario (ADR 0007). Requirements reference the
 * capability IDs M3 already measures -- inventing a second vocabulary here
 * would mean nothing in the evidence store could satisfy them.
 */
export const CODING_GENERAL: ScenarioProfile = {
  schemaVersion: "0.1",
  id: "coding-general",
  name: "General coding assistance",
  description:
    "An Agent reading a repository and editing code: it streams, it calls tools in a loop, and it must not present a truncated answer as a complete one.",
  domain: "coding",
  profileVersion: "1.0.0",
  requirements: [
    { capabilityId: "auth.endpoint-reachable", level: "required", reason: "Nothing runs if the credential is not accepted." },
    { capabilityId: "protocol.model-id-mapping", level: "required", reason: "A request must not be served by a model other than the one shown." },
    { capabilityId: "protocol.non-streaming", level: "required", reason: "The base request shape has to work before anything else does." },
    { capabilityId: "protocol.streaming-order", level: "required", reason: "An Agent that streams must not present a truncated answer as complete." },
    { capabilityId: "protocol.error-semantics", level: "required", reason: "A failure has to be diagnosable and reconcilable." },
    { capabilityId: "agent.single-tool-call", level: "required", reason: "The edit loop is tool calls; without them the Agent can only talk." },
    { capabilityId: "protocol.cancellation", level: "preferred", reason: "Stopping a runaway generation should cost what it produced, no more." },
    { capabilityId: "agent.forced-tool-choice", level: "preferred", reason: "Carrying a schema on a protocol with no structured-output mode needs it." },
    { capabilityId: "agent.structured-output", level: "preferred", reason: "Structured edits are easier to apply than prose that contains them." },
  ],
  // Compatibility first on purpose: a cheaper model that cannot call
  // tools is not a cheaper way to do this job, it is a different job.
  //
  // The list is everything this Scenario cares about, not the subset something
  // can score today. `weightsFor` drops the ones nothing measures before it
  // computes any weight, so naming them here costs no weight and buys the thing
  // ADR 0007 asked for: the Recommendation says out loud that quality and
  // latency went unmeasured, and that availability filtered candidates without
  // scoring them. Leaving them out scored them at zero silently, which reads as
  // "this Scenario does not care" rather than "nobody measured it".
  //
  // Their position after the scored three is not yet a ranking and must not be
  // read as one -- it carries no weight while they stay unmeasured. Where each
  // belongs in the order is decided when it becomes measurable, and that is a
  // `profileVersion` change, not an edit.
  priorities: [
    "compatibility",
    "cost",
    "context",
    "availability",
    "latency",
    "quality",
  ],
  applicability: "Text-generation models reachable over a protocol the Agent speaks.",
  scoringRuleVersion: SCORING_RULE_VERSION,
};

export const SCENARIOS: readonly ScenarioProfile[] = [CODING_GENERAL];

export function scenario(id: string): ScenarioProfile | undefined {
  return SCENARIOS.find((profile) => profile.id === id);
}

/**
 * Priorities a Scenario may ask for but nothing can answer yet, with why. ADR
 * 0007: an unmeasured dimension is reported, never given a default score --
 * a default is "never tested" wearing the costume of "average".
 */
export const UNMEASURED_PRIORITIES: Readonly<Record<string, string>> = {
  quality: "no scenario quality pack exists yet; output quality is not measured",
  latency: "no operational evidence has been collected; first-token latency is not measured",
  availability: "the catalog's availability is a Hub declaration, not a measurement; it filters candidates but does not score them",
};

/** Fails loudly if a Scenario asks for a capability the registry does not define. */
export function assertScenarioIsSatisfiable(profile: ScenarioProfile): void {
  for (const requirement of profile.requirements) {
    if (capabilityDefinition(requirement.capabilityId) === undefined) {
      throw new Error(
        `Scenario ${profile.id} requires ${requirement.capabilityId}, which is not in the capability registry (${CAPABILITY_DEFINITIONS.length} defined).`,
      );
    }
  }
}
