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
    subject.implementationFingerprint ?? "-",
  ].join(" ");
}

/**
 * The published order has to come from the subject alone. Comparing only agent,
 * deployment and protocol left the rest to the store's iteration order, so two
 * runs over the same records could publish the same rows in a different order --
 * the kind of difference that shows up as a diff nobody made.
 */
function compareSubjects(left: EvidenceSubject, right: EvidenceSubject): number {
  return (
    left.agentId.localeCompare(right.agentId) ||
    left.deploymentId.localeCompare(right.deploymentId) ||
    left.protocol.localeCompare(right.protocol) ||
    left.platform.localeCompare(right.platform) ||
    left.agentVersion.localeCompare(right.agentVersion) ||
    left.integrationId.localeCompare(right.integrationId) ||
    left.integrationVersion.localeCompare(right.integrationVersion) ||
    (left.implementationFingerprint ?? "").localeCompare(right.implementationFingerprint ?? "")
  );
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
    .sort((left, right) => compareSubjects(left.subject, right.subject));

  return {
    generatedAt: options.now.toISOString(),
    suite: { id: CAPABILITY_SUITE_ID, version: CAPABILITY_SUITE_VERSION },
    rows,
  };
}

/**
 * Two rows can share a deployment and differ only in the implementation tested,
 * so the implementation is named wherever the deployment is.
 */
function deploymentCell(subject: EvidenceSubject): string {
  const fingerprint = subject.implementationFingerprint;
  return fingerprint === undefined
    ? `\`${subject.deploymentId}\``
    : `\`${subject.deploymentId}\` (impl \`${fingerprint.slice(0, 12)}\`)`;
}

/**
 * The same identity in every table. A row is one subject, and the subject is
 * more than agent, deployment and protocol: the first Windows collection
 * produced capability rows byte-identical to the Linux ones, because those
 * three were the only columns the capability table carried. Two platforms are
 * two questions, so they have to read as two rows.
 */
const IDENTITY_HEADER = ["Agent", "Version", "Deployment", "Protocol", "Platform"] as const;

function identityCells(subject: EvidenceSubject): readonly string[] {
  return [
    subject.agentId,
    subject.agentVersion,
    deploymentCell(subject),
    subject.protocol,
    subject.platform,
  ];
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
 * The traceability record, so it names the whole subject rather than the part
 * that fits a column: the integration and its version decide how a config was
 * read, and two of them can disagree about one Agent.
 */
function evidenceSubjectLine(subject: EvidenceSubject): string {
  const integration = `integration ${subject.integrationId} ${subject.integrationVersion}`;
  return [
    `${subject.agentId} ${subject.agentVersion}`,
    deploymentCell(subject),
    subject.protocol,
    subject.platform,
    integration,
  ].join(", ");
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

  const verdictHeader = [...IDENTITY_HEADER, "Verdict", "Observed"];
  lines.push(`| ${verdictHeader.join(" | ")} |`, `| ${verdictHeader.map(() => "---").join(" | ")} |`);
  for (const row of matrix.rows) {
    const verdict = `\`${row.verdict}\`${row.stale ? " (has expired evidence)" : ""}`;
    lines.push(
      `| ${identityCells(row.subject).join(" | ")} | ${verdict} | ${row.observedAt ?? "not observed"} |`,
    );
  }
  lines.push("");

  lines.push("## Capabilities", "");
  const header = [...IDENTITY_HEADER, ...CAPABILITY_DEFINITIONS.map((item) => item.id)];
  lines.push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
  for (const row of matrix.rows) {
    const cells = CAPABILITY_DEFINITIONS.map((definition) =>
      cell(row.capabilities.find((capability) => capability.capabilityId === definition.id)),
    );
    lines.push(`| ${identityCells(row.subject).join(" | ")} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Evidence", "");
  for (const row of matrix.rows) {
    const ids = row.evidenceIds.map((id) => `\`${id}\``).join(", ");
    lines.push(`- ${evidenceSubjectLine(row.subject)}: ${ids || "none"}`);
  }
  lines.push("");

  return lines.join("\n");
}
