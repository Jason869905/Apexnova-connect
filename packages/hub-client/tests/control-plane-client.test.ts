import { SecretValue } from "@apexnova-connect/credential-store";
import { describe, expect, it, vi } from "vitest";

import { HubClientError, HubControlPlaneClient } from "../src/index.js";

function client(fetch: typeof globalThis.fetch) {
  return new HubControlPlaneClient({
    baseUrl: "https://hub.example.test",
    accessToken: async () => SecretValue.from("oauth-secret"),
    fetch,
  });
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

describe("HubControlPlaneClient", () => {
  it("reads and validates the atomic catalog snapshot", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      schemaVersion: "0.1",
      catalogVersion: "cat_123",
      generatedAt: "2026-09-03T12:00:00Z",
      expiresAt: "2026-09-03T12:15:00Z",
      providers: [{ id: "provider.apexnova-ai-hub", name: "Apexnova", kind: "platform" }],
      models: [{ id: "model.nova", name: "Nova", publisher: "apexnova", modelType: "chat", capabilities: [], deploymentIds: ["deployment.nova"] }],
      deployments: [{
        id: "deployment.nova", providerId: "provider.apexnova-ai-hub", modelId: "model.nova", displayName: "Nova", inferenceAlias: "nova", aliases: ["nova"],
        protocols: [{ protocol: "openai-responses", baseUrl: "https://api.example.test/v1/responses" }], capabilities: [],
        availability: { status: "available", observedAt: "2026-09-03T12:00:00Z" },
      }],
    }));

    const result = await client(fetch).catalog();

    expect(result.deployments[0]?.inferenceAlias).toBe("nova");
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://hub.example.test/v1/catalog/snapshot"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer oauth-secret" }) }),
    );
  });

  it("reads a deployment that has no fingerprint and no observed change", async () => {
    // The ordinary case once fingerprints ship: null means "no upstream line
    // enabled" and "never seen it change", not a malformed catalog.
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      schemaVersion: "0.1",
      catalogVersion: "cat_123",
      generatedAt: "2026-09-03T12:00:00Z",
      expiresAt: "2026-09-03T12:15:00Z",
      providers: [],
      models: [],
      deployments: [{
        id: "deployment.nova", providerId: "provider.apexnova-ai-hub", modelId: "model.nova", displayName: "Nova", inferenceAlias: "nova",
        protocols: [{ protocol: "openai-responses", baseUrl: "https://api.example.test/v1/responses" }], capabilities: [],
        implementationFingerprint: null,
        implementationChangedAt: null,
        availability: { status: "available" },
      }],
    }));

    const result = await client(fetch).catalog();

    expect(result.deployments[0]?.implementationFingerprint).toBeUndefined();
    expect(result.deployments[0]?.implementationChangedAt).toBeUndefined();
  });

  it("carries the fingerprint and the moment it last changed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      schemaVersion: "0.1",
      catalogVersion: "cat_124",
      generatedAt: "2026-09-03T12:00:00Z",
      expiresAt: "2026-09-03T12:15:00Z",
      providers: [],
      models: [],
      deployments: [{
        id: "deployment.nova", providerId: "provider.apexnova-ai-hub", modelId: "model.nova", displayName: "Nova", inferenceAlias: "nova",
        protocols: [{ protocol: "openai-responses", baseUrl: "https://api.example.test/v1/responses" }], capabilities: [],
        implementationFingerprint: "a3f19c04b7e25d18",
        implementationChangedAt: "2026-09-15T10:00:00.000Z",
        availability: { status: "available" },
      }],
    }));

    const result = await client(fetch).catalog();

    expect(result.deployments[0]).toMatchObject({
      implementationFingerprint: "a3f19c04b7e25d18",
      implementationChangedAt: "2026-09-15T10:00:00.000Z",
    });
  });

  it("never includes the bearer token in a network error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("offline"));
    const error = await client(fetch).me().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "NETWORK_ERROR", retryable: true });
    expect(JSON.stringify(error)).not.toContain("oauth-secret");
    expect(String(error)).not.toContain("oauth-secret");
  });

  it("maps control-plane errors without retaining untrusted details", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      error: { code: "insufficient_balance", message: "Balance required.", retryable: false, details: { leaked: "secret" } },
    }, { status: 402, headers: { "x-apexnova-request-id": "req_123" } }));

    const error = await client(fetch).balance().catch((value: unknown) => value);

    expect(error).toMatchObject<Partial<HubClientError>>({ code: "BILLING_BLOCKED", requestId: "req_123", retryable: false });
    expect(JSON.stringify(error)).not.toContain("leaked");
  });

  it("rejects credential-bearing catalog URLs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      schemaVersion: "0.1", catalogVersion: "cat_123", generatedAt: "2026-09-03T12:00:00Z", expiresAt: "2026-09-03T12:15:00Z", providers: [], models: [],
      deployments: [{ id: "deployment.nova", providerId: "provider.hub", modelId: "model.nova", displayName: "Nova", inferenceAlias: "nova", protocols: [{ protocol: "openai-responses", baseUrl: "https://user:secret@example.test/v1/responses" }], capabilities: [], availability: { status: "available" } }],
    }));
    await expect(client(fetch).catalog()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("allows HTTP catalog URLs only for an explicitly enabled loopback Hub", async () => {
    const response = (baseUrl: string) => json({
      schemaVersion: "0.1", catalogVersion: "cat_local", generatedAt: "2026-09-03T12:00:00Z", expiresAt: "2026-09-03T12:15:00Z", providers: [], models: [],
      deployments: [{ id: "deployment.nova", providerId: "provider.hub", modelId: "model.nova", displayName: "Nova", inferenceAlias: "nova", protocols: [{ protocol: "openai-chat", baseUrl }], capabilities: [], availability: { status: "available" } }],
    });
    const loopbackFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response("http://api.localhost:18080/v1/chat/completions"));
    const loopback = new HubControlPlaneClient({
      baseUrl: "http://localhost:18080",
      accessToken: async () => SecretValue.from("oauth-secret"),
      allowInsecureLoopback: true,
      fetch: loopbackFetch,
    });

    await expect(loopback.catalog()).resolves.toMatchObject({ catalogVersion: "cat_local" });

    const remoteFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response("http://api.example.test/v1/chat/completions"));
    const remote = new HubControlPlaneClient({
      baseUrl: "https://hub.example.test",
      accessToken: async () => SecretValue.from("oauth-secret"),
      allowInsecureLoopback: true,
      fetch: remoteFetch,
    });
    await expect(remote.catalog()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("returns a one-time runtime secret as SecretValue", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      credentialId: "rtc_123",
      secret: "anrt_super-secret",
      expiresAt: "2026-09-04T12:00:00Z",
      deviceId: "device_123",
    }));
    const result = await client(fetch).createRuntimeCredential({ name: "OpenCode", protocols: ["openai-responses"], publicDeploymentIds: ["deployment.nova"] });
    expect(result.secret.toJSON()).toBe("[REDACTED]");
    expect(result.credentialId).toBe("rtc_123");
    expect(JSON.stringify(result)).not.toContain("anrt_super-secret");
  });

  it("returns the non-binding token estimate used by live verification", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      deploymentId: "deployment.nova",
      model: "nova",
      currency: "USD",
      billingMode: "token",
      listAmount: "0.000120",
      discountRate: "0.5",
      amount: "0.000060",
      priceVersion: "2026-09-05T10:00:00Z",
      estimateOnly: true,
    }));

    const result = await client(fetch).estimatePricing("deployment.nova", { inputTokens: 64, outputTokens: 256 });

    expect(result).toMatchObject({ amount: "0.000060", estimateOnly: true });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://hub.example.test/v1/pricing/estimate"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ deploymentId: "deployment.nova", usage: { inputTokens: 64, outputTokens: 256 } }),
      }),
    );
  });

  it("reads where a discount comes from and when it lapses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      deploymentId: "deployment.nova",
      model: "nova",
      currency: "USD",
      billingMode: "token",
      listAmount: "0.000120",
      discountRate: "0.5",
      discount: {
        rate: "0.5",
        source: "campaign.launch",
        appliesTo: "deployment.nova",
        // A time-of-day promotion expires at the end of this window, not of the campaign.
        expiresAt: "2026-09-09T18:00:00Z",
      },
      amount: "0.000060",
      estimateOnly: true,
    }));

    const result = await client(fetch).estimatePricing("deployment.nova", { inputTokens: 64, outputTokens: 256 });

    expect(result.discount).toEqual({
      rate: "0.5",
      source: "campaign.launch",
      appliesTo: "deployment.nova",
      expiresAt: "2026-09-09T18:00:00Z",
    });
  });

  it("rejects an estimate for a different deployment", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      deploymentId: "deployment.other",
      model: "other",
      currency: "USD",
      billingMode: "token",
      listAmount: "0.000120",
      amount: "0.000120",
      estimateOnly: true,
    }));

    await expect(client(fetch).estimatePricing("deployment.nova", { inputTokens: 64, outputTokens: 256 }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("lists active runtime credential metadata without exposing secrets", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      items: [{
        credentialId: "rtc_123",
        name: "OpenCode",
        prefix: "anrt_abcd...wxyz",
        deviceId: "device_123",
        workspaceId: null,
        protocols: ["openai-responses"],
        publicDeploymentIds: ["deployment.nova"],
        expiresAt: "2026-09-06T10:00:00Z",
        createdAt: "2026-09-05T10:00:00Z",
        lastUsedAt: null,
      }],
      nextCursor: null,
    }));

    await expect(client(fetch).runtimeCredentials()).resolves.toEqual([{
      credentialId: "rtc_123",
      name: "OpenCode",
      prefix: "anrt_abcd...wxyz",
      deviceId: "device_123",
      protocols: ["openai-responses"],
      publicDeploymentIds: ["deployment.nova"],
      expiresAt: "2026-09-06T10:00:00Z",
      createdAt: "2026-09-05T10:00:00Z",
    }]);
  });

  it("reconciles a single request by its requestId", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      items: [{
        id: "use_00000000000000000000000001",
        requestId: "55978fdf-a840-4673-b6a5-8f3e237cae6f",
        at: "2026-09-05T23:00:00Z",
        status: "success",
        statusCode: null,
        requestedModel: "glm-5.2",
        requestedDeploymentId: "deployment.apexnova.mdl00000000000000000000001",
        resolvedModel: "glm-5.2",
        resolvedDeploymentId: "deployment.apexnova.mdl00000000000000000000001",
        fallbackApplied: false,
        workspaceId: "wsp_00000000000000000000000001",
        source: "api",
        usage: { inputTokens: 6964, outputTokens: 7, cachedInputTokens: 0, items: 0 },
        currency: "USD",
        amount: "0.006978",
        promoCovered: "0.000000",
        balanceCovered: "0.006978",
        discountRate: null,
      }],
      nextCursor: null,
    }));

    const result = await client(fetch).usage("55978fdf-a840-4673-b6a5-8f3e237cae6f");

    expect(result).toMatchObject({ requestId: "55978fdf-a840-4673-b6a5-8f3e237cae6f", amount: "0.006978", currency: "USD" });
    expect(result?.usage).toMatchObject({ inputTokens: 6964, outputTokens: 7 });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://hub.example.test/v1/billing/usage?requestId=55978fdf-a840-4673-b6a5-8f3e237cae6f"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer oauth-secret" }) }),
    );
  });

  it("keeps an unsettled request unpriced instead of reading it as free", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      items: [{
        id: "use_00000000000000000000000002",
        requestId: "44c55922-3161-4620-881f-13cc514eeb98",
        at: "2026-09-08T23:00:00Z",
        status: "success",
        resolvedModel: "glm-5.2",
        source: "api",
        usage: { inputTokens: 12, outputTokens: 0 },
        currency: "USD",
        amount: null,
        settlementStatus: "pending",
        abortedAt: "2026-09-08T23:00:01Z",
      }],
      nextCursor: null,
    }));

    const result = await client(fetch).usage("44c55922-3161-4620-881f-13cc514eeb98");

    expect(result).toMatchObject({ settlementStatus: "pending", abortedAt: "2026-09-08T23:00:01Z" });
    expect(result?.amount).toBeUndefined();
  });

  it("reads a record whose money fields are all null", async () => {
    // A not-billable row carries null for amount, promoCovered and
    // balanceCovered. Refusing one of them takes the whole record down, and a
    // record that cannot be parsed is indistinguishable, to the caller, from a
    // request Hub never wrote a row for.
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      items: [{
        id: "use_00000000000000000000000003",
        requestId: "98627d46-92ed-4a9b-816b-9675b6f86699",
        at: "2026-09-09T15:10:16.000Z",
        status: null,
        resolvedModel: "glm-5.2",
        source: "api",
        usage: {},
        currency: "USD",
        amount: null,
        promoCovered: null,
        balanceCovered: null,
        discountRate: null,
        apiKeyId: null,
        apiKeyName: null,
        apiKeyKind: null,
        settlementStatus: "not-billable",
        abortedAt: "2026-09-09T15:10:16.254Z",
      }],
      nextCursor: null,
    }));

    const result = await client(fetch).usage("98627d46-92ed-4a9b-816b-9675b6f86699");

    expect(result).toMatchObject({ settlementStatus: "not-billable", abortedAt: "2026-09-09T15:10:16.254Z" });
    expect(result?.amount).toBeUndefined();
    expect(result?.promoCovered).toBeUndefined();
    expect(result?.status).toBeUndefined();
  });

  it("reads which key a usage record was billed to", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      items: [{
        id: "use_4", requestId: "req_4", at: "2026-09-09T15:10:16.000Z", status: "success",
        resolvedModel: "glm-5.2", source: "api", usage: { inputTokens: 3 }, currency: "USD", amount: "0.000100",
        apiKeyId: "rtc_1", apiKeyName: "OpenCode capability suite", apiKeyKind: "runtime",
        settlementStatus: "settled",
      }],
      nextCursor: null,
    }));

    await expect(client(fetch).usage("req_4")).resolves.toMatchObject({
      apiKeyId: "rtc_1",
      apiKeyName: "OpenCode capability suite",
      apiKeyKind: "runtime",
    });
  });

  it("rejects a settlement status it does not know", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      items: [{
        id: "use_1", requestId: "req_1", at: "2026-09-08T23:00:00Z", status: "success",
        resolvedModel: "glm-5.2", source: "api", usage: {}, currency: "USD", amount: null,
        settlementStatus: "maybe",
      }],
      nextCursor: null,
    }));
    await expect(client(fetch).usage("req_1")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("returns undefined when the usage record is not found or not visible", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ items: [], nextCursor: null }));
    await expect(client(fetch).usage("00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
  });

  it("rejects a malformed usage record", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      items: [{ id: "use_1", requestId: "req_1", at: "not-a-date", status: "success", resolvedModel: "glm-5.2", usage: {}, currency: "USD", amount: "0.01" }],
      nextCursor: null,
    }));
    await expect(client(fetch).usage("req_1")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("keeps the submission, Hub's receipt and Hub's derivation apart", async () => {
    // Shaped after Hub's own openapi/fixtures/compatibility-evidence.json.
    const payload = { schemaVersion: "0.1", id: "ev.sha256.aa", sourceType: "maintainer-test" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      id: "ev.sha256.acc7db41",
      payload,
      received: {
        receivedAt: "2026-09-09T10:00:03.117Z",
        submittedBy: "usr_00000000000000000000000001",
        signatureStatus: "none",
        payloadBytes: 812,
        implementationFingerprint: "a3f19c04b7e25d18",
        revokedAt: null,
        revokedReason: null,
      },
      derived: {
        recordExpired: false,
        capabilityStatus: [
          { capabilityId: "tool.calling", expiresAt: "2027-01-01T00:00:00.000Z", expired: false },
          { capabilityId: "streaming.sse", expiresAt: "2026-10-09T00:00:00.000Z", expired: true },
        ],
        staleReason: null,
        supersededBy: null,
        fingerprint: { subject: "a3f19c04b7e25d18", received: "a3f19c04b7e25d18", current: "a3f19c04b7e25d18", match: "match" },
        supportsCurrentVerdict: true,
      },
    }, { status: 201 }));

    const result = await client(fetch).submitCompatibilityEvidence(payload);

    // 201 is Hub taking the record; 200 would mean it already had it.
    expect(result.created).toBe(true);
    // The submission comes back untouched, never merged with Hub's own blocks.
    expect(result.record.payload).toEqual(payload);
    expect(result.record.received).toMatchObject({ signatureStatus: "none", payloadBytes: 812 });
    expect(result.record.received.revokedAt).toBeUndefined();
    expect(result.record.derived.capabilityStatus[1]).toEqual({
      capabilityId: "streaming.sse",
      expiresAt: "2026-10-09T00:00:00.000Z",
      expired: true,
    });
    expect(result.record.derived.staleReason).toBeUndefined();
    expect(result.record.derived.fingerprint?.match).toBe("match");
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://hub.example.test/v1/compatibility/evidence"),
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) }),
    );
  });

  it("reads an already-stored submission as not created", async () => {
    const payload = { id: "ev.sha256.aa" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      id: "ev.sha256.aa", payload, received: {}, derived: {},
    }, { status: 200 }));

    await expect(client(fetch).submitCompatibilityEvidence(payload)).resolves.toMatchObject({ created: false });
  });

  it("carries Hub's own error code through, so a rejection can be reported precisely", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({
      error: { code: "evidence_legacy_id", message: "The id form predates the agreement.", retryable: false, requestId: "req_1" },
    }, { status: 400 }));

    await expect(client(fetch).submitCompatibilityEvidence({ id: "evidence.aa" })).rejects.toMatchObject({
      code: "API_ERROR",
      apiCode: "evidence_legacy_id",
      retryable: false,
    });
  });

  it("refuses to revoke without a reason before touching the network", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(client(fetch).revokeCompatibilityEvidence("ev.sha256.aa", "   ")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("registers a test suite version and reports whether it was new", async () => {
    const suite = {
      suiteId: "apexnova.capability-suite",
      version: "0.2.0",
      majorVersion: 0,
      capabilityDigest: { capabilities: ["tool.calling"] },
      ttlTable: { "tool.calling": 90 },
      environment: "linux-x64 node22",
      registeredAt: "2026-09-09T09:58:11.004Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(suite, { status: 200 }));

    const result = await client(fetch).registerCompatibilityTestSuite({
      suiteId: suite.suiteId,
      version: suite.version,
      capabilityDigest: suite.capabilityDigest,
      ttlTable: suite.ttlTable,
    });

    expect(result).toEqual({ suite, created: false });
  });

  it("rejects an invalid requestId argument", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(client(fetch).usage("")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
