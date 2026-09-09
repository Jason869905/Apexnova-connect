import { describe, expect, it } from "vitest";

import {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_DEFINITIONS_DIGEST,
  CAPABILITY_SUITE_VERSION,
  capabilityDefinition,
  capabilityDefinitionsDigest,
  requiredCapabilityIds,
} from "../src/index.js";

describe("capability definitions", () => {
  it("keeps the recorded digest, so changing a definition forces a suite version bump", () => {
    // Evidence on disk names the suite version it came from. If this fails,
    // decide whether the change invalidates existing evidence: bump
    // CAPABILITY_SUITE_VERSION (major for a breaking change) and record the new
    // digest -- do not just paste the new value.
    expect(capabilityDefinitionsDigest()).toBe(CAPABILITY_DEFINITIONS_DIGEST);
    expect(CAPABILITY_SUITE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is the first batch ADR 0004 fixed", () => {
    // The eight ADR 0004 fixed, plus agent.forced-tool-choice in suite 0.3.0.
    expect(CAPABILITY_DEFINITIONS).toHaveLength(9);
    const byCategory = CAPABILITY_DEFINITIONS.filter(
      (definition) => definition.category === "protocol-conformance",
    );
    expect(byCategory).toHaveLength(6);
    expect(requiredCapabilityIds()).toEqual([
      "auth.endpoint-reachable",
      "protocol.model-id-mapping",
      "protocol.non-streaming",
      "protocol.streaming-order",
      "protocol.error-semantics",
      "agent.single-tool-call",
    ]);
  });

  it("uses IDs and TTLs the schema and the M0 freshness table allow", () => {
    for (const definition of CAPABILITY_DEFINITIONS) {
      expect(definition.id).toMatch(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
      expect([30, 90]).toContain(definition.ttlDays);
      expect(definition.intent.length).toBeGreaterThan(40);
      expect(capabilityDefinition(definition.id)).toBe(definition);
    }
    expect(capabilityDefinition("protocol.does-not-exist")).toBeUndefined();
  });
});
