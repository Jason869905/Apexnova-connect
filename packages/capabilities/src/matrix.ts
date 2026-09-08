import { CAPABILITY_DEFINITIONS, CAPABILITY_SUITE_ID, CAPABILITY_SUITE_VERSION } from "./definitions.js";
import type { CompatibilityEvidence, EvidenceSubject } from "./evidence.js";
import {
  computeVerdict,
  type CapabilityRequirement,
  type CapabilityVerdict,
  type SubjectVerdict,
} from "./verdict.js";

export interface CompatibilityMatrixRow {
  readonly subject: EvidenceSubject;
  readonly verdict: SubjectVerdict;
  readonly capabilities: readonly CapabilityVerdict[];
  /** Every record the row rests on, so a published verdict can be traced back. */
  readonly evidenceIds: readonly string[];
  readonly observedAt?: string;
  readonly stale: boolean;
}

export interface CompatibilityMatrix {
  readonly generatedAt: string;
  readonly suite: { readonly id: string; readonly version: string };
  readonly rows: readonly CompatibilityMatrixRow[];
}

export interface MatrixOptions {
  readonly evidence: readonly CompatibilityEvidence[];
  readonly now: Date;
  readonly requirements?: readonly CapabilityRequirement[];
}

function subjectKey(subject: EvidenceSubject): string {
  return [
    subject.agentId,
    subject.agentVersion,
    subject.integrationId,
    subject.integrationVersion,
    subject.deploymentId,
    subject.protocol,
    subject.platform,
  ].join(" ");
}

/**
 * Turns the collected records into one row per subject. Nothing is aggregated
 * across subjects: a different Agent version, Deployment or platform is a
 * different question, and merging them is how a matrix ends up claiming
 * something nobody tested.
 */
export function buildCompatibilityMatrix(options: MatrixOptions): CompatibilityMatrix {
  const subjects = new Map<string, EvidenceSubject>();
  for (const record of options.evidence) subjects.set(subjectKey(record.subject), record.subject);

  const rows = [...subjects.values()]
    .map((subject) => {
      const verdict = computeVerdict({
        subject,
        evidence: options.evidence,
        now: options.now,
        ...(options.requirements ? { requirements: options.requirements } : {}),
      });
      const evidenceIds = [
        ...new Set(
          verdict.capabilities
            .map((capability) => capability.evidenceId)
            .filter((id): id is string => id !== undefined),
        ),
      ];
      const observed = verdict.capabilities
        .map((capability) => capability.observedAt)
        .filter((at): at is string => at !== undefined)
        .sort();
      const newest = observed[observed.length - 1];
      return {
        subject,
        verdict: verdict.verdict,
        capabilities: verdict.capabilities,
        evidenceIds,
        ...(newest === undefined ? {} : { observedAt: newest }),
        stale: verdict.capabilities.some((capability) => capability.stale),
      };
    })
    .sort(
      (left, right) =>
        left.subject.agentId.localeCompare(right.subject.agentId) ||
        left.subject.deploymentId.localeCompare(right.subject.deploymentId) ||
        left.subject.protocol.localeCompare(right.subject.protocol),
    );

  return {
    generatedAt: options.now.toISOString(),
    suite: { id: CAPABILITY_SUITE_ID, version: CAPABILITY_SUITE_VERSION },
    rows,
  };
}

const SUPPORT_MARK: Readonly<Record<string, string>> = {
  supported: "yes",
  partial: "partial",
  unsupported: "no",
  unknown: "untested",
};

function mark(support: string): string {
  return SUPPORT_MARK[support] ?? support;
}

function cell(capability: CapabilityVerdict | undefined): string {
  if (capability === undefined) return "untested";
  if (capability.stale) return `${mark(capability.support)} (expired)`;
  if (capability.support === "unknown" && capability.claimed !== undefined) {
    return `claimed ${mark(capability.claimed)}, untested`;
  }
  return mark(capability.support);
}

/**
 * The published artifact. Every row names the records behind it, because a
 * verdict nobody can trace is what M3 exists to stop publishing.
 */
export function renderCompatibilityMatrix(matrix: CompatibilityMatrix): string {
  const lines: string[] = [
    "# Compatibility Matrix",
    "",
    `- Generated: ${matrix.generatedAt}`,
    `- Test suite: \`${matrix.suite.id}\` ${matrix.suite.version}`,
    "- Source: Apexnova-verified test runs. A provider claim is shown as claimed and never counted as verified.",
    "",
    "Generated from the evidence store by `apexnova compatibility matrix`. Do not edit by hand.",
    "",
    "Verdicts: `compatible` every required capability passed, `partial` a preferred capability fell short, `incompatible` a required capability failed, `unknown` something required has no live evidence. Expired evidence is still shown and does not support a verdict.",
    "",
  ];

  if (matrix.rows.length === 0) {
    lines.push("No evidence has been collected yet.", "");
    return lines.join("\n");
  }

  lines.push(
    "| Agent | Version | Deployment | Protocol | Platform | Verdict | Observed |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of matrix.rows) {
    const verdict = `\`${row.verdict}\`${row.stale ? " (has expired evidence)" : ""}`;
    lines.push(
      `| ${row.subject.agentId} | ${row.subject.agentVersion} | \`${row.subject.deploymentId}\` | ${row.subject.protocol} | ${row.subject.platform} | ${verdict} | ${row.observedAt ?? "not observed"} |`,
    );
  }
  lines.push("");

  lines.push("## Capabilities", "");
  const header = ["Agent", "Deployment", "Protocol", ...CAPABILITY_DEFINITIONS.map((item) => item.id)];
  lines.push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
  for (const row of matrix.rows) {
    const cells = CAPABILITY_DEFINITIONS.map((definition) =>
      cell(row.capabilities.find((capability) => capability.capabilityId === definition.id)),
    );
    lines.push(
      `| ${row.subject.agentId} | \`${row.subject.deploymentId}\` | ${row.subject.protocol} | ${cells.join(" | ")} |`,
    );
  }
  lines.push("");

  lines.push("## Evidence", "");
  for (const row of matrix.rows) {
    const ids = row.evidenceIds.map((id) => `\`${id}\``).join(", ");
    lines.push(
      `- ${row.subject.agentId} ${row.subject.agentVersion}, \`${row.subject.deploymentId}\`, ${row.subject.protocol}: ${ids || "none"}`,
    );
  }
  lines.push("");

  return lines.join("\n");
}
