import { CommandRunnerError } from "./command-runner.js";
import { CredentialStoreError } from "./errors.js";

export function backendFailure(
  backendName: string,
  cause?: unknown,
): CredentialStoreError {
  if (cause instanceof CommandRunnerError && cause.kind === "not-found") {
    return new CredentialStoreError(
      "BACKEND_UNAVAILABLE",
      `${backendName} is not installed or is unavailable.`,
      { cause },
    );
  }
  return new CredentialStoreError(
    "OPERATION_FAILED",
    `${backendName} could not complete the credential operation.`,
    cause === undefined ? undefined : { cause },
  );
}
