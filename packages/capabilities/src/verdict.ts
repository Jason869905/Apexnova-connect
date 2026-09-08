import {
  CAPABILITY_DEFINITIONS,
  capabilityDefinition,
  type CapabilityLevel,
} from "./definitions.js";
import {
  CapabilityError,
  isStatementLive,
  isSuiteCurrent,
  type CapabilityStatement,
  type CapabilitySupport,
  type CompatibilityEvidence,
  type EvidenceSubject,
} from "./evidence.js";
import { supersededIds } from "./evidence-store.js";

export type SubjectVerdict = "compatible" | "partial" | "incompatible" | "unknown";

export interface CapabilityRequirement {
  readonly capabilityId: string;
  readonly level: CapabilityLevel;
}

export interface CapabilityVerdict {
  readonly capabilityId: string;
  readonly level: CapabilityLevel;
  readonly support: CapabilitySupport;
  readonly evidenceId?: string;
  readonly observedAt?: string;
  readonly expiresAt?: string;
  /** Evidence exists but has expired or came from a retired suite major. */
  readonly stale: boolean;
  readonly reason: string;
}

export interface CompatibilityVerdictResult {
  readonly verdict: SubjectVerdict;
  readonly subject: EvidenceSubject;
  readonly capabilities: readonly CapabilityVerdict[];
  readonly reasons: readonly string[];
}

export interface VerdictOptions {
  readonly subject: EvidenceSubject;
  readonly evidence: readonly CompatibilityEvidence[];
  readonly now: Date;
  /** From the Agent's profile. Definitions supply the level when this is omitted. */
  readonly requirements?: readonly CapabilityRequirement[];
}

function sameSubject(left: EvidenceSubject, right: EvidenceSubject): boolean {
  return (
    left.agentId === right.agentId &&
    left.agentVersion === right.agentVersion &&
    left.integrationId === right.integrationId &&
    left.integrationVersion === right.integrationVersion &&
    left.deploymentId === right.deploymentId &&
    left.protocol === right.protocol &&
    left.platform === right.platform
  );
}

interface Observation {
  readonly statement: CapabilityStatement;
  readonly evidence: CompatibilityEvidence;
  readonly live: boolean;
}

function newest(left: Observation | undefined, right: Observation): Observation {
  if (left === undefined) return right;
  if (left.live !== right.live) return left.live ? left : right;
  const leftAt = left.statement.observedAt ?? left.evidence.observedAt;
  const rightAt = right.statement.observedAt ?? right.evidence.observedAt;
  return rightAt.localeCompare(leftAt) > 0 ? right : left;
}

/**
 * Computes the verdict for one subject from the evidence on hand. Every subject
 * field has to match: a different Agent version, Integration version, Deployment
 * or platform is a different question, and M0 makes those changes expire
 * evidence rather than carry it over. Expired records are still reported --
 * they explain why something reads `unknown` -- but they cannot support
 * `compatible`.
 */
export function computeVerdict(options: VerdictOptions): CompatibilityVerdictResult {
  const levels = new Map<string, CapabilityLevel>();
  for (const definition of CAPABILITY_DEFINITIONS) levels.set(definition.id, definition.defaultLevel);
  for (const requirement of options.requirements ?? []) {
    if (!capabilityDefinition(requirement.capabilityId)) {
      throw new CapabilityError(
        "UNKNOWN_CAPABILITY",
        `Capability ${requirement.capabilityId} is not in the registry; it cannot be required.`,
      );
    }
    levels.set(requirement.capabilityId, requirement.level);
  }

  const candidates = options.evidence.filter((record) => sameSubject(record.subject, options.subject));
  const superseded = supersededIds(candidates);
  const observations = new Map<string, Observation>();
  for (const record of candidates) {
    if (superseded.has(record.id)) continue;
    const suiteCurrent = isSuiteCurrent(record);
    for (const statement of record.result.capabilities ?? []) {
      const live = suiteCurrent && isStatementLive(statement, options.now, record.expiresAt);
      observations.set(
        statement.capabilityId,
        newest(observations.get(statement.capabilityId), { statement, evidence: record, live }),
      );
    }
  }

  const capabilities: CapabilityVerdict[] = [];
  const reasons: string[] = [];
  let incompatible = false;
  let unknown = false;
  let partial = false;

  for (const [capabilityId, level] of levels) {
    const observation = observations.get(capabilityId);
    const support: CapabilitySupport =
      observation && observation.live ? observation.statement.support : "unknown";
    const stale = observation !== undefined && !observation.live;
    const reason = observation === undefined
      ? "No evidence has been collected for this subject."
      : stale
        ? `Evidence ${observation.evidence.id} expired on ${observation.statement.expiresAt ?? observation.evidence.expiresAt}.`
        : `Evidence ${observation.evidence.id} observed ${observation.statement.observedAt ?? observation.evidence.observedAt}.`;

    capabilities.push({
      capabilityId,
      level,
      support,
      stale,
      reason,
      ...(observation === undefined
        ? {}
        : {
            evidenceId: observation.evidence.id,
            ...(observation.statement.observedAt === undefined
              ? {}
              : { observedAt: observation.statement.observedAt }),
            ...(observation.statement.expiresAt === undefined
              ? {}
              : { expiresAt: observation.statement.expiresAt }),
          }),
    });

    if (level === "optional" || level === "avoided") continue;
    if (level === "required" && support === "unsupported") {
      incompatible = true;
      reasons.push(`${capabilityId} is required and failed.`);
      continue;
    }
    if (level === "required" && support === "unknown") {
      unknown = true;
      reasons.push(
        stale ? `${capabilityId} is required and its evidence expired.` : `${capabilityId} is required and unverified.`,
      );
      continue;
    }
    if (support === "partial" || support === "unsupported") {
      partial = true;
      reasons.push(`${capabilityId} is ${support} and the level is ${level}.`);
    }
  }

  const verdict: SubjectVerdict = incompatible
    ? "incompatible"
    : unknown
      ? "unknown"
      : partial
        ? "partial"
        : "compatible";

  return {
    verdict,
    subject: options.subject,
    capabilities,
    reasons: reasons.length > 0 ? reasons : ["Every required capability has live evidence."],
  };
}
