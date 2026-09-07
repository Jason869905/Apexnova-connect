import { SecretValue } from "@apexnova-connect/credential-store";
import { describe, expect, it, vi } from "vitest";

import { verifyHubInference } from "../src/index.js";

const headers = {
  "content-type": "application/json",
  "x-apexnova-request-id": "req_123",
  "x-apexnova-provider-id": "provider.apexnova-ai-hub",
  "x-apexnova-requested-model": "nova",
  "x-apexnova-resolved-model": "nova",
  "x-apexnova-deployment-id": "deployment.nova",
};

describe("verifyHubInference", () => {
  it("verifies an OpenAI Responses request and public routing headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "resp_123",
      object: "response",
      output: [],
    }), { status: 200, headers }));

    const result = await verifyHubInference({
      endpoint: "https://api.example.test/v1/responses",
      protocol: "openai-responses",
      model: "nova",
      deploymentId: "deployment.nova",
      runtimeCredential: SecretValue.from("runtime-secret"),
      fetch,
    });

    expect(result).toEqual({
      status: 200,
      protocol: "openai-responses",
      requestId: "req_123",
      providerId: "provider.apexnova-ai-hub",
      requestedModel: "nova",
      resolvedModel: "nova",
      deploymentId: "deployment.nova",
    });
    const request = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "nova",
      input: "Reply with exactly OK.",
      max_output_tokens: 8,
      stream: false,
      store: false,
    });
    expect(JSON.stringify(result)).not.toContain("runtime-secret");
  });

  it("verifies an Anthropic Messages request with its version header", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    }), { status: 200, headers }));

    const result = await verifyHubInference({
      endpoint: "https://api.example.test/anthropic/v1/messages",
      protocol: "anthropic-messages",
      model: "nova",
      deploymentId: "deployment.nova",
      runtimeCredential: SecretValue.from("runtime-secret"),
      fetch,
    });

    expect(result.protocol).toBe("anthropic-messages");
    const request = fetch.mock.calls[0]?.[1];
    expect((request?.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "nova",
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      stream: false,
    });
    expect(JSON.stringify(result)).not.toContain("runtime-secret");
  });

  it("rejects an Anthropic endpoint that is not the messages path", async () => {
    await expect(
      verifyHubInference({
        endpoint: "https://api.example.test/v1/responses",
        protocol: "anthropic-messages",
        model: "nova",
        deploymentId: "deployment.nova",
        runtimeCredential: SecretValue.from("runtime-secret"),
        fetch: vi.fn<typeof globalThis.fetch>(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("supports Chat Completions and explicit .localhost aliasing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "chatcmpl_123",
      choices: [],
    }), { status: 200, headers }));

    await verifyHubInference({
      endpoint: "http://api.localhost:18080/v1/chat/completions",
      protocol: "openai-chat",
      model: "nova",
      deploymentId: "deployment.nova",
      runtimeCredential: SecretValue.from("runtime-secret"),
      allowInsecureLoopback: true,
      loopbackHostAlias: "localhost",
      fetch,
    });

    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL("http://localhost:18080/v1/chat/completions"));
  });

  it("rejects missing public deployment evidence", async () => {
    const missing = { ...headers };
    delete (missing as Partial<typeof headers>)["x-apexnova-deployment-id"];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "resp_123", output: [] }), { status: 200, headers: missing }));

    await expect(verifyHubInference({
      endpoint: "https://api.example.test/v1/responses",
      protocol: "openai-responses",
      model: "nova",
      deploymentId: "deployment.nova",
      runtimeCredential: SecretValue.from("runtime-secret"),
      fetch,
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("maps billing failures without retaining the runtime secret", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "insufficient_balance", message: "Balance required.", details: { internal: "secret" } },
    }), { status: 402, headers: { "x-apexnova-request-id": "req_402" } }));

    const error = await verifyHubInference({
      endpoint: "https://api.example.test/v1/responses",
      protocol: "openai-responses",
      model: "nova",
      deploymentId: "deployment.nova",
      runtimeCredential: SecretValue.from("runtime-secret"),
      fetch,
    }).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: "BILLING_BLOCKED", requestId: "req_402" });
    expect(JSON.stringify(error)).not.toContain("runtime-secret");
    expect(JSON.stringify(error)).not.toContain("internal");
  });
});
