import { describe, expect, it } from "vitest";

import {
  MemoryCredentialBackend,
  SecretValue,
  SystemCredentialStore,
} from "@apexnova-connect/credential-store";

import {
  HubOAuthClient,
  HubSessionService,
  HubSessionStore,
  type HubTokenSet,
} from "../src/index.js";

const now = new Date("2026-09-03T00:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

function queuedFetch(
  responses: readonly Response[],
): { readonly fetch: typeof globalThis.fetch; readonly calls: RequestInit[] } {
  const queue = [...responses];
  const calls: RequestInit[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls.push(init ?? {});
    const response = queue.shift();
    if (!response) throw new Error("Unexpected fetch call.");
    return response;
  };
  return { fetch, calls };
}

function oauth(fetch: typeof globalThis.fetch): HubOAuthClient {
  return new HubOAuthClient({
    baseUrl: "https://hub.example.test",
    clientId: "apexnova-connect-public-client",
    scope: "models.read models.invoke offline_access",
    fetch,
    now: () => now,
  });
}

function credentials() {
  const credentials = new SystemCredentialStore(new MemoryCredentialBackend());
  return {
    credentials,
    sessions: new HubSessionStore(credentials),
  };
}

describe("HubOAuthClient", () => {
  it("starts a standards-based device authorization without exposing device_code", async () => {
    const transport = queuedFetch([
      jsonResponse({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://hub.example.test/activate",
        verification_uri_complete:
          "https://hub.example.test/activate?user_code=ABCD-EFGH",
        expires_in: 600,
      }),
    ]);

    const authorization = await oauth(transport.fetch).startDeviceAuthorization();

    expect(authorization.deviceCode.toString()).toBe("[REDACTED]");
    expect(authorization.deviceCode.reveal()).toBe("private-device-code");
    expect(authorization.intervalSeconds).toBe(5);
    expect(authorization.expiresAt).toBe("2026-09-03T00:10:00.000Z");
    expect(transport.calls[0]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(transport.calls[0]?.body).toBe(
      "client_id=apexnova-connect-public-client&scope=models.read+models.invoke+offline_access",
    );
  });

  it("honors pending and slow_down polling intervals before returning tokens", async () => {
    const transport = queuedFetch([
      jsonResponse({ error: "authorization_pending" }, 400),
      jsonResponse({ error: "slow_down" }, 400),
      jsonResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        account_id: "account-1",
      }),
    ]);
    const client = oauth(transport.fetch);
    const sleeps: number[] = [];
    const authorization = {
      deviceCode: SecretValue.from("device-code"),
      userCode: "ABCD-EFGH",
      verificationUri: "https://hub.example.test/activate",
      expiresAt: "2026-09-03T00:10:00.000Z",
      intervalSeconds: 5,
    } as const;

    const tokens = await client.waitForDeviceAuthorization(authorization, {
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    expect(sleeps).toEqual([5_000, 5_000, 10_000]);
    expect(tokens.accessToken.reveal()).toBe("access-token");
    expect(tokens.refreshToken?.reveal()).toBe("refresh-token");
    expect(tokens.expiresAt).toBe("2026-09-03T01:00:00.000Z");
    expect(tokens.accountId).toBe("account-1");
  });

  it("doubles the interval after a network failure", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("network unavailable");
      return jsonResponse({
        access_token: "access-token",
        token_type: "Bearer",
      });
    };
    const sleeps: number[] = [];

    await oauth(fetch).waitForDeviceAuthorization(
      {
        deviceCode: SecretValue.from("device-code"),
        userCode: "ABCD-EFGH",
        verificationUri: "https://hub.example.test/activate",
        expiresAt: "2026-09-03T00:10:00.000Z",
        intervalSeconds: 5,
      },
      {
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    );

    expect(sleeps).toEqual([5_000, 10_000]);
  });

  it("stops polling when authorization is denied", async () => {
    const transport = queuedFetch([jsonResponse({ error: "access_denied" }, 400)]);

    await expect(
      oauth(transport.fetch).pollDeviceAuthorization({
        deviceCode: SecretValue.from("device-code"),
        userCode: "ABCD-EFGH",
        verificationUri: "https://hub.example.test/activate",
        expiresAt: "2026-09-03T00:10:00.000Z",
        intervalSeconds: 5,
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("rejects insecure base URLs and cross-origin endpoint forms", () => {
    expect(
      () =>
        new HubOAuthClient({
          baseUrl: "http://hub.example.test",
          clientId: "client",
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(
      () =>
        new HubOAuthClient({
          baseUrl: "https://hub.example.test",
          clientId: "client",
          tokenPath: "//attacker.example/token",
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it("rejects a polling interval that could overflow runtime timers", async () => {
    const transport = queuedFetch([
      jsonResponse({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://hub.example.test/activate",
        expires_in: 600,
        interval: 3_601,
      }),
    ]);

    await expect(
      oauth(transport.fetch).startDeviceAuthorization(),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("limits response bodies by UTF-8 byte size", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ padding: "界".repeat(50_000) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(oauth(fetch).startDeviceAuthorization()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});

describe("HubSessionStore", () => {
  it("persists an OAuth session as one credential and restores redacted values", async () => {
    const { sessions } = credentials();
    const tokens: HubTokenSet = {
      accessToken: SecretValue.from("access"),
      refreshToken: SecretValue.from("refresh"),
      tokenType: "Bearer",
      expiresAt: "2026-09-03T01:00:00.000Z",
      accountId: "account-1",
    };

    await sessions.save("default", tokens);
    const loaded = await sessions.load("default");

    expect(loaded?.accessToken.reveal()).toBe("access");
    expect(loaded?.refreshToken?.reveal()).toBe("refresh");
    expect(JSON.stringify(loaded)).not.toContain(':"access"');
    expect(JSON.stringify(loaded)).not.toContain(':"refresh"');
    await sessions.delete("default");
    expect(await sessions.load("default")).toBeNull();
  });

  it("rejects a corrupt keychain session", async () => {
    const { credentials: credentialStore, sessions } = credentials();
    await credentialStore.set(
      {
        integrationId: "apexnova-ai-hub",
        accountId: "default",
        kind: "oauth-session",
      },
      SecretValue.from("not-json"),
    );

    await expect(sessions.load("default")).rejects.toMatchObject({
      code: "SESSION_CORRUPT",
    });
  });
});

describe("HubSessionService", () => {
  it("only gives UI the user-facing verification data and then saves the session", async () => {
    const transport = queuedFetch([
      jsonResponse({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://hub.example.test/activate",
        expires_in: 600,
        interval: 1,
      }),
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
      }),
    ]);
    const { sessions } = credentials();
    const service = new HubSessionService(oauth(transport.fetch), sessions, {
      now: () => now,
    });
    let prompt: unknown;

    await service.login("default", {
      onVerificationRequired(value) {
        prompt = value;
      },
      sleep: async () => undefined,
    });

    expect(prompt).toEqual({
      userCode: "ABCD-EFGH",
      verificationUri: "https://hub.example.test/activate",
      expiresAt: "2026-09-03T00:10:00.000Z",
    });
    expect(JSON.stringify(prompt)).not.toContain("private-device-code");
    expect((await sessions.load("default"))?.accessToken.reveal()).toBe("access");
  });

  it("coalesces concurrent refreshes and preserves an unrotated refresh token", async () => {
    let refreshCalls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      refreshCalls += 1;
      await Promise.resolve();
      return jsonResponse({
        access_token: "new-access",
        token_type: "Bearer",
        expires_in: 3600,
      });
    };
    const { sessions } = credentials();
    await sessions.save("default", {
      accessToken: SecretValue.from("expired-access"),
      refreshToken: SecretValue.from("original-refresh"),
      tokenType: "Bearer",
      expiresAt: "2026-09-02T23:59:00.000Z",
      accountId: "account-1",
    });
    const service = new HubSessionService(oauth(fetch), sessions, {
      now: () => now,
    });

    const [left, right] = await Promise.all([
      service.accessToken("default"),
      service.accessToken("default"),
    ]);

    expect(left.reveal()).toBe("new-access");
    expect(right.reveal()).toBe("new-access");
    expect(refreshCalls).toBe(1);
    const stored = await sessions.load("default");
    expect(stored?.refreshToken?.reveal()).toBe("original-refresh");
    expect(stored?.accountId).toBe("account-1");
  });

  it("requires an existing refresh token", async () => {
    const { sessions } = credentials();
    await sessions.save("default", {
      accessToken: SecretValue.from("access"),
      tokenType: "Bearer",
      expiresAt: "2026-09-02T23:59:00.000Z",
    });
    const transport = queuedFetch([]);
    const service = new HubSessionService(oauth(transport.fetch), sessions, {
      now: () => now,
    });

    await expect(service.refresh("default")).rejects.toMatchObject({
      code: "REFRESH_TOKEN_MISSING",
    });
  });
});
