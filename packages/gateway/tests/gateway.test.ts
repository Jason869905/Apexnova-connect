import { afterEach, describe, expect, it, vi } from "vitest";

import { SecretValue } from "@apexnova-connect/credential-store";

import { startGateway, type ForwardedRequest, type RunningGateway } from "../src/index.js";

const running: RunningGateway[] = [];

afterEach(async () => {
  for (const gateway of running.splice(0)) await gateway.close();
});

async function gatewayReturning(
  respond: (request: Request) => Response | Promise<Response>,
  onForwarded?: (request: ForwardedRequest) => void,
) {
  const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    respond(new Request(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init)),
  );
  const gateway = await startGateway({
    upstreamBaseUrl: "https://hub.example.test",
    credential: SecretValue.from("hub-secret"),
    fetch: upstream as unknown as typeof globalThis.fetch,
    ...(onForwarded ? { onForwarded } : {}),
  });
  running.push(gateway);
  return { gateway, upstream };
}

describe("the local gateway", () => {
  it("passes a response back byte for byte, and keeps stream order", async () => {
    const events = [
      "event: start\ndata: {\"a\":1}\n\n",
      "event: delta\ndata: {\"b\":2}\n\n",
      "event: done\ndata: [DONE]\n\n",
    ];
    const { gateway } = await gatewayReturning(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const event of events) controller.enqueue(new TextEncoder().encode(event));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "nova" }),
    });

    // The standard for this slice is that the Agent cannot tell the gateway is
    // there. M3 spent a milestone proving event order and boundaries are what an
    // Agent trips over, so they are what this asserts.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(events.join(""));
  });

  it("hands the Hub credential upstream and never to the caller", async () => {
    let seen: string | null = null;
    const { gateway } = await gatewayReturning((request) => {
      seen = request.headers.get("authorization");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });

    await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
    });

    // The Agent presents a local token; only this process holds the Hub one.
    expect(seen).toBe("Bearer hub-secret");
    expect(gateway.localToken).not.toBe("hub-secret");
  });

  it("refuses a caller that does not hold the local token", async () => {
    const { gateway, upstream } = await gatewayReturning(() => new Response("{}", { status: 200 }));

    const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", body: "{}" });

    // The local token is all that stands between any process on this machine and
    // a live Hub credential, so a missing one must not reach the upstream at all.
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns an upstream error as it was, rather than as its own", async () => {
    const body = JSON.stringify({ error: { code: "rate_limited", message: "slow down" } });
    const { gateway } = await gatewayReturning(() =>
      new Response(body, { status: 429, headers: { "content-type": "application/json", "retry-after": "3" } }),
    );

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toBe(body);
  });

  it("reports an unreachable upstream without retrying it", async () => {
    const attempts = vi.fn(async () => { throw new Error("connect ECONNREFUSED"); });
    const forwarded: ForwardedRequest[] = [];
    const gateway = await startGateway({
      upstreamBaseUrl: "https://hub.example.test",
      credential: SecretValue.from("hub-secret"),
      fetch: attempts as unknown as typeof globalThis.fetch,
      onForwarded: (request) => forwarded.push(request),
    });
    running.push(gateway);

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
    });

    expect(response.status).toBe(502);
    // Not retried, deliberately: a request whose tool calls already had effects
    // must not be replayed on the Agent's behalf. One attempt, one report.
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(forwarded[0]?.failure).toContain("ECONNREFUSED");
  });

  it("names each request by the id the upstream gave it", async () => {
    const forwarded: ForwardedRequest[] = [];
    const { gateway } = await gatewayReturning(
      () => new Response("{}", { status: 200, headers: { "x-apexnova-request-id": "req_abc" } }),
      (request) => forwarded.push(request),
    );

    await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
    });

    // This is the reason to be in the request path at all: attribution stops
    // being a difference between hourly billing buckets and becomes one request,
    // named, that this gateway forwarded.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ method: "POST", path: "/v1/responses", status: 200, requestId: "req_abc" });
  });

  it("listens on loopback and nowhere else", async () => {
    const { gateway } = await gatewayReturning(() => new Response("{}", { status: 200 }));

    expect(gateway.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});
