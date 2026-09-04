import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { SecretValue } from "../../packages/credential-store/dist/index.js";
import { HubControlPlaneClient } from "../../packages/hub-client/dist/index.js";
import { describe, expect, it } from "vitest";

const hubRepository = process.env.APEXNOVA_AI_HUB_REPO;
const contract = hubRepository ? describe : describe.skip;

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(hubRepository!, "openapi", "fixtures", `${name}.json`), "utf8"));
}

function client(responses: Readonly<Record<string, unknown>>) {
  return new HubControlPlaneClient({
    baseUrl: "https://hub.example.test",
    accessToken: async () => SecretValue.from("contract-access-token"),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      const body = responses[key];
      if (body === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: key, retryable: false } }), { status: 404 });
      return new Response(JSON.stringify(body), { status: key.startsWith("POST ") ? 201 : 200, headers: { "content-type": "application/json", "x-apexnova-request-id": "req_contract" } });
    },
  });
}

contract("Apexnova AI Hub H1 cross-repository contract", () => {
  it("parses the Hub-owned account, balance and catalog fixtures", async () => {
    const api = client({
      "GET /v1/me": await fixture("me"),
      "GET /v1/billing/balance": await fixture("billing-balance"),
      "GET /v1/catalog/snapshot": await fixture("catalog-snapshot"),
    });

    const [me, balance, catalog] = await Promise.all([api.me(), api.balance(), api.catalog()]);
    expect(me.userId).toMatch(/^usr_/);
    expect(balance.currency).toBe("USD");
    expect(catalog.providers[0]?.id).toBe("provider.apexnova-ai-hub");
    expect(catalog.deployments[0]?.inferenceAlias).toBeTruthy();
  });

  it("keeps the Hub-owned one-time runtime secret inside SecretValue", async () => {
    const api = client({ "POST /v1/runtime-credentials": await fixture("runtime-credential-created") });
    const created = await api.createRuntimeCredential({ name: "OpenCode contract test", protocols: ["openai-responses"], publicDeploymentIds: ["deployment.test"] });
    expect(created.credentialId).toMatch(/^rtc_/);
    expect(created.secret.toJSON()).toBe("[REDACTED]");
    expect(JSON.stringify(created)).not.toContain("anrt_");
  });

  it("contains every Connect H1 path in the Hub-owned OpenAPI document", async () => {
    const specification = JSON.parse(await readFile(join(hubRepository!, "openapi", "apexnova-hub-v1.json"), "utf8")) as { openapi?: string; paths?: Record<string, unknown> };
    expect(specification.openapi).toMatch(/^3\.1/);
    for (const path of ["/.well-known/oauth-authorization-server", "/oauth/device/code", "/oauth/token", "/oauth/revoke", "/v1/me", "/v1/catalog/snapshot", "/v1/billing/balance", "/v1/runtime-credentials", "/v1/runtime-credentials/{credentialId}"]) {
      expect(specification.paths).toHaveProperty(path);
    }
  });
});
