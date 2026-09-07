import { CommandRunnerError } from "./command-runner.js";
import { CredentialStoreError } from "./errors.js";

/**
 * Signatures of a credential helper that ran but found nothing to talk to. A
 * headless Linux or WSL session has `secret-tool` installed and no keyring
 * daemon behind D-Bus, and the helper reports that by exiting non-zero after
 * its own timeout rather than by failing to start.
 */
export const SERVICE_UNAVAILABLE_HINT = /org\.freedesktop\.secrets|StartServiceByName|autolaunch d-bus|was not provided by any \.service files/i;

export function backendFailure(
  backendName: string,
  cause?: unknown,
  helperOutput?: string,
): CredentialStoreError {
  // Classified on the helper's output, which is never repeated in the message:
  // it can name paths and services the user did not ask us to print.
  if (helperOutput !== undefined && SERVICE_UNAVAILABLE_HINT.test(helperOutput)) {
    return new CredentialStoreError(
      "BACKEND_UNAVAILABLE",
      `${backendName} is not running; no credential service answered.`,
      cause === undefined ? undefined : { cause },
    );
  }
  if (cause instanceof CommandRunnerError && cause.kind === "not-found") {
    return new CredentialStoreError(
      "BACKEND_UNAVAILABLE",
      `${backendName} is not installed or is unavailable.`,
      { cause },
    );
  }
  // A helper that hangs means nothing is answering behind it -- a headless
  // Linux session with no keyring daemon, say. That is the backend being
  // unavailable, not an operation that failed for an unknown reason.
  if (cause instanceof CommandRunnerError && cause.kind === "timeout") {
    return new CredentialStoreError(
      "BACKEND_UNAVAILABLE",
      `${backendName} did not respond; no credential service appears to be running.`,
      { cause },
    );
  }
  return new CredentialStoreError(
    "OPERATION_FAILED",
    `${backendName} could not complete the credential operation.`,
    cause === undefined ? undefined : { cause },
  );
}
