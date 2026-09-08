import { describe, expect, it } from "vitest";

import {
  CAPABILITY_DEFINITIONS,
  computeVerdict,
  createEvidence,
  type CapabilitySupport,
  type CompatibilityEvidence,
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

const OBSERVED_AT = "2026-09-08T10:00:00.000Z";

/** A full suite run, with the named capabilities overridden. */
function run(
  overrides: Readonly<Record<string, CapabilitySupport>> = {},
  options: { readonly observedAt?: string; readonly supersedes?: string; readonly subject?: EvidenceSubject } = {},
): CompatibilityEvidence {
  return createEvidence({
    sourceType: "maintainer-test",
    subject: options.subject ?? subject,
    observedAt: options.observedAt ?? OBSERVED_AT,
    outcomes: CAPABILITY_DEFINITIONS.map((definition) => ({
      capabilityId: definition.id,
      support: overrides[definition.id] ?? "supported",
    })),
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
  });
}

describe("computeVerdict", () => {
  it("reads compatible when every required capability has live evidence", () => {
    const verdict = computeVerdict({
      subject,
      evidence: [run()],
      now: new Date("2026-09-20T10:00:00.000Z"),
    });

    expect(verdict.verdict).toBe("compatible");
    expect(verdict.capabilities).toHaveLength(CAPABILITY_DEFINITIONS.length);
    expect(verdict.capabilities.every((capability) => !capability.stale)).toBe(true);
  });

  it("reads incompatible when a required capability failed", () => {
    const verdict = computeVerdict({
      subject,
      evidence: [run({ "agent.single-tool-call": "unsupported" })],
      now: new Date("2026-09-20T10:00:00.000Z"),
    });

    expect(verdict.verdict).toBe("incompatible");
    expect(verdict.reasons).toContain("agent.single-tool-call is required and failed.");
  });

  it("reads partial when only a preferred capability is short", () => {
    const verdict = computeVerdict({
      subject,
      evidence: [run({ "agent.structured-output": "partial" })],
      now: new Date("2026-09-20T10:00:00.000Z"),
    });

    expect(verdict.verdict).toBe("partial");
    expect(verdict.reasons).toContain("agent.structured-output is partial and the level is preferred.");
  });

  it("falls back to unknown once the evidence expires, and says which record expired", () => {
    const evidence = run();
    // 42 days on: the 90-day protocol statements still stand, the 30-day
    // streaming and tool-call ones do not.
    const verdict = computeVerdict({
      subject,
      evidence: [evidence],
      now: new Date("2026-10-20T10:00:00.000Z"),
    });

    expect(verdict.verdict).toBe("unknown");
    const streaming = verdict.capabilities.find(
      (capability) => capability.capabilityId === "protocol.streaming-order",
    );
    expect(streaming).toMatchObject({ support: "unknown", stale: true, evidenceId: evidence.id });
    expect(streaming?.reason).toContain("expired on 2026-10-08T10:00:00.000Z");

    const auth = verdict.capabilities.find(
      (capability) => capability.capabilityId === "auth.endpoint-reachable",
    );
    expect(auth).toMatchObject({ support: "supported", stale: false });
  });

  it("ignores a superseded record in favour of the one replacing it", () => {
    const wrong = run({ "protocol.non-streaming": "unsupported" });
    const correction = run({}, { observedAt: "2026-09-09T10:00:00.000Z", supersedes: wrong.id });

    expect(
      computeVerdict({
        subject,
        evidence: [wrong, correction],
        now: new Date("2026-09-20T10:00:00.000Z"),
      }).verdict,
    ).toBe("compatible");

    // Without the supersedes link the newer record simply wins on recency, but
    // the failure is still on file rather than erased.
    expect(
      computeVerdict({
        subject,
        evidence: [wrong],
        now: new Date("2026-09-20T10:00:00.000Z"),
      }).verdict,
    ).toBe("incompatible");
  });

  it("does not carry evidence across a version or platform change", () => {
    const evidence = [run()];
    for (const changed of [
      { ...subject, agentVersion: "1.19.0" },
      { ...subject, integrationVersion: "0.3.0" },
      { ...subject, platform: "darwin-arm64" },
      { ...subject, deploymentId: "deployment.other" },
    ]) {
      const verdict = computeVerdict({ subject: changed, evidence, now: new Date("2026-09-20T10:00:00.000Z") });
      expect(verdict.verdict).toBe("unknown");
      expect(verdict.capabilities.every((capability) => capability.evidenceId === undefined)).toBe(true);
    }
  });

  it("takes the level from the Agent's requirements when they are supplied", () => {
    const evidence = [run({ "protocol.streaming-order": "unsupported" })];
    const now = new Date("2026-09-20T10:00:00.000Z");

    expect(computeVerdict({ subject, evidence, now }).verdict).toBe("incompatible");
    expect(
      computeVerdict({
        subject,
        evidence,
        now,
        requirements: [{ capabilityId: "protocol.streaming-order", level: "optional" }],
      }).verdict,
    ).toBe("compatible");

    expect(() =>
      computeVerdict({
        subject,
        evidence,
        now,
        requirements: [{ capabilityId: "protocol.invented", level: "required" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_CAPABILITY" }));
  });
});
