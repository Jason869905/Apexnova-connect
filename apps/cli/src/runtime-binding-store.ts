import {
  SecretValue,
  type CredentialStore,
} from "@apexnova-connect/credential-store";
import { HubClientError } from "@apexnova-connect/hub-client";

export interface RuntimeCredentialBinding {
  readonly credentialId: string;
  readonly secret: SecretValue;
  readonly expiresAt?: string;
  /**
   * When this credential was issued. Kept so the renewal window can be a
   * fraction of the credential's life rather than a fixed hour: "the last
   * hour" is meaningless for a credential that lives ten minutes, and the
   * lifetime became configurable in ADR 0030. Absent on bindings written
   * before that, which fall back to the fixed hour.
   */
  readonly issuedAt?: string;
  readonly protocol: string;
  /** The default deployment: what the Agent starts on. Always in `deploymentIds`. */
  readonly deploymentId: string;
  /**
   * Every deployment this credential is authorised for, default first.
   *
   * A product that switches models inside its own UI does so without telling
   * Connect, so the credential has to cover the whole set the configuration
   * offers -- a key scoped to the default alone would fail closed on the second
   * model the user picks. Absent on bindings written before the set existed,
   * which cover the single deployment named above.
   */
  readonly deploymentIds?: readonly string[];
  readonly kind?: "user" | "runtime";
  readonly transactionId?: string;
  readonly restoreTarget?: RuntimeCredentialRestoreTarget;
}

export interface RuntimeCredentialRestoreTarget {
  readonly protocol: string;
  readonly deploymentId: string;
  readonly deploymentIds?: readonly string[];
  readonly transactionId?: string;
  readonly restoreTarget?: RuntimeCredentialRestoreTarget;
}

/** The model set a binding covers, for callers that must not care which version wrote it. */
export function bindingDeploymentIds(
  binding: Pick<RuntimeCredentialBinding, "deploymentId" | "deploymentIds">,
): readonly string[] {
  const ids = binding.deploymentIds ?? [];
  return ids.length > 0 ? ids : [binding.deploymentId];
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

interface StoredBindingV5 {
  readonly version: 5;
  readonly credentialId: string;
  readonly secret: string;
  readonly expiresAt?: string;
  readonly issuedAt?: string;
  readonly protocol: string;
  readonly deploymentId: string;
  readonly deploymentIds?: readonly string[];
  readonly kind?: "user" | "runtime";
  readonly transactionId?: string;
  readonly restoreTarget?: RuntimeCredentialRestoreTarget;
}

interface StoredBindingV4 {
  readonly version: 4;
  readonly credentialId: string;
  readonly secret: string;
  readonly expiresAt?: string;
  readonly issuedAt?: string;
  readonly protocol: string;
  readonly deploymentId: string;
  readonly kind?: "user" | "runtime";
  readonly transactionId?: string;
  readonly restoreTarget?: RuntimeCredentialRestoreTarget;
}

interface StoredBindingV3 {
  readonly version: 3;
  readonly credentialId: string;
  readonly secret: string;
  readonly expiresAt?: string;
  readonly protocol: string;
  readonly deploymentId: string;
  readonly kind?: "user" | "runtime";
  readonly transactionId?: string;
  readonly restoreTarget?: RuntimeCredentialRestoreTarget;
}

type StoredBinding = StoredBindingV1 | StoredBindingV2 | StoredBindingV3 | StoredBindingV4 | StoredBindingV5;

/**
 * v0.1 stored the single binding under the hard-coded integration ID
 * `opencode`, which is exactly what this produces for that agent, so existing
 * installs keep their credential across the upgrade without a migration.
 */
function key(agentId: string, profileId: string) {
  return { integrationId: agentId, accountId: profileId, kind: "runtime-credential" } as const;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 65_536 || value.includes("\u0000")) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  }
  return value;
}

/**
 * The stored model set, normalised to default-first and deduplicated.
 *
 * The default has to be inside the set: a binding whose default is not one of
 * the deployments its credential covers would send the Agent's first request to
 * a model the key is refused for, and the store is the last place that can tell.
 */
const MAX_DEPLOYMENTS = 64;

function parseDeploymentIds(value: unknown, defaultDeploymentId: string): readonly string[] {
  if (value === undefined || value === null) return [defaultDeploymentId];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DEPLOYMENTS) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  }
  const ids = value.map((item) => requiredString(item));
  if (!ids.includes(defaultDeploymentId)) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  }
  return [defaultDeploymentId, ...ids.filter((id) => id !== defaultDeploymentId)]
    .filter((id, index, all) => all.indexOf(id) === index);
}

function parseRestoreTarget(value: unknown, depth = 0): RuntimeCredentialRestoreTarget {
  if (depth >= 16 || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential restore chain is invalid.");
  }
  const item = value as Partial<RuntimeCredentialRestoreTarget>;
  const deploymentId = requiredString(item.deploymentId);
  return {
    protocol: requiredString(item.protocol),
    deploymentId,
    ...(item.deploymentIds === undefined
      ? {}
      : { deploymentIds: parseDeploymentIds(item.deploymentIds, deploymentId) }),
    ...(item.transactionId === undefined ? {} : { transactionId: requiredString(item.transactionId) }),
    ...(item.restoreTarget === undefined ? {} : { restoreTarget: parseRestoreTarget(item.restoreTarget, depth + 1) }),
  };
}

function parse(value: unknown): StoredBindingV5 {
  if (typeof value !== "object" || value === null) throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  const item = value as Omit<Partial<StoredBindingV5>, "version"> & { version?: number };
  const optionalExpiry = item.version === 3 || item.version === 4 || item.version === 5;
  if ((item.version !== 1 && item.version !== 2 && item.version !== 3 && item.version !== 4 && item.version !== 5) || (!optionalExpiry && (typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt))))) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  }
  if (optionalExpiry && item.expiresAt !== undefined && (typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt)))) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  }
  if (item.issuedAt !== undefined && (typeof item.issuedAt !== "string" || !Number.isFinite(Date.parse(item.issuedAt)))) {
    throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.");
  }
  const deploymentId = requiredString(item.deploymentId);
  return {
    version: 5,
    credentialId: requiredString(item.credentialId),
    secret: requiredString(item.secret),
    ...(item.expiresAt !== undefined && item.expiresAt !== null ? { expiresAt: requiredString(item.expiresAt) } : {}),
    ...(item.issuedAt !== undefined && item.issuedAt !== null ? { issuedAt: requiredString(item.issuedAt) } : {}),
    protocol: requiredString(item.protocol),
    deploymentId,
    // A binding older than the model set covers exactly the one deployment it
    // names, which is what its credential was issued for.
    deploymentIds: parseDeploymentIds(item.deploymentIds, deploymentId),
    ...(optionalExpiry && item.kind !== undefined ? { kind: item.kind } : { kind: "runtime" as const }),
    ...((item.version ?? 0) >= 2 && item.transactionId !== undefined ? { transactionId: requiredString(item.transactionId) } : {}),
    ...((item.version ?? 0) >= 2 && item.restoreTarget !== undefined ? { restoreTarget: parseRestoreTarget(item.restoreTarget) } : {}),
  };
}

export class RuntimeBindingStore {
  readonly #credentials: CredentialStore;

  constructor(credentials: CredentialStore) {
    this.#credentials = credentials;
  }

  async load(agentId: string, profileId: string): Promise<RuntimeCredentialBinding | null> {
    const stored = await this.#credentials.get(key(agentId, profileId));
    if (stored === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(stored.reveal()); } catch (cause) {
      throw new HubClientError("SESSION_CORRUPT", "Stored runtime credential binding is invalid.", { cause });
    }
    const binding = parse(parsed);
    return {
      credentialId: binding.credentialId,
      secret: SecretValue.from(binding.secret),
      ...(binding.expiresAt ? { expiresAt: binding.expiresAt } : {}),
      ...(binding.issuedAt ? { issuedAt: binding.issuedAt } : {}),
      protocol: binding.protocol,
      deploymentId: binding.deploymentId,
      ...(binding.deploymentIds ? { deploymentIds: binding.deploymentIds } : {}),
      ...(binding.kind ? { kind: binding.kind } : {}),
      ...(binding.transactionId ? { transactionId: binding.transactionId } : {}),
      ...(binding.restoreTarget ? { restoreTarget: binding.restoreTarget } : {}),
    };
  }

  async save(agentId: string, profileId: string, binding: RuntimeCredentialBinding): Promise<void> {
    const stored = parse({
      version: 5,
      credentialId: binding.credentialId,
      secret: binding.secret.reveal(),
      ...(binding.expiresAt ? { expiresAt: binding.expiresAt } : {}),
      ...(binding.issuedAt ? { issuedAt: binding.issuedAt } : {}),
      protocol: binding.protocol,
      deploymentId: binding.deploymentId,
      deploymentIds: bindingDeploymentIds(binding),
      ...(binding.kind ? { kind: binding.kind } : {}),
      ...(binding.transactionId ? { transactionId: binding.transactionId } : {}),
      ...(binding.restoreTarget ? { restoreTarget: binding.restoreTarget } : {}),
    });
    await this.#credentials.set(key(agentId, profileId), SecretValue.from(JSON.stringify(stored)));
  }

  async delete(agentId: string, profileId: string): Promise<void> {
    await this.#credentials.delete(key(agentId, profileId));
  }
}
