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

  it("rejects an invalid requestId argument", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(client(fetch).usage("")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
