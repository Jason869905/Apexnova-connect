import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = ["opencode", "codex", "claude-code", "hermes"] as const;

/**
 * The status ladder's mechanical half, from [ADR 0023](../docs/decisions/0023-integration-status-ladder.md).
 *
 * Criteria 1 and 4 -- every declared platform x protocol carries a real verdict,
 * and the documentation exists -- are checkable from the repository. Criteria 2,
 * 3 and 5 are human judgements and are not attempted here.
 */
interface Manifest {
  readonly id: string;
  readonly status: string;
  readonly compatibility: { readonly platforms: readonly string[] };
  readonly protocols: readonly { readonly id: string }[];
}

interface MatrixRow {
  readonly agentId: string;
  readonly protocol: string;
  readonly platform: string;
  readonly verdict: string;
}

/**
 * The committed matrix, not a live evidence store: a check that read the
 * developer's own store would pass or fail by machine, and the whole point is
 * that a claim of `stable` is refutable by anyone who clones the repository.
 */
function parseMatrix(markdown: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 7 || cells[0] === "Agent" || cells[0]?.startsWith("---")) continue;
    rows.push({ agentId: cells[0]!, protocol: cells[3]!, platform: cells[4]!, verdict: cells[5]!.replaceAll("`", "") });
  }
  return rows;
}

/** Evidence platforms are `<platform>-<arch>`; manifests name the platform only. */
function coversPlatform(evidencePlatform: string, declared: string): boolean {
  return evidencePlatform === declared || evidencePlatform.startsWith(`${declared}-`);
}

/**
 * Evidence records the catalog's spelling so a subject cannot split in two, and
 * the catalog calls this one `openai-chat` while manifests and the schema call
 * it `openai-chat-completions`. Normalised towards the schema, which is the
 * vocabulary the manifest is written in.
 */
function schemaProtocol(evidenceProtocol: string): string {
  return evidenceProtocol === "openai-chat" ? "openai-chat-completions" : evidenceProtocol;
}

function missingCriteria(manifest: Manifest, matrix: readonly MatrixRow[], docs: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  for (const platform of manifest.compatibility.platforms) {
    for (const protocol of manifest.protocols) {
      const measured = matrix.some((row) =>
        row.agentId === manifest.id
        && schemaProtocol(row.protocol) === protocol.id
        && coversPlatform(row.platform, platform)
        // A verdict, not a passing one: `partial` and `incompatible` are real
        // findings. Only `unknown` means nothing was measured.
        && row.verdict !== "unknown");
      if (!measured) missing.push(`evidence:${platform}/${protocol.id}`);
    }
  }
  if (!docs.has(`${manifest.id}-usage-guide.md`)) missing.push("docs:usage-guide");
  return missing;
}

/**
 * What each Integration is short of today, from ADR 0023 section 5.
 *
 * Written down rather than merely computed so the check is not vacuous: with no
 * manifest claiming `stable`, an "over-claiming fails" assertion alone would
 * pass forever. Adding evidence or narrowing a platform claim breaks this table,
 * which is the point -- the author then has to revisit the status too.
 */
const EXPECTED_GAPS: Readonly<Record<string, readonly string[]>> = {
  // All four are mechanically clear as of 2026-09-13 (ADR 0032): macOS was
  // withdrawn rather than claimed unbacked, the suite grew a third protocol,
  // and the Windows rows were collected by running the CLI natively on Windows
  // rather than through WSL.
  //
  // Clear here is not `stable`. Three of ADR 0023's five criteria are human
  // judgements, and only `hermes` has been through them (ADR 0031).
  opencode: [],
  codex: [],
  "claude-code": [],
  hermes: [],
};

describe("the integration status ladder", () => {
  it("holds every Integration to what its manifest claims", async () => {
    const matrix = parseMatrix(await readFile(join(ROOT, "docs", "compatibility-matrix.md"), "utf8"));
    // Not vacuous by accident: the matrix has to have parsed, or every
    // integration would look unmeasured and the table below would still match.
    expect(matrix.length).toBeGreaterThan(10);
    const { readdir } = await import("node:fs/promises");
    const docs = new Set(await readdir(join(ROOT, "docs")));

    for (const agent of AGENTS) {
      const manifest = JSON.parse(
        await readFile(join(ROOT, "integrations", "agents", agent, "manifest.json"), "utf8"),
      ) as Manifest;
      const missing = missingCriteria(manifest, matrix, docs);

      // Over-claiming fails: `stable` requires the mechanical criteria to hold.
      if (manifest.status === "stable") expect(missing).toEqual([]);
      // And the gaps are reconciled against what ADR 0023 recorded, so closing
      // one forces the status to be reconsidered rather than silently drifting.
      expect({ [agent]: [...missing].sort() }).toEqual({ [agent]: [...EXPECTED_GAPS[agent]!].sort() });
    }
  });

  it("counts a real finding as measured, and only `unknown` as unmeasured", () => {
    const manifest: Manifest = {
      id: "example", status: "stable",
      compatibility: { platforms: ["linux"] }, protocols: [{ id: "openai-responses" }],
    };
    const row = { agentId: "example", protocol: "openai-responses", platform: "linux-x64" };

    // `stable` asks that the range was measured, not that it all passed. An
    // Integration that honestly reports a capability as unsupported is better
    // documented than one nobody ran.
    expect(missingCriteria(manifest, [{ ...row, verdict: "partial" }], new Set(["example-usage-guide.md"]))).toEqual([]);
    expect(missingCriteria(manifest, [{ ...row, verdict: "incompatible" }], new Set(["example-usage-guide.md"]))).toEqual([]);
    expect(missingCriteria(manifest, [{ ...row, verdict: "unknown" }], new Set(["example-usage-guide.md"])))
      .toEqual(["evidence:linux/openai-responses"]);
  });
});
