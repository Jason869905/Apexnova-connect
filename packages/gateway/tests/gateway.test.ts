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

  it("gives up on an upstream that never sends headers, once", async () => {
    const attempts = vi.fn(async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by the caller")));
      }),
    );
    const forwarded: ForwardedRequest[] = [];
    const gateway = await startGateway({
      upstreamBaseUrl: "https://hub.example.test",
      credential: SecretValue.from("hub-secret"),
      fetch: attempts as unknown as typeof globalThis.fetch,
      headerTimeoutMs: 50,
      onForwarded: (request) => forwarded.push(request),
    });
    running.push(gateway);

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
    });

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "upstream_timeout", retryable: false } });
    // One attempt: a request that may already have had effects is not replayed
    // just because the answer was slow.
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(forwarded[0]?.failure).toContain("no response headers");
  });

  it("does not bound a stream that has already started", async () => {
    const { gateway } = await gatewayReturning(() =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("event: start\n\n"));
            // Longer than the header timeout below: a model that takes its time
            // is working, not failing, and cutting it off would truncate a real
            // answer.
            await new Promise((resolve) => setTimeout(resolve, 120));
            controller.enqueue(new TextEncoder().encode("event: done\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
    });

    expect(await response.text()).toBe("event: start\n\nevent: done\n\n");
  });

  it("truncates rather than completing a stream that failed halfway", async () => {
    const forwarded: ForwardedRequest[] = [];
    const { gateway } = await gatewayReturning(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: start\ndata: {\"a\":1}\n\n"));
              controller.error(new Error("upstream stream collapsed"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      (request) => forwarded.push(request),
    );

    // Headers are already out by then, so there is no status left to tell the
    // truth with. Ending cleanly would hand the Agent a stream that looks
    // finished; M3 spent a milestone on exactly that failure.
    await expect(
      fetch(`${gateway.url}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${gateway.localToken}` },
        body: "{}",
      }).then((response) => response.text()),
    ).rejects.toBeDefined();
    expect(forwarded[0]?.failure).toContain("collapsed");
  });

  it("survives a caller that walks away mid-stream", async () => {
    const { gateway } = await gatewayReturning(() =>
      new Response(
        new ReadableStream({
          async start(controller) {
            for (let index = 0; index < 200; index += 1) {
              controller.enqueue(new TextEncoder().encode(`event: delta-${index}\n\n`));
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const abort = new AbortController();
    const pending = fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
      signal: abort.signal,
    });
    const response = await pending;
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();

    // The gateway holds a live Hub credential; a client hanging up must not take
    // it down. A second request still works.
    const second = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
    });
    expect(second.status).toBe(200);
    await second.body?.cancel();
  });

  it("keeps concurrent requests apart, and finishes them out of order", async () => {
    const forwarded: ForwardedRequest[] = [];
    const { gateway } = await gatewayReturning(
      async (request) => {
        const marker = new URL(request.url).pathname.split("/").pop()!;
        // Later requests answer first, so the responses are deliberately out of
        // request order: crossing two of them would pass a test where the
        // upstream replied in the order it was asked.
        await new Promise((resolve) => setTimeout(resolve, (8 - Number(marker)) * 12));
        return new Response(`answer-${marker}`, {
          status: 200,
          headers: { "x-apexnova-request-id": `req_${marker}` },
        });
      },
      (request) => forwarded.push(request),
    );

    const markers = [1, 2, 3, 4, 5, 6, 7, 8];
    const startedAt = Date.now();
    const answers = await Promise.all(
      markers.map(async (marker) => {
        const response = await fetch(`${gateway.url}/v1/responses/${marker}`, {
          method: "POST",
          headers: { authorization: `Bearer ${gateway.localToken}` },
          body: JSON.stringify({ marker }),
        });
        return `${marker}:${await response.text()}`;
      }),
    );

    // Each caller gets its own answer. A gateway that shared state between
    // in-flight requests would hand someone else's model output to an Agent,
    // which is the worst failure available to a component in the request path.
    expect(answers).toEqual(markers.map((marker) => `${marker}:answer-${marker}`));
    // Without this the test would pass on a gateway that served them one after
    // another: separate answers prove nothing about overlap. The upstream delays
    // add up to 336ms, so finishing well inside that means they were in flight
    // together.
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(forwarded).toHaveLength(markers.length);
    expect(new Set(forwarded.map((request) => request.requestId))).toEqual(
      new Set(markers.map((marker) => `req_${marker}`)),
    );
  });

  it("shuts down while requests are still in flight", async () => {
    const { gateway } = await gatewayReturning(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              for (;;) {
                controller.enqueue(new TextEncoder().encode("event: delta\n\n"));
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
    });
    await response.body!.getReader().read();

    // A stream that never ends must not keep the launcher alive after the Agent
    // is gone -- that is the hang that made `close()` wait on keep-alive
    // connections in the first place. Closing returns rather than waiting for a
    // client that will never be done.
    await expect(
      Promise.race([
        gateway.close(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("close did not return")), 2_000)),
      ]),
    ).resolves.toBeUndefined();
    running.splice(running.indexOf(gateway), 1);
  });

  it("listens on loopback and nowhere else", async () => {
    const { gateway } = await gatewayReturning(() => new Response("{}", { status: 200 }));

    expect(gateway.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});

describe("the credential the gateway holds", () => {
  it("picks up a replacement between requests, and names which one paid", async () => {
    // ADR 0019 recorded the credential as fixed for the life of a run, which
    // made a session that outlives it fail. The provider is read per request so
    // the replacement can arrive mid-run; this proves the read is live rather
    // than a value captured at start.
    const sent: string[] = [];
    const forwarded: ForwardedRequest[] = [];
    let inForce = { secret: SecretValue.from("hub-secret-first"), credentialId: "rtc_1" };
    const upstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200, headers: { "x-apexnova-request-id": `req_${sent.length}` } });
    });
    const gateway = await startGateway({
      upstreamBaseUrl: "https://hub.example.test",
      credential: () => inForce,
      fetch: upstream as unknown as typeof globalThis.fetch,
      onForwarded: (request) => forwarded.push(request),
    });
    running.push(gateway);

    const call = () =>
      fetch(`${gateway.url}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${gateway.localToken}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "nova" }),
      });

    await call();
    inForce = { secret: SecretValue.from("hub-secret-second"), credentialId: "rtc_2" };
    await call();

    expect(sent).toEqual(["Bearer hub-secret-first", "Bearer hub-secret-second"]);
    // Per request, not once per run: the audit has to be able to say which
    // credential carried which requests, and a single figure for the run would
    // file the first one under a key that never paid for it.
    expect(forwarded.map((request) => request.credentialId)).toEqual(["rtc_1", "rtc_2"]);
  });

  it("waits for a credential that is still being fetched rather than sending without one", async () => {
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let entered: (() => void) | undefined;
    // Waited on before the assertion below, so it tests the gateway holding the
    // request back rather than the request not having arrived yet.
    const asking = new Promise<void>((resolve) => { entered = resolve; });
    const upstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(new Headers(init?.headers).get("authorization") ?? "", { status: 200 }),
    );
    const gateway = await startGateway({
      upstreamBaseUrl: "https://hub.example.test",
      credential: async () => {
        entered?.();
        await ready;
        return { secret: SecretValue.from("renewed-secret"), credentialId: "rtc_2" };
      },
      fetch: upstream as unknown as typeof globalThis.fetch,
    });
    running.push(gateway);

    const response = fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
    });
    await asking;
    // Nothing may go upstream while the renewal is in flight. Forwarding with
    // the old credential here would be the quiet kind of wrong: it would work
    // right up until the moment it stopped.
    expect(upstream).not.toHaveBeenCalled();
    release?.();

    expect(await (await response).text()).toBe("Bearer renewed-secret");
  });

  it("says no credential was available rather than forwarding one it knows is wrong", async () => {
    const forwarded: ForwardedRequest[] = [];
    const upstream = vi.fn(async () => new Response("{}", { status: 200 }));
    const gateway = await startGateway({
      upstreamBaseUrl: "https://hub.example.test",
      credential: () => { throw new Error("Hub refused to issue a credential"); },
      fetch: upstream as unknown as typeof globalThis.fetch,
      onForwarded: (request) => forwarded.push(request),
    });
    running.push(gateway);

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.localToken}` },
      body: "{}",
    });

    expect(response.status).toBe(502);
    const body = await response.json() as { error: { code: string; message: string; retryable: boolean } };
    expect(body.error.code).toBe("credential_unavailable");
    expect(body.error.message).toContain("Hub refused");
    expect(body.error.retryable).toBe(false);
    // Nothing reached Hub, so nothing was billed and no tool call ran. The
    // record has to say that, not report whatever an upstream made of a
    // credential we never sent.
    expect(upstream).not.toHaveBeenCalled();
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.failure).toContain("Hub refused");
  });
});
