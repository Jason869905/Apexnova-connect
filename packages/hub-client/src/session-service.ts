import type { SecretValue } from "@apexnova-connect/credential-store";

import { HubClientError } from "./errors.js";
import type { HubOAuthClient } from "./oauth-client.js";
import type { HubSessionStore } from "./session-store.js";
import type { HubTokenSet, LoginOptions } from "./types.js";

export class HubSessionService {
  readonly #oauth: HubOAuthClient;
  readonly #sessions: HubSessionStore;
  readonly #now: () => Date;
  readonly #refreshes = new Map<string, Promise<HubTokenSet>>();

  constructor(
    oauth: HubOAuthClient,
    sessions: HubSessionStore,
    options: { readonly now?: () => Date } = {},
  ) {
    this.#oauth = oauth;
    this.#sessions = sessions;
    this.#now = options.now ?? (() => new Date());
  }

  async login(profileId: string, options: LoginOptions): Promise<HubTokenSet> {
    const authorization = await this.#oauth.startDeviceAuthorization(options.signal);
    await options.onVerificationRequired({
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      ...(authorization.verificationUriComplete === undefined
        ? {}
        : { verificationUriComplete: authorization.verificationUriComplete }),
      expiresAt: authorization.expiresAt,
    });
    const tokens = await this.#oauth.waitForDeviceAuthorization(authorization, options);
    await this.#sessions.save(profileId, tokens);
    return tokens;
  }

  async refresh(profileId: string, signal?: AbortSignal): Promise<HubTokenSet> {
    const current = this.#refreshes.get(profileId);
    if (current) return current;
    const refresh = this.#refreshOnce(profileId, signal).finally(() => {
      this.#refreshes.delete(profileId);
    });
    this.#refreshes.set(profileId, refresh);
    return refresh;
  }

  async #refreshOnce(profileId: string, signal?: AbortSignal): Promise<HubTokenSet> {
    const session = await this.#sessions.load(profileId);
    if (session === null) {
      throw new HubClientError("SESSION_NOT_FOUND", "Hub session was not found.");
    }
    if (session.refreshToken === undefined) {
      throw new HubClientError(
        "REFRESH_TOKEN_MISSING",
        "Hub session does not contain a refresh token.",
      );
    }
    const refreshed = await this.#oauth.refresh(session.refreshToken, signal);
    const merged: HubTokenSet = {
      ...refreshed,
      ...(refreshed.accountId === undefined && session.accountId !== undefined
        ? { accountId: session.accountId }
        : {}),
    };
    await this.#sessions.save(profileId, merged);
    return merged;
  }

  async accessToken(
    profileId: string,
    options: { readonly minimumValiditySeconds?: number; readonly signal?: AbortSignal } = {},
  ): Promise<SecretValue> {
    const session = await this.#sessions.load(profileId);
    if (session === null) {
      throw new HubClientError("SESSION_NOT_FOUND", "Hub session was not found.");
    }
    const minimumValiditySeconds = options.minimumValiditySeconds ?? 60;
    if (!Number.isFinite(minimumValiditySeconds) || minimumValiditySeconds < 0) {
      throw new HubClientError(
        "INVALID_CONFIG",
        "minimumValiditySeconds cannot be negative.",
      );
    }
    if (
      session.expiresAt !== undefined &&
      Date.parse(session.expiresAt) <=
        this.#now().getTime() + minimumValiditySeconds * 1_000
    ) {
      return (await this.refresh(profileId, options.signal)).accessToken;
    }
    return session.accessToken;
  }

  async logout(profileId: string): Promise<void> {
    await this.#sessions.delete(profileId);
  }
}
