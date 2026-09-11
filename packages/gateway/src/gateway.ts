import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";

import type { SecretValue } from "@apexnova-connect/credential-store";

/** What one forwarded request turned out to be, for the audit to record exactly. */
export interface ForwardedRequest {
  readonly method: string;
  readonly path: string;
  /** Hub's own request id, when it sent one. The whole reason to sit in the path. */
  readonly requestId?: string;
  readonly status: number;
  readonly startedAt: string;
  readonly durationMs: number;
  /** Set when the upstream call could not be made at all. */
  readonly failure?: string;
}

export interface GatewayOptions {
  /** Where Hub lives. Only the origin is used; the Agent's path is preserved. */
  readonly upstreamBaseUrl: string;
  /** The Hub credential. It stays in this process and never reaches the Agent. */
  readonly credential: SecretValue;
  readonly onForwarded?: (request: ForwardedRequest) => void;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  /** Loopback only. A gateway holding a Hub credential does not listen outward. */
  readonly host?: "127.0.0.1" | "::1";
  readonly port?: number;
}

/**
 * Headers that belong to one hop and must not be forwarded. Everything else
 * passes through: the gateway's correctness standard is that the Agent cannot
 * tell it is there, and a header quietly dropped is a difference.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const LOCAL_TOKEN_HEADER = "authorization";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RunningGateway {
  readonly url: string;
  /** The token the Agent presents. Not the Hub credential, and not interchangeable with it. */
  readonly localToken: string;
  close(): Promise<void>;
}

/**
 * A faithful pass-through to Hub.
 *
 * The point of sitting in the request path is not to change anything -- it is to
 * see each request. Before this, a launch could only be attributed by a difference on an
 * hourly billing bucket, which another machine on the same account could
 * pollute. Here every request carries its own `requestId`.
 *
 * So the gateway rewrites nothing: the body is streamed through untouched, the
 * response is streamed back untouched, event order and boundaries are whatever
 * the upstream sent, and an error comes back as the status and body Hub
 * produced. It does not retry -- a failure is reported as a failure, because
 * replaying a request whose tool calls already had effects is the one thing M5
 * must not do.
 */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const upstream = new URL(options.upstreamBaseUrl);
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const localToken = randomBytes(32).toString("base64url");

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "gateway_failure", message: "The local gateway could not complete the request." } }));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = now();
    const presented = request.headers[LOCAL_TOKEN_HEADER];
    const offered = typeof presented === "string" ? presented.replace(/^Bearer\s+/i, "") : "";
    if (!safeEqual(offered, localToken)) {
      // The local token is the only thing standing between any process on this
      // machine and a live Hub credential.
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unauthorized", message: "The local gateway token is missing or wrong." } }));
      return;
    }

    const target = new URL(request.url ?? "/", upstream);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("authorization", `Bearer ${options.credential.reveal()}`);

    const method = request.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";

    let upstreamResponse: Response;
    try {
      upstreamResponse = await doFetch(target, {
        method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
        redirect: "error",
      } as RequestInit);
    } catch (cause) {
      const failure = cause instanceof Error ? cause.message : "the upstream call failed";
      options.onForwarded?.({
        method,
        path: target.pathname,
        status: 502,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        failure,
      });
      // No retry, by decision: a request whose tool calls already ran must not
      // be replayed on the Agent's behalf.
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "upstream_unreachable", message: failure, retryable: false } }));
      return;
    }

    const outbound: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name.toLowerCase())) outbound[name] = value;
    });
    response.writeHead(upstreamResponse.status, outbound);

    if (upstreamResponse.body) {
      // Streamed through rather than buffered: the suite proved event order and
      // boundaries are what an Agent trips over, and buffering would change both.
      const reader = upstreamResponse.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!response.write(Buffer.from(chunk.value))) await once(response, "drain");
      }
    }
    response.end();

    options.onForwarded?.({
      method,
      path: target.pathname,
      ...(upstreamResponse.headers.get("x-apexnova-request-id")
        ? { requestId: upstreamResponse.headers.get("x-apexnova-request-id")! }
        : {}),
      status: upstreamResponse.status,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: now() - startedAt,
    });
  }

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The gateway did not bind a TCP port.");
  }

  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${address.port}`,
    localToken,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
