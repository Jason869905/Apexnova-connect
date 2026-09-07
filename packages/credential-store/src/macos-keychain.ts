import type { CredentialBackend } from "./types.js";
import type { CommandRunner } from "./command-runner.js";
import { backendFailure } from "./backend-errors.js";
import { CredentialStoreError } from "./errors.js";

/** `security` reports "item not found" with this exit code. */
const NOT_FOUND_EXIT_CODE = 44;

/**
 * `security add-generic-password` only accepts the password as an argument, so
 * writing it that way would put the secret into the process list. Interactive
 * mode reads the same command from stdin instead, which keeps it out of argv.
 */
function quoteForInteractiveMode(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * macOS Keychain backend built on the `security` command line tool.
 *
 * Every call shells out rather than binding the Security framework, so the
 * package stays dependency-free and testable through {@link CommandRunner}.
 */
export class MacOsKeychainBackend implements CredentialBackend {
  readonly #runner: CommandRunner;

  constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    if (secret.includes("\n") || secret.includes("\r")) {
      throw new CredentialStoreError(
        "INVALID_SECRET",
        "Keychain credentials cannot contain line breaks.",
      );
    }
    const command = [
      "add-generic-password",
      "-a",
      quoteForInteractiveMode(account),
      "-s",
      quoteForInteractiveMode(service),
      "-D",
      quoteForInteractiveMode("Apexnova-connect"),
      // Replace an existing item rather than failing with a duplicate.
      "-U",
      "-w",
      quoteForInteractiveMode(secret),
    ].join(" ");

    try {
      const result = await this.#runner.run({
        executable: "security",
        args: ["-i"],
        stdin: `${command}\n`,
      });
      // Interactive mode keeps going after a failed command, so its exit code
      // alone does not prove the item was written.
      if (result.exitCode !== 0 || result.stderr.trim().length > 0) {
        throw backendFailure("macOS Keychain");
      }
    } catch (cause) {
      if (cause instanceof CredentialStoreError) throw cause;
      throw backendFailure("macOS Keychain", cause);
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      const result = await this.#runner.run({
        executable: "security",
        args: ["find-generic-password", "-a", account, "-s", service, "-w"],
      });
      if (result.exitCode === NOT_FOUND_EXIT_CODE) return null;
      if (result.exitCode !== 0) throw backendFailure("macOS Keychain");
      // `-w` prints the password followed by a newline.
      const secret = result.stdout.replace(/\r?\n$/, "");
      return secret.length === 0 ? null : secret;
    } catch (cause) {
      if (cause instanceof CredentialStoreError) throw cause;
      throw backendFailure("macOS Keychain", cause);
    }
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      const result = await this.#runner.run({
        executable: "security",
        args: ["delete-generic-password", "-a", account, "-s", service],
      });
      if (result.exitCode === NOT_FOUND_EXIT_CODE) return;
      if (result.exitCode !== 0) throw backendFailure("macOS Keychain");
    } catch (cause) {
      if (cause instanceof CredentialStoreError) throw cause;
      throw backendFailure("macOS Keychain", cause);
    }
  }
}
