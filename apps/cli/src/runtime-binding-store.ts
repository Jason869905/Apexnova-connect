import {
  SecretValue,
  type CredentialStore,
} from "@apexnova-connect/credential-store";
import { HubClientError } from "@apexnova-connect/hub-client";

export interface RuntimeCredentialBinding {
  readonly credentialId: string;
  readonly secret: SecretValue;
  readonly expiresAt: string;
  readonly protocol: string;
  readonly deploymentId: string;
  readonly transactionId?: string;
  readonly restoreTarget?: RuntimeCredentialRestoreTarget;
}

export interface RuntimeCredentialRestoreTarget {
  readonly protocol: string;
  readonly deploymentId: string;
  readonly transactionId?: string;
  readonly restoreTarget?: RuntimeCredentialRestoreTarget;
}

interface StoredBindingV1 {
  readonly version: 1;
  readonly credentialId: string;
  readonly secret: string;
  readonly expiresAt: string;
  readonly protocol: string;
  readonly deploymentId: string;
}

interface StoredBindingV2 {
  readonly version: 2;
  readonly credentialId: string;
  readonly secret: string;
  readonly expiresAt: string;
  readonly protocol: string;
  readonly deploymentId: string;
  readonly transactionId?: string;
  readonly restoreTarget?: RuntimeCredentialRestoreTarget;
}

type StoredBinding = StoredBindingV1 | StoredBindingV2;

function key(profileId: string) {
  return { integrationId: "opencode", accountId: profileId, kind: "runtime-credential" } as const;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 65_536 || value.includes("\u0000")) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  }
  return value;
}

function parseRestoreTarget(value: unknown, depth = 0): RuntimeCredentialRestoreTarget {
  if (depth >= 16 || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential restore chain is invalid.");
  }
  const item = value as Partial<RuntimeCredentialRestoreTarget>;
  return {
    protocol: requiredString(item.protocol),
    deploymentId: requiredString(item.deploymentId),
    ...(item.transactionId === undefined ? {} : { transactionId: requiredString(item.transactionId) }),
    ...(item.restoreTarget === undefined ? {} : { restoreTarget: parseRestoreTarget(item.restoreTarget, depth + 1) }),
  };
}

function parse(value: unknown): StoredBindingV2 {
  if (typeof value !== "object" || value === null) throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  const item = value as Partial<StoredBinding>;
  if ((item.version !== 1 && item.version !== 2) || typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt))) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  }
  return {
    version: 2,
    credentialId: requiredString(item.credentialId),
    secret: requiredString(item.secret),
    expiresAt: item.expiresAt,
    protocol: requiredString(item.protocol),
    deploymentId: requiredString(item.deploymentId),
    ...(item.version === 2 && item.transactionId !== undefined ? { transactionId: requiredString(item.transactionId) } : {}),
    ...(item.version === 2 && item.restoreTarget !== undefined ? { restoreTarget: parseRestoreTarget(item.restoreTarget) } : {}),
  };
}

export class RuntimeBindingStore {
  readonly #credentials: CredentialStore;

  constructor(credentials: CredentialStore) {
    this.#credentials = credentials;
  }

  async load(profileId: string): Promise<RuntimeCredentialBinding | null> {
    const stored = await this.#credentials.get(key(profileId));
    if (stored === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(stored.reveal()); } catch (cause) {
      throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.", { cause });
    }
    const binding = parse(parsed);
    return {
      credentialId: binding.credentialId,
      secret: SecretValue.from(binding.secret),
      expiresAt: binding.expiresAt,
      protocol: binding.protocol,
      deploymentId: binding.deploymentId,
      ...(binding.transactionId ? { transactionId: binding.transactionId } : {}),
      ...(binding.restoreTarget ? { restoreTarget: binding.restoreTarget } : {}),
    };
  }

  async save(profileId: string, binding: RuntimeCredentialBinding): Promise<void> {
    const stored = parse({
      version: 2,
      credentialId: binding.credentialId,
      secret: binding.secret.reveal(),
      expiresAt: binding.expiresAt,
      protocol: binding.protocol,
      deploymentId: binding.deploymentId,
      ...(binding.transactionId ? { transactionId: binding.transactionId } : {}),
      ...(binding.restoreTarget ? { restoreTarget: binding.restoreTarget } : {}),
    });
    await this.#credentials.set(key(profileId), SecretValue.from(JSON.stringify(stored)));
  }

  async delete(profileId: string): Promise<void> {
    await this.#credentials.delete(key(profileId));
  }
}
