import { CredentialStoreError } from "./errors.js";
import {
  credentialAccountName,
  SecretValue,
  type CredentialBackend,
  type CredentialKey,
  type CredentialStore,
} from "./types.js";

const DEFAULT_SERVICE = "io.apexnova.connect";

function validateServiceName(serviceName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(serviceName)) {
    throw new CredentialStoreError(
      "INVALID_KEY",
      "Credential service name must contain 3 to 128 letters, numbers, dots, underscores, or hyphens.",
    );
  }
}

export class SystemCredentialStore implements CredentialStore {
  readonly #backend: CredentialBackend;
  readonly #serviceName: string;

  constructor(
    backend: CredentialBackend,
    options: { readonly serviceName?: string } = {},
  ) {
    this.#backend = backend;
    this.#serviceName = options.serviceName ?? DEFAULT_SERVICE;
    validateServiceName(this.#serviceName);
  }

  async set(key: CredentialKey, secret: SecretValue): Promise<void> {
    if (!(secret instanceof SecretValue)) {
      throw new CredentialStoreError(
        "INVALID_SECRET",
        "Credentials must be wrapped with SecretValue.from().",
      );
    }
    await this.#backend.set(
      this.#serviceName,
      credentialAccountName(key),
      secret.reveal(),
    );
  }

  async get(key: CredentialKey): Promise<SecretValue | null> {
    const value = await this.#backend.get(
      this.#serviceName,
      credentialAccountName(key),
    );
    return value === null ? null : SecretValue.from(value);
  }

  async delete(key: CredentialKey): Promise<void> {
    await this.#backend.delete(this.#serviceName, credentialAccountName(key));
  }
}
