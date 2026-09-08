import { createHash } from "node:crypto";

/**
 * The versioned Capability Definition Registry. A definition says what a test
 * establishes and how long its result may stand; it does not say how important
 * the capability is, because that depends on the Agent asking (see
 * `AgentProfile.capabilityRequirements`). `defaultLevel` applies only when no
 * requirement is supplied.
 */
export type CapabilityCategory = "protocol-conformance" | "agent-interaction";

export type CapabilityLevel = "required" | "preferred" | "optional" | "avoided";

export interface CapabilityDefinition {
  readonly id: string;
  readonly category: CapabilityCategory;
  readonly title: string;
  /** What a failure of this capability actually means for the user. */
  readonly intent: string;
  readonly defaultLevel: "required" | "preferred";
  /** From the M0 freshness table: static protocol shape 90 days, tool and streaming behaviour 30. */
  readonly ttlDays: number;
}

export const CAPABILITY_SUITE_ID = "apexnova.capability-suite";

/**
 * Evidence records the suite version that produced them. A major bump means the
 * suite changed in a way that invalidates earlier results, so verdicts stop
 * accepting evidence from an older major (see `isEvidenceLive`).
 */
export const CAPABILITY_SUITE_VERSION = "0.1.0";

/** The M3 first batch fixed by ADR 0004: six protocol tests and two interaction tests. */
export const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  {
    id: "auth.endpoint-reachable",
    category: "protocol-conformance",
    title: "Endpoint authentication",
    intent:
      "The runtime credential authenticates against the protocol endpoint, and an invalid credential is refused outright rather than silently downgraded.",
    defaultLevel: "required",
    ttlDays: 90,
  },
  {
    id: "protocol.model-id-mapping",
    category: "protocol-conformance",
    title: "Model ID mapping",
    intent:
      "The deployment ID from the catalog is accepted by the server and the model echoed back matches it, so a request cannot be served by a different model than the one shown.",
    defaultLevel: "required",
    ttlDays: 90,
  },
  {
    id: "protocol.non-streaming",
    category: "protocol-conformance",
    title: "Non-streaming response shape",
    intent:
      "A minimal non-streaming request returns a response that matches the protocol schema, including usage fields that can be reconciled against Hub billing.",
    defaultLevel: "required",
    ttlDays: 90,
  },
  {
    id: "protocol.streaming-order",
    category: "protocol-conformance",
    title: "Streaming event order",
    intent:
      "Streamed events arrive in a legal order and terminate properly, so an Agent does not present a truncated answer as a complete one.",
    defaultLevel: "required",
    ttlDays: 30,
  },
  {
    id: "protocol.cancellation",
    category: "protocol-conformance",
    title: "Cancellation",
    intent:
      "Aborting the client closes the request, and the usage Hub bills matches what was actually produced.",
    defaultLevel: "preferred",
    ttlDays: 30,
  },
  {
    id: "protocol.error-semantics",
    category: "protocol-conformance",
    title: "Error and rate limit semantics",
    intent:
      "Invalid requests and rate limits return structured errors carrying a request ID, so a failure can be diagnosed and reconciled instead of guessed at.",
    defaultLevel: "required",
    ttlDays: 90,
  },
  {
    id: "agent.single-tool-call",
    category: "agent-interaction",
    title: "Single tool call",
    intent:
      "A single tool definition is callable and the arguments returned validate against the declared JSON Schema, which is what an Agent loop depends on.",
    defaultLevel: "required",
    ttlDays: 30,
  },
  {
    id: "agent.structured-output",
    category: "agent-interaction",
    title: "Structured output",
    intent:
      "Responses follow the schema the request asked for, rather than prose that happens to contain the fields.",
    defaultLevel: "preferred",
    ttlDays: 30,
  },
];

const BY_ID = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition]));

export function capabilityDefinition(id: string): CapabilityDefinition | undefined {
  return BY_ID.get(id);
}

export function requiredCapabilityIds(): readonly string[] {
  return CAPABILITY_DEFINITIONS.filter((definition) => definition.defaultLevel === "required").map(
    (definition) => definition.id,
  );
}

/**
 * Identifies the definitions a suite version stands for. The recorded digest is
 * asserted by a test: changing what a test establishes, or how long its result
 * may stand, has to come with a deliberate `CAPABILITY_SUITE_VERSION` bump,
 * because evidence already written names that version.
 */
export function capabilityDefinitionsDigest(): string {
  const canonical = CAPABILITY_DEFINITIONS.map((definition) => [
    definition.id,
    definition.category,
    definition.defaultLevel,
    definition.ttlDays,
  ]);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export const CAPABILITY_DEFINITIONS_DIGEST =
  "sha256:632b0e9b9c6c7e9fd8a2972513a2a3c42e03a35daed9e3de96883c45d89af482";
