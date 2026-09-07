import type { CredentialBackend } from "./types.js";
import type { CommandRunner } from "./command-runner.js";
import { backendFailure, SERVICE_UNAVAILABLE_HINT } from "./backend-errors.js";
import { CredentialStoreError } from "./errors.js";

export class LinuxSecretServiceBackend implements CredentialBackend {
  readonly #runner: CommandRunner;

  constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    if (Buffer.byteLength(secret, "utf8") > 8_191) {
      throw new CredentialStoreError(
        "INVALID_SECRET",
        "Secret Service credentials cannot exceed 8,191 UTF-8 bytes.",
      );
    }
    try {
      const result = await this.#runner.run({
        executable: "secret-tool",
        args: [
          "store",
          "--label=Apexnova-connect",
          "service",
          service,
          "account",
          account,
        ],
        stdin: secret,
      });
      if (result.exitCode !== 0) throw backendFailure("Secret Service", undefined, result.stderr);
    } catch (cause) {
      if (cause instanceof CredentialStoreError) throw cause;
      throw backendFailure("Secret Service", cause);
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      const result = await this.#runner.run({
        executable: "secret-tool",
        args: ["lookup", "service", service, "account", account],
      });
      // `lookup` uses exit 1 for both "no such item" and a service failure, so
      // the output is what separates an absent credential from an absent keyring.
      if (result.exitCode !== 0 && SERVICE_UNAVAILABLE_HINT.test(result.stderr)) {
        throw backendFailure("Secret Service", undefined, result.stderr);
      }
      if (result.exitCode === 1) return null;
      if (result.exitCode !== 0) throw backendFailure("Secret Service", undefined, result.stderr);
      if (result.stdout.length === 0) return null;
      return result.stdout;
    } catch (cause) {
      if (cause instanceof CredentialStoreError) throw cause;
      throw backendFailure("Secret Service", cause);
    }
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      const result = await this.#runner.run({
        executable: "secret-tool",
        args: ["clear", "service", service, "account", account],
      });
      if (result.exitCode !== 0 && SERVICE_UNAVAILABLE_HINT.test(result.stderr)) {
        throw backendFailure("Secret Service", undefined, result.stderr);
      }
      if (result.exitCode === 1) return;
      if (result.exitCode !== 0) throw backendFailure("Secret Service", undefined, result.stderr);
    } catch (cause) {
      if (cause instanceof CredentialStoreError) throw cause;
      throw backendFailure("Secret Service", cause);
    }
  }
}
