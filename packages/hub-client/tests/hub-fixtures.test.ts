import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SecretValue } from "@apexnova-connect/credential-store";
import { describe, expect, it } from "vitest";

import { HubControlPlaneClient } from "../src/index.js";

/**
 * Hub's own published fixtures, run through our parsers.
 *
 * Unit tests written from our own assumptions cannot produce the case that has
 * now bitten twice: a documented field our whitelist parser does not handle. A
 * `null` in `promoCovered` threw and reconciliation filed it as "not settled
 * yet"; `capabilityStatements` was never read, so a field Hub always sends
 * looked like a field Hub never sent. Both die here, because the test data
 * comes from the other side of the contract.
 *
 * A failure after refreshing these files is the contract having moved. It is a
 * finding, not a snapshot to update.
 */
function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../../schemas/fixtures/hub/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function clientReturning(body: unknown, status = 200) {
  return new HubControlPlaneClient({
    baseUrl: "https://hub.example.test",
    accessToken: async () => SecretValue.from("oauth-secret"),
    fetch: async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  });
}

describe("Hub's published fixtures", () => {
  it("parses the catalog snapshot, including the evidence level on each capability", async () => {
    const snapshot = await clientReturning(fixture("catalog-snapshot.json")).catalog();
    const deployment = snapshot.deployments[0]!;

    expect(deployment.capabilityStatements.length).toBeGreaterThan(0);
    // Everything the catalog emits today is a claim nobody has measured, which
    // is exactly why it must not be read as a tested result.
    expect(deployment.capabilityStatements.every((statement) => statement.sourceType === "provider-claim")).toBe(true);
    expect(deployment.capabilityStatements.map((statement) => statement.capabilityId)).toContain("tool.calling");
    expect(deployment.implementationFingerprint).toBeDefined();
  });

  it("parses a usage list whose unsettled row has no money at all", async () => {
    const result = await clientReturning(fixture("billing-usage.json")).usageQuery({});
    if ("granularity" in result) throw new Error("expected a usage list");

    const settled = result.items.find((item) => item.settlementStatus === "settled");
    const unsettled = result.items.find((item) => item.settlementStatus !== "settled");

    expect(settled).toMatchObject({ amount: "0.000214", apiKeyKind: "user" });
    // amount, promoCovered and balanceCovered are all null here. Refusing any
    // one of them takes the record down, and a record we cannot read is
    // indistinguishable from a request Hub never wrote a row for.
    expect(unsettled).toBeDefined();
    expect(unsettled?.amount).toBeUndefined();
    expect(unsettled?.promoCovered).toBeUndefined();
    expect(unsettled?.balanceCovered).toBeUndefined();
    expect(unsettled?.status).toBeUndefined();
  });

  it("parses the aggregate usage view", async () => {
    const result = await clientReturning(fixture("usage-aggregate.json")).usageQuery({ granularity: "day" });
    if (!("granularity" in result)) throw new Error("expected an aggregate");
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("parses a pricing estimate, including where the discount comes from", async () => {
    const estimate = fixture("pricing-estimate.json") as { readonly deploymentId: string };
    const parsed = await clientReturning(estimate).estimatePricing(estimate.deploymentId, { inputTokens: 13, outputTokens: 32 });

    expect(parsed.discount).toBeDefined();
    expect(parsed.discount?.rate).toBe(parsed.discountRate);
  });

  it("parses the account, balance, keys and runtime credentials", async () => {
    await expect(clientReturning(fixture("me.json")).me()).resolves.toMatchObject({ userId: expect.any(String) });
    await expect(clientReturning(fixture("billing-balance.json")).balance()).resolves.toMatchObject({ currency: expect.any(String) });
    await expect(clientReturning(fixture("api-keys-list.json")).apiKeys()).resolves.toBeInstanceOf(Array);
    await expect(clientReturning(fixture("runtime-credentials-list.json")).runtimeCredentials()).resolves.toBeInstanceOf(Array);
  });

  it("parses an evidence record, a listing and the registered suites", async () => {
    const record = await clientReturning(fixture("compatibility-evidence.json")).compatibilityEvidenceById("ev.sha256.aa");
    expect(record.received.signatureStatus).toBe("none");
    expect(record.derived.capabilityStatus.length).toBeGreaterThan(0);
    expect(record.derived.fingerprint?.match).toBe("match");
    // Hub returns the submission untouched; nothing of ours is merged into it.
    expect(record.payload).toMatchObject({ schemaVersion: "0.1" });

    const listing = await clientReturning(fixture("compatibility-evidence-list.json")).compatibilityEvidence({});
    expect(listing.items.length).toBeGreaterThan(0);

    const suites = await clientReturning(fixture("compatibility-test-suites.json")).compatibilityTestSuites();
    expect(suites.items[0]).toMatchObject({ suiteId: "apexnova.capability-suite" });
  });

  it("maps a documented error body to a client error carrying Hub's own code", async () => {
    const error = await clientReturning(fixture("error-evidence-immutable.json"), 409)
      .submitCompatibilityEvidence({ id: "ev.sha256.aa" })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({ apiCode: "evidence_immutable", retryable: false });
  });
});
