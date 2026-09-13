import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, posix, win32 } from "node:path";

import { CredentialStoreError } from "./errors.js";
import type { CredentialBackend } from "./types.js";

/**
 * A credential file, for sessions with no OS credential service.
 *
 * This is the honest version of the thing the OS backends exist to avoid. There
 * is no OS secret to derive a key from on a headless box, so anything this file
 * did with the bytes would be obfuscation wearing a cryptography costume: the
 * key would have to sit next to the ciphertext. It therefore stores the secrets
 * as they are and protects them the only way it actually can -- a 0700
 * directory and a 0600 file owned by the user -- and says so everywhere it is
 * reported.
 *
 * That is why nothing selects this backend on its own. `createDefaultCredentialStore`
 * reaches it only when the caller asks for it by name, which keeps the rule the
 * OS backends were written under intact: a missing keyring is an error, never a
 * silent downgrade. A user who chooses this has chosen it.
 */

/** Matches the OS backends: one blob per (service, account) pair. */
interface CredentialFile {
  readonly version: 1;
  readonly entries: Record<string, Record<string, string>>;
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

export interface FileCredentialBackendOptions {
  /** Skips the POSIX permission checks, which say nothing on Windows. */
  readonly platform?: NodeJS.Platform;
}

export function defaultCredentialFilePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory?: string,
): string {
  // The path flavour follows the `platform` argument rather than the host, so
  // asking what Linux would use returns a Linux path even when the question is
  // asked from Windows. On a matching host the two are the same function.
  const path = platform === "win32" ? win32 : posix;
  const home = homeDirectory ?? environment.USERPROFILE ?? environment.HOME ?? process.cwd();
  if (platform === "win32") {
    return path.resolve(
      environment.APPDATA ?? path.join(home, "AppData", "Roaming"),
      "Apexnova",
      "connect",
      "credentials.json",
    );
  }
  // Deliberately not next to config.json: that file is the one users paste into
  // issues and screenshots when something is misconfigured.
  return path.resolve(
    environment.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
    "apexnova-connect",
    "credentials.json",
  );
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class FileCredentialBackend implements CredentialBackend {
  readonly #path: string;
  readonly #platform: NodeJS.Platform;
  /**
   * Serializes this process against itself. The lock file below handles other
   * processes; two `await`ed writes inside one CLI run would otherwise both
   * read, both edit their own copy, and the second would drop the first.
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string, options: FileCredentialBackendOptions = {}) {
    this.#path = path;
    this.#platform = options.platform ?? process.platform;
  }

  get path(): string {
    return this.#path;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    await this.#mutate((file) => {
      const entries = { ...file.entries, [service]: { ...file.entries[service], [account]: secret } };
      return { version: 1, entries };
    });
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.#serialize(() => this.#read().entries[service]?.[account] ?? null);
  }

  async delete(service: string, account: string): Promise<void> {
    await this.#mutate((file) => {
      const existing = file.entries[service];
      if (existing === undefined || !(account in existing)) return file;
      const { [account]: _removed, ...rest } = existing;
      const entries = { ...file.entries };
      if (Object.keys(rest).length === 0) delete entries[service];
      else entries[service] = rest;
      return { version: 1, entries };
    });
  }

  #serialize<T>(work: () => T): Promise<T> {
    const result = this.#queue.then(work, work);
    // The queue swallows the outcome so one failed operation does not reject
    // every later one; callers still see their own result through `result`.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #mutate(change: (file: CredentialFile) => CredentialFile): Promise<void> {
    return this.#serialize(() => {
      const release = this.#lock();
      try {
        const next = change(this.#read());
        this.#write(next);
      } finally {
        release();
      }
    });
  }

  #read(): CredentialFile {
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (cause) {
      if (isMissing(cause)) return { version: 1, entries: {} };
      throw new CredentialStoreError(
        "BACKEND_UNAVAILABLE",
        `The credential file could not be read: ${this.#path}.`,
        { cause },
      );
    }
    this.#assertPrivate();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      // Never rewritten from scratch on a parse failure. A file that is not
      // JSON is a file whose contents nobody here understands, and overwriting
      // it would destroy whatever session the user still has.
      throw new CredentialStoreError(
        "OPERATION_FAILED",
        `The credential file is not valid JSON: ${this.#path}. Move it aside and run \`apexnova login\` again.`,
        { cause },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CredentialStoreError(
        "OPERATION_FAILED",
        `The credential file does not hold a credential object: ${this.#path}.`,
      );
    }
    const entriesValue = (parsed as { entries?: unknown }).entries;
    if (typeof entriesValue !== "object" || entriesValue === null || Array.isArray(entriesValue)) {
      return { version: 1, entries: {} };
    }
    const entries: Record<string, Record<string, string>> = {};
    for (const [service, accounts] of Object.entries(entriesValue)) {
      if (typeof accounts !== "object" || accounts === null || Array.isArray(accounts)) continue;
      const kept: Record<string, string> = {};
      for (const [account, secret] of Object.entries(accounts)) {
        if (typeof secret === "string") kept[account] = secret;
      }
      entries[service] = kept;
    }
    return { version: 1, entries };
  }

  /**
   * Refuses a file other users can read, rather than repairing it.
   *
   * `chmod` here would hide the event that matters: if the mode is 0644 the
   * secret has already been readable by every account on the machine, and the
   * fix is to rotate it, not to narrow the file and carry on.
   */
  #assertPrivate(): void {
    if (this.#platform === "win32") return;
    let mode: number;
    try {
      mode = statSync(this.#path).mode;
    } catch (cause) {
      if (isMissing(cause)) return;
      throw new CredentialStoreError(
        "BACKEND_UNAVAILABLE",
        `The credential file could not be inspected: ${this.#path}.`,
        { cause },
      );
    }
    const shared = mode & 0o077;
    if (shared === 0) return;
    throw new CredentialStoreError(
      "BACKEND_UNAVAILABLE",
      `${this.#path} is readable by other users (mode ${(mode & 0o777).toString(8)}). Its secrets have to be treated as exposed: revoke them, then \`chmod 600\` the file and sign in again.`,
    );
  }

  #write(file: CredentialFile): void {
    const directory = dirname(this.#path);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (cause) {
      throw new CredentialStoreError(
        "BACKEND_UNAVAILABLE",
        `The credential directory could not be created: ${directory}.`,
        { cause },
      );
    }
    // Written beside the target and renamed, so a crash mid-write leaves the
    // previous file intact rather than a truncated one. `mode` on the temporary
    // file is what the final file inherits through the rename, which is the
    // only ordering where the secret is never on disk world-readable.
    const temporary = `${this.#path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.#path);
    } catch (cause) {
      try {
        unlinkSync(temporary);
      } catch {
        // The write failed; a leftover temporary file is not worth a second error.
      }
      throw new CredentialStoreError(
        "BACKEND_UNAVAILABLE",
        `The credential file could not be written: ${this.#path}.`,
        { cause },
      );
    }
  }

  /**
   * A lock file against other `apexnova` processes, because a credential
   * renewal in one terminal and a `login` in another are a read-modify-write
   * pair on one file. Stale locks expire: the holder can be killed, and a lock
   * nobody will ever release is worse than a rare lost update.
   */
  #lock(): () => void {
    const lockPath = `${this.#path}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        closeSync(openSync(lockPath, "wx", 0o600));
        return () => {
          try {
            unlinkSync(lockPath);
          } catch {
            // Already gone: a stale-lock breaker removed it. The write is done.
          }
        };
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code !== "EEXIST") {
          throw new CredentialStoreError(
            "BACKEND_UNAVAILABLE",
            `The credential lock could not be taken: ${lockPath}.`,
            { cause },
          );
        }
        let age = 0;
        try {
          age = Date.now() - statSync(lockPath).mtimeMs;
        } catch {
          continue;
        }
        if (age > LOCK_STALE_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Someone else broke it first; the next attempt takes it.
          }
          continue;
        }
        if (Date.now() > deadline) {
          throw new CredentialStoreError(
            "BACKEND_UNAVAILABLE",
            `Another apexnova process is holding the credential file lock (${lockPath}). Wait for it to finish, or remove the lock file if no other process is running.`,
          );
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
      }
    }
  }
}
