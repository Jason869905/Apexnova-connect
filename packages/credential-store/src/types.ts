import { CredentialStoreError } from "./errors.js";

export interface CredentialKey {
  readonly integrationId: string;
  readonly accountId: string;
  readonly kind: string;
}

export interface CredentialStore {
  set(key: CredentialKey, secret: SecretValue): Promise<void>;
  get(key: CredentialKey): Promise<SecretValue | null>;
  delete(key: CredentialKey): Promise<void>;
}

export interface CredentialBackend {
  set(service: string, account: string, secret: string): Promise<void>;
  get(service: string, account: string): Promise<string | null>;
  delete(service: string, account: string): Promise<void>;
}

export class SecretValue {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static from(value: string): SecretValue {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 65_536 ||
      value.includes("\u0000")
    ) {
      throw new CredentialStoreError(
        "INVALID_SECRET",
        "A credential secret must contain 1 to 65,536 characters and no null bytes.",
      );
    }
    return new SecretValue(value);
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}

function validateKeyPart(name: string, value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CredentialStoreError(
      "INVALID_KEY",
      `${name} must contain 1 to 256 non-control characters without surrounding whitespace.`,
    );
  }
}

function encodeKeyPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function credentialAccountName(key: CredentialKey): string {
  validateKeyPart("integrationId", key.integrationId);
  validateKeyPart("accountId", key.accountId);
  validateKeyPart("kind", key.kind);
  return [
    "v1",
    encodeKeyPart(key.integrationId),
    encodeKeyPart(key.accountId),
    encodeKeyPart(key.kind),
  ].join("/");
}
