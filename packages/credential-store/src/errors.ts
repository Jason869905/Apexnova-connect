export type CredentialStoreErrorCode =
  | "INVALID_KEY"
  | "INVALID_SECRET"
  | "BACKEND_UNAVAILABLE"
  | "UNSUPPORTED_PLATFORM"
  | "OPERATION_FAILED";

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;

  constructor(
    code: CredentialStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}
