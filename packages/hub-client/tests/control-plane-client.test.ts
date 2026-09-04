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
});
