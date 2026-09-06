import { SecretValue } from "@apexnova-connect/credential-store";

import { HubClientError } from "./errors.js";
import type {
  DeviceAuthorization,
  AuthorizationServerMetadata,
  DevicePollResult,
  HubTokenSet,
  WaitForDeviceAuthorizationOptions,
} from "./types.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_POLL_INTERVAL_SECONDS = 3_600;

export interface HubOAuthClientOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly scope?: string;
  readonly optionalScopes?: string;
  readonly deviceAuthorizationPath?: string;
  readonly tokenPath?: string;
  readonly revocationPath?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
  readonly allowInsecureLoopback?: boolean;
  readonly apiPrefix?: string;
}

interface OAuthErrorResponse {
  readonly error: string;
}

function requiredString(
  value: unknown,
  field: string,
  maximumLength = 65_536,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\u0000")
  ) {
    throw new HubClientError(
      "INVALID_RESPONSE",
      `Apexnova AI Hub returned an invalid ${field}.`,
    );
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function positiveInteger(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > maximum
  ) {
    throw new HubClientError(
      "INVALID_RESPONSE",
      `Apexnova AI Hub returned an invalid ${field}.`,
    );
  }
  return value as number;
}

function futureIso(now: Date, seconds: number, field: string): string {
  const timestamp = now.getTime() + seconds * 1_000;
  if (!Number.isFinite(timestamp) || timestamp > 8_640_000_000_000_000) {
    throw new HubClientError(
      "INVALID_RESPONSE",
      `Apexnova AI Hub returned an invalid ${field}.`,
    );
  }
  return new Date(timestamp).toISOString();
}

function isInsecureLoopback(url: URL): boolean {
  return url.protocol === "http:" && (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  );
}

function validateSecureUrl(value: string, field: string, allowInsecureLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new HubClientError("INVALID_RESPONSE", `Invalid ${field} URL.`, { cause });
  }
  if ((url.protocol !== "https:" && !(allowInsecureLoopback && isInsecureLoopback(url))) || url.username || url.password) {
    throw new HubClientError("INVALID_RESPONSE", `${field} must use HTTPS.`);
  }
  return url.toString();
}

function endpointPath(value: string, field: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || /[?#]/.test(value)) {
    throw new HubClientError(
      "INVALID_CONFIG",
      `${field} must be an absolute same-origin path without a query or fragment.`,
    );
  }
  return value;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class HubOAuthClient {
  readonly #baseUrl: URL;
  readonly #clientId: string;
  readonly #scope: string | undefined;
  readonly #optionalScopes: string | undefined;
  #effectiveScope: string | undefined;
  readonly #deviceAuthorizationPath: string;
  readonly #tokenPath: string;
  readonly #revocationPath: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #requestTimeoutMs: number;
  readonly #allowInsecureLoopback: boolean;

  async discover(signal?: AbortSignal): Promise<AuthorizationServerMetadata> {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.#requestTimeoutMs)]) : AbortSignal.timeout(this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(new URL("/.well-known/oauth-authorization-server", this.#baseUrl), { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: requestSignal });
    } catch (cause) {
      throw new HubClientError("NETWORK_ERROR", "OAuth authorization server discovery failed.", { cause, retryable: true });
    }
    if (!response.ok) throw new HubClientError("OAUTH_ERROR", "OAuth authorization server discovery failed.");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new HubClientError("INVALID_RESPONSE", "Hub response is too large.");
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch (cause) {
      throw new HubClientError("INVALID_RESPONSE", "OAuth discovery response is invalid.", { cause });
    }
    const secure = (value: unknown, field: string) => validateSecureUrl(requiredString(value, field, 2_048), field, this.#allowInsecureLoopback);
    const issuer = secure(body.issuer, "issuer");
    const tokenEndpoint = secure(body.token_endpoint, "token_endpoint");
    const deviceAuthorizationEndpoint = secure(body.device_authorization_endpoint, "device_authorization_endpoint");
    const revocationEndpoint = secure(body.revocation_endpoint, "revocation_endpoint");
    for (const endpoint of [issuer, tokenEndpoint, deviceAuthorizationEndpoint, revocationEndpoint]) {
      if (new URL(endpoint).origin !== this.#baseUrl.origin) throw new HubClientError("INVALID_RESPONSE", "OAuth discovery endpoints must use the configured Hub origin.");
    }
    if (new URL(tokenEndpoint).pathname !== this.#tokenPath || new URL(deviceAuthorizationEndpoint).pathname !== this.#deviceAuthorizationPath || new URL(revocationEndpoint).pathname !== this.#revocationPath) {
      if (!this.#allowInsecureLoopback) throw new HubClientError("INVALID_RESPONSE", "OAuth discovery endpoints do not match the configured Hub paths.");
    }
    if (!Array.isArray(body.scopes_supported) || !body.scopes_supported.every((item) => typeof item === "string")) throw new HubClientError("INVALID_RESPONSE", "OAuth discovery scopes_supported is invalid.");
    const scopesSupported = body.scopes_supported as string[];
    if (this.#scope && !this.#scope.split(/\s+/).every((scope) => scopesSupported.includes(scope))) throw new HubClientError("INVALID_RESPONSE", "OAuth discovery does not advertise every requested scope.");
    const effectiveScopes = [
      ...(this.#scope ? this.#scope.split(/\s+/) : []),
      ...(this.#optionalScopes ? this.#optionalScopes.split(/\s+/).filter((scope) => scopesSupported.includes(scope)) : []),
    ];
    this.#effectiveScope = effectiveScopes.length > 0 ? effectiveScopes.join(" ") : undefined;
    return { issuer, tokenEndpoint, deviceAuthorizationEndpoint, revocationEndpoint, scopesSupported };
  }

  constructor(options: HubOAuthClientOptions) {
    try {
      this.#baseUrl = new URL(options.baseUrl);
    } catch (cause) {
      throw new HubClientError("INVALID_CONFIG", "Hub baseUrl is invalid.", { cause });
    }
    if (
      (this.#baseUrl.protocol !== "https:" && !(options.allowInsecureLoopback && isInsecureLoopback(this.#baseUrl))) ||
      this.#baseUrl.username !== "" ||
      this.#baseUrl.password !== "" ||
      this.#baseUrl.pathname !== "/" ||
      this.#baseUrl.search !== "" ||
      this.#baseUrl.hash !== ""
    ) {
      throw new HubClientError(
        "INVALID_CONFIG",
        "Hub baseUrl must be an HTTPS origin without credentials, path, query, or fragment.",
      );
    }
    if (
      !options.clientId.trim() ||
      options.clientId.trim() !== options.clientId ||
      options.clientId.length > 256
    ) {
      throw new HubClientError("INVALID_CONFIG", "OAuth clientId is invalid.");
    }
    if (options.scope !== undefined && (!options.scope.trim() || options.scope.length > 2_048)) {
      throw new HubClientError("INVALID_CONFIG", "OAuth scope is invalid.");
    }
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    ) {
      throw new HubClientError("INVALID_CONFIG", "requestTimeoutMs must be positive.");
    }

    this.#clientId = options.clientId;
    this.#scope = options.scope;
    this.#optionalScopes = options.optionalScopes;
    this.#effectiveScope = options.scope;
    const prefix = options.apiPrefix ?? "";
    this.#deviceAuthorizationPath = endpointPath(
      options.deviceAuthorizationPath ?? `${prefix}/oauth/device/code`,
      "deviceAuthorizationPath",
    );
    this.#tokenPath = endpointPath(options.tokenPath ?? `${prefix}/oauth/token`, "tokenPath");
    this.#revocationPath = endpointPath(options.revocationPath ?? `${prefix}/oauth/revoke`, "revocationPath");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  }

  async #postForm(
    path: string,
    values: Readonly<Record<string, string | undefined>>,
    signal?: AbortSignal,
    allowEmptySuccess = false,
  ): Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }> {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined && value !== "") body.set(name, value);
    }
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: body.toString(),
        redirect: "error",
        signal: requestSignal,
      });
    } catch (cause) {
      throw new HubClientError("NETWORK_ERROR", "Apexnova AI Hub request failed.", {
        cause,
      });
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new HubClientError("INVALID_RESPONSE", "Hub response is too large.");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new HubClientError("INVALID_RESPONSE", "Hub response is too large.");
    }
    let parsed: unknown;
    if (allowEmptySuccess && response.ok && bytes.byteLength === 0) {
      return { ok: true, status: response.status, body: null };
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new HubClientError("INVALID_RESPONSE", "Hub response is not valid JSON.", {
        cause,
      });
    }
    return { ok: response.ok, status: response.status, body: parsed };
  }

  #parseTokens(value: unknown, previousRefreshToken?: SecretValue): HubTokenSet {
    if (typeof value !== "object" || value === null) {
      throw new HubClientError("INVALID_RESPONSE", "Hub token response is invalid.");
    }
    const token = value as Record<string, unknown>;
    const accessToken = SecretValue.from(requiredString(token.access_token, "access_token"));
    const refreshTokenValue = optionalString(token.refresh_token, "refresh_token");
    const expiresIn =
      token.expires_in === undefined ? undefined : positiveInteger(token.expires_in, "expires_in");
    const expiresAt =
      expiresIn === undefined
        ? undefined
        : futureIso(this.#now(), expiresIn, "expires_in");
    const result: HubTokenSet = {
      accessToken,
      tokenType: requiredString(token.token_type, "token_type", 64),
      ...(refreshTokenValue === undefined
        ? previousRefreshToken === undefined
          ? {}
          : { refreshToken: previousRefreshToken }
        : { refreshToken: SecretValue.from(refreshTokenValue) }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(token.scope === undefined ? {} : { scope: requiredString(token.scope, "scope", 2_048) }),
      ...(token.account_id === undefined
        ? {}
        : { accountId: requiredString(token.account_id, "account_id", 256) }),
    };
    return result;
  }

  async startDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization> {
    const response = await this.#postForm(
      this.#deviceAuthorizationPath,
      { client_id: this.#clientId, scope: this.#effectiveScope },
      signal,
    );
    if (!response.ok || typeof response.body !== "object" || response.body === null) {
      throw new HubClientError("OAUTH_ERROR", "Device authorization could not start.");
    }
    const body = response.body as Record<string, unknown>;
    const expiresIn = positiveInteger(body.expires_in, "expires_in");
    const intervalSeconds =
      body.interval === undefined
        ? 5
        : positiveInteger(body.interval, "interval", MAX_POLL_INTERVAL_SECONDS);
    const verificationUri = validateSecureUrl(
      requiredString(body.verification_uri, "verification_uri", 2_048),
      "verification_uri",
      this.#allowInsecureLoopback,
    );
    const complete = optionalString(
      body.verification_uri_complete,
      "verification_uri_complete",
    );
    return {
      deviceCode: SecretValue.from(requiredString(body.device_code, "device_code")),
      userCode: requiredString(body.user_code, "user_code", 256),
      verificationUri,
      ...(complete === undefined
        ? {}
        : { verificationUriComplete: validateSecureUrl(complete, "verification_uri_complete", this.#allowInsecureLoopback) }),
      expiresAt: futureIso(this.#now(), expiresIn, "expires_in"),
      intervalSeconds,
    };
  }

  async pollDeviceAuthorization(
    authorization: DeviceAuthorization,
    intervalSeconds = authorization.intervalSeconds,
    signal?: AbortSignal,
  ): Promise<DevicePollResult> {
    if (
      !Number.isSafeInteger(intervalSeconds) ||
      intervalSeconds <= 0 ||
      intervalSeconds > MAX_POLL_INTERVAL_SECONDS
    ) {
      throw new HubClientError("INVALID_CONFIG", "Polling interval must be positive.");
    }
    const response = await this.#postForm(
      this.#tokenPath,
      {
        grant_type: DEVICE_GRANT,
        device_code: authorization.deviceCode.reveal(),
        client_id: this.#clientId,
      },
      signal,
    );
    if (response.ok) {
      return { status: "authorized", tokens: this.#parseTokens(response.body) };
    }
    const oauthError =
      typeof response.body === "object" && response.body !== null
        ? (response.body as Partial<OAuthErrorResponse>).error
        : undefined;
    if (oauthError === "authorization_pending") {
      return { status: "pending", intervalSeconds };
    }
    if (oauthError === "slow_down") {
      return { status: "pending", intervalSeconds: intervalSeconds + 5 };
    }
    if (oauthError === "access_denied") {
      throw new HubClientError("ACCESS_DENIED", "Device authorization was denied.", {
        oauthError,
      });
    }
    if (oauthError === "expired_token") {
      throw new HubClientError(
        "DEVICE_CODE_EXPIRED",
        "The device authorization code expired.",
        { oauthError },
      );
    }
    throw new HubClientError("OAUTH_ERROR", "The OAuth token request failed.", {
      ...(typeof oauthError === "string" ? { oauthError } : {}),
    });
  }

  async waitForDeviceAuthorization(
    authorization: DeviceAuthorization,
    options: WaitForDeviceAuthorizationOptions = {},
  ): Promise<HubTokenSet> {
    const sleep = options.sleep ?? defaultSleep;
    let intervalSeconds = authorization.intervalSeconds;
    let attempt = 0;
    while (this.#now().getTime() < new Date(authorization.expiresAt).getTime()) {
      await sleep(intervalSeconds * 1_000, options.signal);
      if (this.#now().getTime() >= new Date(authorization.expiresAt).getTime()) {
        break;
      }
      attempt += 1;
      options.onPoll?.(attempt);
      try {
        const result = await this.pollDeviceAuthorization(
          authorization,
          intervalSeconds,
          options.signal,
        );
        if (result.status === "authorized") return result.tokens;
        intervalSeconds = result.intervalSeconds;
      } catch (error) {
        if (error instanceof HubClientError && error.code === "NETWORK_ERROR") {
          intervalSeconds = Math.min(intervalSeconds * 2, 60);
          continue;
        }
        throw error;
      }
    }
    throw new HubClientError(
      "DEVICE_CODE_EXPIRED",
      "The device authorization code expired.",
    );
  }

  async refresh(refreshToken: SecretValue, signal?: AbortSignal): Promise<HubTokenSet> {
    const response = await this.#postForm(
      this.#tokenPath,
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken.reveal(),
        client_id: this.#clientId,
      },
      signal,
    );
    if (!response.ok) {
      const oauthError =
        typeof response.body === "object" && response.body !== null
          ? (response.body as Partial<OAuthErrorResponse>).error
          : undefined;
      throw new HubClientError("OAUTH_ERROR", "Refresh token request failed.", {
        ...(typeof oauthError === "string" ? { oauthError } : {}),
      });
    }
    return this.#parseTokens(response.body, refreshToken);
  }

  async revoke(token: SecretValue, signal?: AbortSignal): Promise<void> {
    const response = await this.#postForm(
      this.#revocationPath,
      { token: token.reveal(), client_id: this.#clientId },
      signal,
      true,
    );
    if (!response.ok) {
      throw new HubClientError("OAUTH_ERROR", "Token revocation failed.");
    }
  }
}
