import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileEvidenceStore,
  createEvidence,
  supersededIds,
  type CompatibilityEvidence,
  type EvidenceSubject,
} from "../src/index.js";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "apexnova-connect-evidence-"));
  temporaryRoots.add(root);
  const evidenceRoot = join(root, "evidence");
  return { root, evidenceRoot, store: new FileEvidenceStore({ root: evidenceRoot }) };
}

const subject: EvidenceSubject = {
  agentId: "opencode",
  agentVersion: "1.18.29",
  integrationId: "opencode",
  integrationVersion: "0.2.1",
  deploymentId: "deployment.nova",
  protocol: "openai-responses",
  platform: "linux-x64",
};

function evidence(overrides: Partial<Parameters<typeof createEvidence>[0]> = {}): CompatibilityEvidence {
  return createEvidence({
    sourceType: "maintainer-test",
    subject,
    observedAt: "2026-09-08T10:00:00.000Z",
    outcomes: [{ capabilityId: "auth.endpoint-reachable", support: "supported" }],
    ...overrides,
  });
}

describe("FileEvidenceStore", () => {
  it("stores a record and reads it back unchanged", async () => {
    const { store, evidenceRoot } = await fixture();
    const record = evidence();

    const appended = await store.append(record);
    expect(appended.created).toBe(true);
    expect(await store.get(record.id)).toEqual(record);
    expect(await store.list()).toEqual([record]);
    expect(await readdir(evidenceRoot)).toEqual([`${record.id}.json`]);
  });

  it("treats writing the same run twice as the same record", async () => {
    const { store } = await fixture();
    const record = evidence();

    expect((await store.append(record)).created).toBe(true);
    expect((await store.append(record)).created).toBe(false);
    expect(await store.list()).toHaveLength(1);
  });

  it("refuses to let a different record take an existing ID", async () => {
    const { store, evidenceRoot } = await fixture();
    const record = await store.append(evidence());

    // Someone edited the stored file: the ID is the same, the content is not.
    const tampered = { ...(await store.get(record.evidence.id))!, sourceType: "provider-claim" as const };
    await writeFile(record.path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    await expect(store.append(record.evidence)).rejects.toMatchObject({ code: "EVIDENCE_IMMUTABLE" });
    expect(await readdir(evidenceRoot)).toHaveLength(1);
  });

  it("corrects a record by superseding it, leaving the original in place", async () => {
    const { store } = await fixture();
    const original = await store.append(evidence());
    const correction = await store.append(
      evidence({
        observedAt: "2026-09-09T10:00:00.000Z",
        outcomes: [{ capabilityId: "auth.endpoint-reachable", support: "unsupported" }],
        supersedes: original.evidence.id,
      }),
    );

    const stored = await store.list();
    expect(stored.map((item) => item.id)).toEqual([correction.evidence.id, original.evidence.id]);
    expect(supersededIds(stored)).toEqual(new Set([original.evidence.id]));
    expect(await store.get(original.evidence.id)).not.toBeNull();
  });

  it("filters by subject and reports an empty store rather than failing", async () => {
    const { store } = await fixture();
    expect(await store.list()).toEqual([]);

    await store.append(evidence());
    await store.append(
      evidence({ subject: { ...subject, deploymentId: "deployment.other" } }),
    );

    expect(await store.list({ deploymentId: "deployment.nova" })).toHaveLength(1);
    expect(await store.list({ agentId: "claude-code" })).toEqual([]);
  });

  it("rejects a stored file that no longer matches the schema", async () => {
    const { store, evidenceRoot } = await fixture();
    const record = await store.append(evidence());
    const broken = JSON.parse(await readFile(record.path, "utf8")) as Record<string, unknown>;
    delete broken.observedAt;
    await writeFile(record.path, `${JSON.stringify(broken, null, 2)}\n`, "utf8");

    await expect(store.get(record.evidence.id)).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
    expect(await readdir(evidenceRoot)).toHaveLength(1);
  });
});
