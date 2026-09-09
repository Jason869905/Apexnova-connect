import { describe, expect, it } from "vitest";

import {
  CAPABILITY_DEFINITIONS,
  buildCompatibilityMatrix,
  computeVerdict,
  createEvidence,
  renderCompatibilityMatrix,
  type CapabilitySupport,
  type CompatibilityEvidence,
  type EvidenceSourceType,
  type EvidenceSubject,
} from "../src/index.js";

const subject: EvidenceSubject = {
  agentId: "opencode",
  agentVersion: "1.18.29",
  integrationId: "opencode",
  integrationVersion: "0.1.0",
  deploymentId: "deployment.nova",
  protocol: "openai-responses",
  platform: "linux-x64",
};

const OBSERVED_AT = "2026-09-08T10:00:00.000Z";

function record(
  options: {
    readonly subject?: EvidenceSubject;
    readonly sourceType?: EvidenceSourceType;
    readonly observedAt?: string;
    readonly overrides?: Readonly<Record<string, CapabilitySupport>>;
  } = {},
): CompatibilityEvidence {
  return createEvidence({
    sourceType: options.sourceType ?? "maintainer-test",
    subject: options.subject ?? subject,
    observedAt: options.observedAt ?? OBSERVED_AT,
    outcomes: CAPABILITY_DEFINITIONS.map((definition) => ({
      capabilityId: definition.id,
      support: options.overrides?.[definition.id] ?? "supported",
    })),
  });
}

const NOW = new Date("2026-09-20T10:00:00.000Z");

describe("buildCompatibilityMatrix", () => {
  it("keeps one row per subject and cites the records behind it", () => {
    const other: EvidenceSubject = { ...subject, agentId: "claude-code", protocol: "anthropic-messages" };
    const evidence = [record(), record({ subject: other })];

    const matrix = buildCompatibilityMatrix({ evidence, now: NOW });

    expect(matrix.rows).toHaveLength(2);
    expect(matrix.rows.map((row) => row.subject.agentId)).toEqual(["claude-code", "opencode"]);
    expect(matrix.rows[0]?.evidenceIds).toEqual([evidence[1]?.id]);
    expect(matrix.rows[0]?.observedAt).toBe(OBSERVED_AT);
    expect(matrix.rows.every((row) => row.verdict === "compatible")).toBe(true);
  });

  it("does not merge subjects that differ, however slightly", () => {
    const evidence = [record(), record({ subject: { ...subject, agentVersion: "1.19.0" } })];

    expect(buildCompatibilityMatrix({ evidence, now: NOW }).rows).toHaveLength(2);
  });

  it("splits a deployment by the implementation each record tested, and names it", () => {
    const before = { ...subject, implementationFingerprint: "impl-a1b2c3d4e5f6" };
    const after = { ...subject, implementationFingerprint: "impl-999999999999" };
    const evidence = [record({ subject: before }), record({ subject: after })];

    const matrix = buildCompatibilityMatrix({ evidence, now: NOW });

    expect(matrix.rows).toHaveLength(2);
    // Two rows on one deployment are indistinguishable unless the render says
    // which implementation each one tested.
    const rendered = renderCompatibilityMatrix(matrix);
    expect(rendered).toContain("`deployment.nova` (impl `impl-a1b2c3d`)");
    expect(rendered).toContain("`deployment.nova` (impl `impl-9999999`)");
  });

  it("marks a row whose evidence has expired, and still shows what it said", () => {
    // 42 days on, the 30-day statements have gone stale.
    const matrix = buildCompatibilityMatrix({
      evidence: [record()],
      now: new Date("2026-10-20T10:00:00.000Z"),
    });

    expect(matrix.rows[0]).toMatchObject({ verdict: "unknown", stale: true });
    const rendered = renderCompatibilityMatrix(matrix);
    expect(rendered).toContain("has expired evidence");
    expect(rendered).toContain("untested (expired)");
  });

  it("renders an empty store as empty rather than as a verdict", () => {
    const rendered = renderCompatibilityMatrix(buildCompatibilityMatrix({ evidence: [], now: NOW }));

    expect(rendered).toContain("No evidence has been collected yet.");
    expect(rendered).not.toContain("| Agent |");
  });

  it("renders a column per capability and lists the evidence", () => {
    const evidence = [record({ overrides: { "agent.structured-output": "unsupported" } })];
    const rendered = renderCompatibilityMatrix(buildCompatibilityMatrix({ evidence, now: NOW }));

    for (const definition of CAPABILITY_DEFINITIONS) expect(rendered).toContain(definition.id);
    expect(rendered).toContain(`\`${evidence[0]?.id}\``);
    // The preferred capability failing shows as `partial` on the row and "no"
    // in its own cell, rather than a single number hiding which one fell short.
    expect(rendered).toContain("`partial`");
    expect(rendered).toContain("| yes | no |");
  });
});

describe("provider claims", () => {
  it("never lets a claim stand in for a test", () => {
    const claimed = record({ sourceType: "provider-claim" });

    const verdict = computeVerdict({ subject, evidence: [claimed], now: NOW });

    expect(verdict.verdict).toBe("unknown");
    expect(verdict.capabilities.every((capability) => capability.support === "unknown")).toBe(true);
    expect(verdict.capabilities[0]?.claimed).toBe("supported");
    expect(verdict.capabilities[0]?.reason).toContain("Only a provider claim exists");
    expect(renderCompatibilityMatrix(buildCompatibilityMatrix({ evidence: [claimed], now: NOW })))
      .toContain("claimed yes, untested");
  });

  it("does not let a newer claim override an older test result", () => {
    const tested = record({ overrides: { "agent.single-tool-call": "unsupported" } });
    const claim = record({ sourceType: "provider-claim", observedAt: "2026-09-10T10:00:00.000Z" });

    const verdict = computeVerdict({ subject, evidence: [tested, claim], now: NOW });

    expect(verdict.verdict).toBe("incompatible");
    const toolCall = verdict.capabilities.find((item) => item.capabilityId === "agent.single-tool-call");
    expect(toolCall).toMatchObject({ support: "unsupported", claimed: "supported", evidenceId: tested.id });
  });
});
