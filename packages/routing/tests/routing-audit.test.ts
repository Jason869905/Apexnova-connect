import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import routingAuditSchema from "@apexnova-connect/schemas/routing-audit" with { type: "json" };

import {
  ROUTING_AUDIT_SCHEMA_VERSION,
  RoutingAuditError,
  RoutingAuditLog,
  createRoutingAuditEntry,
  routingAuditPath,
  validateRoutingAuditEntry,
} from "../src/index.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apexnova-routing-audit-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function selection() {
  return createRoutingAuditEntry({
    event: "selected",
    agentId: "opencode",
    integrationId: "opencode",
    profile: "default",
    command: "connect",
    deploymentId: "deployment.nova",
    providerId: "provider.apexnova-ai-hub",
    protocol: "openai-responses",
    grounds: "recommendation",
    recommendationId: `rec.sha256.${"a".repeat(64)}`,
    catalogVersion: "cat_1",
    transactionId: "transaction-1",
    recordedAt: "2026-09-11T20:00:00.000Z",
  });
}

describe("routing audit entries", () => {
  it("emits exactly the fields the frozen schema allows", () => {
    const entry = selection();

    expect(validateRoutingAuditEntry(entry)).toMatchObject({ valid: true });
    expect(entry.schemaVersion).toBe(ROUTING_AUDIT_SCHEMA_VERSION);
    expect(entry.id).toMatch(/^audit\.sha256\.[0-9a-f]{64}$/);
    // Checked against the schema's own property list, so a field invented in
    // code fails here rather than in whatever reads the log. The published
    // Recommendation drifted from its schema precisely because nothing compared
    // the two.
    const allowed = new Set(Object.keys(routingAuditSchema.properties));
    expect(Object.keys(entry).filter((key) => !allowed.has(key))).toEqual([]);
  });

  it("records why the deployment was chosen, not only that it was", () => {
    const entry = selection();

    // "Switched to X" is an outcome. An auditable route has to answer why, and
    // the grounds plus the Recommendation it cites are that answer.
    expect(entry.grounds).toBe("recommendation");
    expect(entry.recommendationId).toMatch(/^rec\.sha256\./);
    expect(entry.catalogVersion).toBe("cat_1");
  });

  it("refuses an entry the schema rejects instead of writing it", () => {
    expect(() =>
      createRoutingAuditEntry({
        event: "selected",
        agentId: "opencode",
        profile: "default",
        // Not one of the four grounds the schema freezes.
        grounds: "vibes" as never,
        recordedAt: "2026-09-11T20:00:00.000Z",
      }),
    ).toThrowError(RoutingAuditError);
  });

  it("keeps a decision and what it cost as two entries", async () => {
    const root = await createRoot();
    const log = new RoutingAuditLog({ path: routingAuditPath(root) });
    const selected = await log.append(selection());
    const attributed = await log.append(
      createRoutingAuditEntry({
        event: "attributed",
        agentId: "opencode",
        profile: "default",
        command: "run",
        selectionId: selected.id,
        credentialId: "rtc_1",
        attribution: {
          status: "confirmed",
          requestCount: 2,
          billedTo: [{ apiKeyId: "rtc_1", deploymentId: "deployment.nova", requestCount: 2 }],
        },
        recordedAt: "2026-09-11T20:05:00.000Z",
      }),
    );

    const entries = await log.list();
    expect(entries.map((entry) => entry.event)).toEqual(["selected", "attributed"]);
    // The second cites the first rather than amending it: what a decision cost
    // is not known when the decision is made, and rewriting the first entry
    // would destroy what an audit exists to keep -- what was believed, when.
    expect(attributed.selectionId).toBe(selected.id);
    expect(entries[0]).toEqual(selected);
  });

  it("does not lose the log to one damaged line", async () => {
    const root = await createRoot();
    const path = routingAuditPath(root);
    const log = new RoutingAuditLog({ path });
    const first = await log.append(selection());
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "{ not json\n", "utf8");
    const third = await log.append(
      createRoutingAuditEntry({
        event: "selected",
        agentId: "opencode",
        profile: "default",
        command: "switch",
        deploymentId: "deployment.other",
        grounds: "explicit",
        recordedAt: "2026-09-11T20:10:00.000Z",
      }),
    );

    const entries = await log.list();
    expect(entries.map((entry) => entry.id)).toEqual([first.id, third.id]);
  });

  it("reads an absent log as empty rather than as a failure", async () => {
    const root = await createRoot();

    expect(await new RoutingAuditLog({ path: routingAuditPath(root) }).list()).toEqual([]);
  });

  it("appends rather than rewriting", async () => {
    const root = await createRoot();
    const path = routingAuditPath(root);
    const log = new RoutingAuditLog({ path });
    await log.append(selection());
    await log.append(
      createRoutingAuditEntry({
        event: "selected",
        agentId: "opencode",
        profile: "default",
        deploymentId: "deployment.other",
        grounds: "explicit",
        recordedAt: "2026-09-11T20:10:00.000Z",
      }),
    );

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("gives an unconfirmed ledger its own status rather than calling it zero cost", () => {
    const entry = createRoutingAuditEntry({
      event: "attributed",
      agentId: "opencode",
      profile: "default",
      selectionId: `audit.sha256.${"b".repeat(64)}`,
      attribution: { status: "unconfirmed" },
      recordedAt: "2026-09-11T20:05:00.000Z",
    });

    // Settlement lags, so an empty ledger proves nothing. Recording it as
    // confirmed-with-zero-requests would be a reassurance, not an audit.
    expect(entry.attribution?.status).toBe("unconfirmed");
    expect(entry.attribution?.requestCount).toBeUndefined();
  });
});
