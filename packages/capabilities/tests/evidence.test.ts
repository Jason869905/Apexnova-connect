import { describe, expect, it } from "vitest";

import {
  CAPABILITY_SUITE_ID,
  CAPABILITY_SUITE_VERSION,
  createEvidence,
  isEvidenceLive,
  validateCompatibilityEvidence,
  type EvidenceInput,
  type EvidenceSubject,
} from "../src/index.js";

const subject: EvidenceSubject = {
  agentId: "opencode",
  agentVersion: "1.18.29",
  integrationId: "opencode",
  integrationVersion: "0.2.1",
  deploymentId: "deployment.nova",
  protocol: "openai-responses",
  platform: "linux-x64",
};

function input(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    sourceType: "maintainer-test",
    subject,
    observedAt: "2026-09-08T10:00:00.000Z",
    outcomes: [
      { capabilityId: "auth.endpoint-reachable", support: "supported" },
      { capabilityId: "protocol.streaming-order", support: "supported" },
    ],
    ...overrides,
  };
}

describe("compatibility evidence", () => {
  it("produces a schema-valid record whose TTL comes from the definitions", () => {
    const evidence = createEvidence(input());

    expect(validateCompatibilityEvidence(evidence).valid).toBe(true);
    expect(evidence.testSuite).toEqual({ id: CAPABILITY_SUITE_ID, version: CAPABILITY_SUITE_VERSION });
    expect(evidence.result).toMatchObject({ verdict: "verified", passed: 2, failed: 0 });

    const statements = evidence.result.capabilities ?? [];
    // 90 days for the static protocol field, 30 for streaming behaviour.
    expect(statements.find((item) => item.capabilityId === "auth.endpoint-reachable")?.expiresAt)
      .toBe("2026-12-07T10:00:00.000Z");
    expect(statements.find((item) => item.capabilityId === "protocol.streaming-order")?.expiresAt)
      .toBe("2026-10-08T10:00:00.000Z");
    // The record as a whole expires when its shortest-lived statement does.
    expect(evidence.expiresAt).toBe("2026-10-08T10:00:00.000Z");
  });

  it("stops counting a record once it expires or the suite major moves on", () => {
    const evidence = createEvidence(input());

    expect(isEvidenceLive(evidence, new Date("2026-10-07T10:00:00.000Z"))).toBe(true);
    expect(isEvidenceLive(evidence, new Date("2026-10-09T10:00:00.000Z"))).toBe(false);

    const fromRetiredSuite = createEvidence(
      input({ testSuite: { id: CAPABILITY_SUITE_ID, version: "0.0.4" } }),
    );
    expect(isEvidenceLive(fromRetiredSuite, new Date("2026-09-09T10:00:00.000Z"))).toBe(true);

    // A different suite major is a different suite: its results do not carry.
    const fromAnotherMajor = createEvidence(
      input({ testSuite: { id: CAPABILITY_SUITE_ID, version: "1.0.0" } }),
    );
    expect(isEvidenceLive(fromAnotherMajor, new Date("2026-09-09T10:00:00.000Z"))).toBe(false);
  });

  it("reads the run verdict off the levels the definitions default to", () => {
    expect(
      createEvidence(
        input({ outcomes: [{ capabilityId: "agent.single-tool-call", support: "unsupported" }] }),
      ).result.verdict,
    ).toBe("incompatible");

    // A preferred capability failing is a limit, not an incompatibility.
    expect(
      createEvidence(
        input({ outcomes: [{ capabilityId: "agent.structured-output", support: "unsupported" }] }),
      ).result.verdict,
    ).toBe("partial");

    expect(
      createEvidence(
        input({ outcomes: [{ capabilityId: "protocol.non-streaming", support: "unknown" }] }),
      ).result.verdict,
    ).toBe("unknown");
  });

  it("is content addressed, so the same run written twice is the same record", () => {
    expect(createEvidence(input()).id).toBe(createEvidence(input()).id);
    expect(createEvidence(input()).id).not.toBe(
      createEvidence(input({ observedAt: "2026-09-08T10:00:01.000Z" })).id,
    );
    // The form is pinned with Hub so the server can recompute it (H-2).
    expect(createEvidence(input()).id).toMatch(/^ev\.sha256\.[0-9a-f]{64}$/);

    // Identity has to cover the nested fields too: the same run against a
    // different deployment is a different record, not the same one.
    expect(createEvidence(input()).id).not.toBe(
      createEvidence(
        input({ subject: { ...subject, deploymentId: "deployment.other" } }),
      ).id,
    );
    expect(createEvidence(input()).id).not.toBe(
      createEvidence(input({ subject: { ...subject, agentVersion: "1.19.0" } })).id,
    );
  });

  it("refuses a capability the registry does not define", () => {
    expect(() =>
      createEvidence(input({ outcomes: [{ capabilityId: "protocol.invented", support: "supported" }] })),
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_CAPABILITY" }));
  });

  it("refuses a record that looks like it carries a credential", () => {
    expect(() =>
      createEvidence(input({ summary: "failed with Authorization: Bearer anrt_live_9f2b41d7c8" })),
    ).toThrowError(expect.objectContaining({ code: "EVIDENCE_REDACTION_FAILED" }));
  });
});
