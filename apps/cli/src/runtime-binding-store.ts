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
}

interface StoredBinding {
  readonly version: 1;
  readonly credentialId: string;
  readonly secret: string;
  readonly expiresAt: string;
  readonly protocol: string;
  readonly deploymentId: string;
}

function key(profileId: string) {
  return { integrationId: "opencode", accountId: profileId, kind: "runtime-credential" } as const;
}

function parse(value: unknown): StoredBinding {
  if (typeof value !== "object" || value === null) throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  const item = value as Partial<StoredBinding>;
  if (item.version !== 1 || typeof item.credentialId !== "string" || !item.credentialId || typeof item.secret !== "string" || !item.secret || typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt)) || typeof item.protocol !== "string" || !item.protocol || typeof item.deploymentId !== "string" || !item.deploymentId) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  }
  return item as StoredBinding;
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
    return { credentialId: binding.credentialId, secret: SecretValue.from(binding.secret), expiresAt: binding.expiresAt, protocol: binding.protocol, deploymentId: binding.deploymentId };
  }

  async save(profileId: string, binding: RuntimeCredentialBinding): Promise<void> {
    const stored: StoredBinding = { version: 1, credentialId: binding.credentialId, secret: binding.secret.reveal(), expiresAt: binding.expiresAt, protocol: binding.protocol, deploymentId: binding.deploymentId };
    parse(stored);
    await this.#credentials.set(key(profileId), SecretValue.from(JSON.stringify(stored)));
  }

  async delete(profileId: string): Promise<void> {
    await this.#credentials.delete(key(profileId));
  }
}
