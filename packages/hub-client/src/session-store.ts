import {
  SecretValue,
  type CredentialKey,
  type CredentialStore,
} from "@apexnova-connect/credential-store";

import { HubClientError } from "./errors.js";
import type { HubTokenSet } from "./types.js";

interface StoredSession {
  readonly version: 1;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresAt?: string;
  readonly scope?: string;
  readonly accountId?: string;
}

export interface HubSessionStoreOptions {
  readonly integrationId?: string;
}

function validateProfileId(profileId: string): void {
  if (!profileId.trim() || profileId.length > 256 || profileId.trim() !== profileId) {
    throw new HubClientError("INVALID_CONFIG", "Session profileId is invalid.");
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Partial<StoredSession>;
  return (
    session.version === 1 &&
    typeof session.accessToken === "string" &&
    session.accessToken.length > 0 &&
    (session.refreshToken === undefined ||
      (typeof session.refreshToken === "string" && session.refreshToken.length > 0)) &&
    typeof session.tokenType === "string" &&
    session.tokenType.length > 0 &&
    (session.expiresAt === undefined ||
      (typeof session.expiresAt === "string" && Number.isFinite(Date.parse(session.expiresAt)))) &&
    (session.scope === undefined || typeof session.scope === "string") &&
    (session.accountId === undefined || typeof session.accountId === "string")
  );
}

export class HubSessionStore {
  readonly #credentials: CredentialStore;
  readonly #integrationId: string;

  constructor(credentials: CredentialStore, options: HubSessionStoreOptions = {}) {
    this.#credentials = credentials;
    this.#integrationId = options.integrationId ?? "apexnova-ai-hub";
  }

  #key(profileId: string): CredentialKey {
    validateProfileId(profileId);
    return {
      integrationId: this.#integrationId,
      accountId: profileId,
      kind: "oauth-session",
    };
  }

  async save(profileId: string, tokens: HubTokenSet): Promise<void> {
    if (
      !(tokens.accessToken instanceof SecretValue) ||
      (tokens.refreshToken !== undefined &&
        !(tokens.refreshToken instanceof SecretValue))
    ) {
      throw new HubClientError(
        "INVALID_CONFIG",
        "Hub sessions require SecretValue token fields.",
      );
    }
    const session: StoredSession = {
      version: 1,
      accessToken: tokens.accessToken.reveal(),
      ...(tokens.refreshToken === undefined
        ? {}
        : { refreshToken: tokens.refreshToken.reveal() }),
      tokenType: tokens.tokenType,
      ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
      ...(tokens.accountId === undefined ? {} : { accountId: tokens.accountId }),
    };
    if (!isStoredSession(session)) {
      throw new HubClientError("INVALID_CONFIG", "Hub session metadata is invalid.");
    }
    await this.#credentials.set(
      this.#key(profileId),
      SecretValue.from(JSON.stringify(session)),
    );
  }

  async load(profileId: string): Promise<HubTokenSet | null> {
    const value = await this.#credentials.get(this.#key(profileId));
    if (value === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.reveal());
    } catch (cause) {
      throw new HubClientError("SESSION_CORRUPT", "Stored Hub session is invalid.", {
        cause,
      });
    }
    if (!isStoredSession(parsed)) {
      throw new HubClientError("SESSION_CORRUPT", "Stored Hub session is invalid.");
    }
    return {
      accessToken: SecretValue.from(parsed.accessToken),
      ...(parsed.refreshToken === undefined
        ? {}
        : { refreshToken: SecretValue.from(parsed.refreshToken) }),
      tokenType: parsed.tokenType,
      ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
      ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
      ...(parsed.accountId === undefined ? {} : { accountId: parsed.accountId }),
    };
  }

  async delete(profileId: string): Promise<void> {
    await this.#credentials.delete(this.#key(profileId));
  }
}
