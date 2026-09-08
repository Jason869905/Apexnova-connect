import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalEvidenceJson, evidenceContentHash, evidenceId } from "../src/index.js";

const VECTORS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "schemas",
  "fixtures",
  "evidence-canonical-vectors.json",
);

interface Vector {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly canonical: string;
  readonly sha256: string;
  readonly id: string;
}

/**
 * The content hash is only a hash if both sides compute the same one. These
 * vectors are shared with Hub and pinned on both sides: two implementations that
 * never compare notes is how this kind of agreement quietly stops holding.
 *
 * Changing a value here means the hash rule changed, which invalidates every
 * stored ID -- treat a failure as a contract question, not a snapshot to update.
 */
describe("evidence canonical hash vectors", () => {
  it("reproduces every shared vector", async () => {
    const document = JSON.parse(await readFile(VECTORS, "utf8")) as { readonly vectors: readonly Vector[] };

    expect(document.vectors.length).toBeGreaterThanOrEqual(3);
    for (const vector of document.vectors) {
      expect(canonicalEvidenceJson(vector.input), `${vector.name}: canonical form`).toBe(vector.canonical);
      expect(evidenceContentHash(vector.input), `${vector.name}: sha256`).toBe(vector.sha256);
      expect(vector.id).toBe(`ev.sha256.${vector.sha256}`);
    }
  });

  it("drops id and signature, sorts keys at every level and leaves arrays alone", () => {
    const withoutIdentity = {
      b: 1,
      a: { d: [{ z: 1, y: 2 }, { y: 3, z: 4 }], c: "x" },
      id: "ev.sha256.deadbeef",
      signature: "sig",
    };

    expect(canonicalEvidenceJson(withoutIdentity)).toBe('{"a":{"c":"x","d":[{"y":2,"z":1},{"y":3,"z":4}]},"b":1}');
    // Reordering the input must not move the hash; reordering an array must.
    expect(evidenceContentHash({ b: 1, a: { c: "x" } })).toBe(evidenceContentHash({ a: { c: "x" }, b: 1 }));
    expect(evidenceContentHash({ a: [1, 2] })).not.toBe(evidenceContentHash({ a: [2, 1] }));
  });

  it("derives the ID from the hash", () => {
    const record = {
      schemaVersion: "0.1",
      sourceType: "maintainer-test" as const,
      subject: {
        agentId: "opencode",
        agentVersion: "1.18.29",
        integrationId: "opencode",
        integrationVersion: "0.1.0",
        deploymentId: "deployment.nova",
        protocol: "openai-responses",
        platform: "linux-x64",
      },
      testSuite: { id: "apexnova.capability-suite", version: "0.2.0" },
      result: { verdict: "verified" as const, passed: 1, failed: 0 },
      observedAt: "2026-09-08T10:00:00.000Z",
      expiresAt: "2026-12-07T10:00:00.000Z",
    };

    expect(evidenceId(record)).toBe(`ev.sha256.${evidenceContentHash(record)}`);
  });
});
