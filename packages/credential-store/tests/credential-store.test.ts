import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CommandRunnerError,
  CredentialStoreError,
  FileCredentialBackend,
  LinuxSecretServiceBackend,
  MacOsKeychainBackend,
  MemoryCredentialBackend,
  SecretValue,
  SystemCredentialStore,
  WindowsCredentialManagerBackend,
  createDefaultCredentialStore,
  credentialAccountName,
  resolveCredentialBackendSelection,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  type CredentialKey,
} from "../src/index.js";

const key: CredentialKey = {
  integrationId: "opencode",
  accountId: "user@example.com",
  kind: "refresh-token",
};

class FakeCommandRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  readonly #handler: (request: CommandRequest) => CommandResult | Promise<CommandResult>;

  constructor(
    handler: (request: CommandRequest) => CommandResult | Promise<CommandResult>,
  ) {
    this.#handler = handler;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    return this.#handler(request);
  }
}

describe("credential primitives", () => {
  it("redacts secrets during implicit conversion and JSON serialization", () => {
    const secret = SecretValue.from("top-secret-token");

    expect(String(secret)).toBe("[REDACTED]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(secret.reveal()).toBe("top-secret-token");
  });

  it("creates a stable, collision-resistant account name", () => {
    expect(credentialAccountName(key)).toBe(
      "v1/b3BlbmNvZGU/dXNlckBleGFtcGxlLmNvbQ/cmVmcmVzaC10b2tlbg",
    );
    expect(
      credentialAccountName({ ...key, integrationId: "open/code" }),
    ).not.toBe(credentialAccountName({ ...key, integrationId: "open", accountId: "code" }));
  });

  it("rejects malformed keys and secrets", () => {
    expect(() => SecretValue.from("")).toThrowError(
      expect.objectContaining({ code: "INVALID_SECRET" }),
    );
    expect(() => credentialAccountName({ ...key, accountId: " user " })).toThrowError(
      expect.objectContaining({ code: "INVALID_KEY" }),
    );
  });
});

describe("SystemCredentialStore", () => {
  it("stores, reads, replaces, and deletes through its backend", async () => {
    const store = new SystemCredentialStore(new MemoryCredentialBackend());

    expect(await store.get(key)).toBeNull();
    await store.set(key, SecretValue.from("first"));
    expect((await store.get(key))?.reveal()).toBe("first");
    await store.set(key, SecretValue.from("second"));
    expect((await store.get(key))?.reveal()).toBe("second");
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  it("requires an explicit SecretValue wrapper", async () => {
    const store = new SystemCredentialStore(new MemoryCredentialBackend());

    await expect(
      store.set(key, "plaintext" as unknown as SecretValue),
    ).rejects.toMatchObject({ code: "INVALID_SECRET" });
  });
});

describe("system backends", () => {
  it("passes Windows secrets through stdin and never through process arguments", async () => {
    const rawSecret = "windows-secret-value";
    const runner = new FakeCommandRunner((request) => {
      const input = JSON.parse(request.stdin ?? "{}") as {
        operation: string;
      };
      if (input.operation === "get") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "found",
            secret: Buffer.from(rawSecret, "utf8").toString("base64"),
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: '{"status":"ok"}', stderr: "" };
    });
    const store = new SystemCredentialStore(
      new WindowsCredentialManagerBackend(runner),
    );

    await store.set(key, SecretValue.from(rawSecret));
    expect((await store.get(key))?.reveal()).toBe(rawSecret);
    await store.delete(key);

    expect(runner.requests).toHaveLength(3);
    expect(runner.requests[0]?.executable).toBe("powershell.exe");
    expect(runner.requests[0]?.stdin).toContain(rawSecret);
    expect(runner.requests.flatMap((request) => request.args)).not.toContain(rawSecret);
  });

  it("reports a Linux session with no keyring daemon as unavailable, not as a failed operation", async () => {
    // What secret-tool actually prints on a headless or WSL session: it runs,
    // waits for D-Bus, then exits non-zero.
    const runner = new FakeCommandRunner(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "secret-tool: Error calling StartServiceByName for org.freedesktop.secrets: Timeout was reached\n",
    }));
    const store = new SystemCredentialStore(new LinuxSecretServiceBackend(runner));

    await expect(store.set(key, SecretValue.from("value"))).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    });
    // `lookup` exits 1 for a missing item too, so the service failure must not
    // be mistaken for "no credential stored".
    await expect(store.get(key)).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    await expect(store.delete(key)).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  });

  it("still reports a genuinely absent Linux credential as null", async () => {
    const runner = new FakeCommandRunner(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    const store = new SystemCredentialStore(new LinuxSecretServiceBackend(runner));

    expect(await store.get(key)).toBeNull();
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it("treats a hung credential helper as an unavailable backend", async () => {
    const runner = new FakeCommandRunner(() => {
      throw new CommandRunnerError("timeout", "Credential helper timed out.");
    });
    const store = new SystemCredentialStore(new LinuxSecretServiceBackend(runner));

    await expect(store.set(key, SecretValue.from("value"))).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    });
  });

  it("passes macOS secrets through stdin and never through process arguments", async () => {
    const rawSecret = 'macos-"secret"\\value';
    const stored = new Map<string, string>();
    const runner = new FakeCommandRunner((request) => {
      if (request.args[0] === "-i") {
        // Interactive mode: the whole command, secret included, arrives on stdin.
        stored.set("item", rawSecret);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (request.args[0] === "find-generic-password") {
        const value = stored.get("item");
        return value === undefined
          ? { exitCode: 44, stdout: "", stderr: "The specified item could not be found" }
          : { exitCode: 0, stdout: `${value}\n`, stderr: "" };
      }
      stored.delete("item");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = new SystemCredentialStore(new MacOsKeychainBackend(runner));

    await store.set(key, SecretValue.from(rawSecret));
    expect((await store.get(key))?.reveal()).toBe(rawSecret);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();

    expect(runner.requests[0]?.executable).toBe("security");
    expect(runner.requests[0]?.args).toEqual(["-i"]);
    expect(runner.requests[0]?.stdin).toContain('macos-\\"secret\\"');
    expect(runner.requests.flatMap((request) => request.args)).not.toContain(rawSecret);
  });

  it("treats a macOS keychain error written to stderr as a failure", async () => {
    const runner = new FakeCommandRunner(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "security: SecKeychainAddGenericPassword: User interaction is not allowed.",
    }));
    const store = new SystemCredentialStore(new MacOsKeychainBackend(runner));

    await expect(store.set(key, SecretValue.from("value"))).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
  });

  it("reports a Windows session without a credential set as unavailable", async () => {
    const runner = new FakeCommandRunner(() => ({
      exitCode: 0,
      stdout: '{"status":"unavailable"}',
      stderr: "",
    }));
    const store = new SystemCredentialStore(
      new WindowsCredentialManagerBackend(runner),
    );

    await expect(store.get(key)).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    });
  });

  it("enforces the Windows credential blob size before invoking PowerShell", async () => {
    const runner = new FakeCommandRunner(() => ({
      exitCode: 0,
      stdout: '{"status":"ok"}',
      stderr: "",
    }));
    const store = new SystemCredentialStore(
      new WindowsCredentialManagerBackend(runner),
    );

    await expect(store.set(key, SecretValue.from("x".repeat(2_561)))).rejects.toMatchObject({
      code: "INVALID_SECRET",
    });
    expect(runner.requests).toEqual([]);
  });

  it("uses secret-tool stdin and treats empty lookup output as missing", async () => {
    const rawSecret = "linux-secret-value";
    const runner = new FakeCommandRunner(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const store = new SystemCredentialStore(new LinuxSecretServiceBackend(runner));

    await store.set(key, SecretValue.from(rawSecret));
    expect(await store.get(key)).toBeNull();
    await store.delete(key);

    expect(runner.requests.map((request) => request.args[0])).toEqual([
      "store",
      "lookup",
      "clear",
    ]);
    expect(runner.requests[0]?.stdin).toBe(rawSecret);
    expect(runner.requests.flatMap((request) => request.args)).not.toContain(rawSecret);
  });

  it("treats secret-tool lookup exit code 1 as missing, not a backend failure", async () => {
    const runner = new FakeCommandRunner((request) => {
      if (request.args[0] === "lookup") return { exitCode: 1, stdout: "", stderr: "" };
      if (request.args[0] === "clear") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = new SystemCredentialStore(new LinuxSecretServiceBackend(runner));

    expect(await store.get(key)).toBeNull();
    await store.delete(key);
  });

  it("preserves a trailing newline returned by Secret Service", async () => {
    const runner = new FakeCommandRunner(() => ({
      exitCode: 0,
      stdout: "secret-with-newline\n",
      stderr: "",
    }));
    const store = new SystemCredentialStore(new LinuxSecretServiceBackend(runner));

    expect((await store.get(key))?.reveal()).toBe("secret-with-newline\n");
  });

  it("rejects secrets beyond the secret-tool stdin limit", async () => {
    const runner = new FakeCommandRunner(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const store = new SystemCredentialStore(new LinuxSecretServiceBackend(runner));

    await expect(store.set(key, SecretValue.from("x".repeat(8_192)))).rejects.toMatchObject({
      code: "INVALID_SECRET",
    });
    expect(runner.requests).toEqual([]);
  });

  it("maps a missing native helper to BACKEND_UNAVAILABLE", async () => {
    const runner = new FakeCommandRunner(() => {
      throw new CommandRunnerError("not-found", "missing");
    });
    const store = new SystemCredentialStore(new LinuxSecretServiceBackend(runner));

    await expect(store.get(key)).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    } satisfies Partial<CredentialStoreError>);
  });

  it("selects supported platforms and refuses unsafe fallback", () => {
    const runner = new FakeCommandRunner(() => ({
      exitCode: 0,
      stdout: '{"status":"missing"}',
      stderr: "",
    }));

    expect(createDefaultCredentialStore({ platform: "win32", commandRunner: runner }))
      .toBeInstanceOf(SystemCredentialStore);
    expect(createDefaultCredentialStore({ platform: "linux", commandRunner: runner }))
      .toBeInstanceOf(SystemCredentialStore);
    expect(() =>
      createDefaultCredentialStore({ platform: "freebsd", commandRunner: runner }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_PLATFORM" }));
  });

  it("refuses macOS by default, and says what taking the opt-in means", () => {
    const runner = new FakeCommandRunner(() => ({ exitCode: 0, stdout: '{"status":"missing"}', stderr: "" }));

    // ADR 0024 withdrew the macOS claim and ADR 0027 narrowed M2's exit
    // condition to match. This is the half of that decision that is code: the
    // backend has only ever run against a mock command runner, and leaving it
    // selected by default would keep an unverified implementation serving the
    // credential path on a platform we no longer say we support.
    let thrown: unknown;
    try {
      createDefaultCredentialStore({ platform: "darwin", commandRunner: runner });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
    // The message has to carry the way out and the caveat, or the refusal is
    // just a wall.
    expect((thrown as Error).message).toContain("APEXNOVA_ALLOW_UNVERIFIED_MACOS=1");
    expect((thrown as Error).message).toContain("never been verified");

    // Opting in is a choice someone can make; it does not make the backend
    // verified, and the message above says so.
    expect(createDefaultCredentialStore({ platform: "darwin", commandRunner: runner, allowUnverifiedMacOs: true }))
      .toBeInstanceOf(SystemCredentialStore);
  });
});

describe("file backend", () => {
  /**
   * The tests that write a credential file need a filesystem that keeps POSIX
   * modes. `chmod` is a no-op on NTFS, so a file written 0600 reads back 0666
   * and the backend correctly refuses it as exposed -- declaring
   * `platform: "linux"` asks the backend to behave like Linux, it does not give
   * Windows a Linux filesystem. The decision-logic tests below touch no files
   * and run everywhere.
   */
  const onPosix = it.skipIf(process.platform === "win32");

  async function temporaryFile(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    return join(directory, "store", "credentials.json");
  }

  onPosix("stores, reads back and deletes without any credential service", async () => {
    const path = await temporaryFile("apexnova-file-");
    const store = new SystemCredentialStore(new FileCredentialBackend(path, { platform: "linux" }));

    expect(await store.get(key)).toBeNull();
    await store.set(key, SecretValue.from("first"));
    expect((await store.get(key))?.reveal()).toBe("first");
    await store.set(key, SecretValue.from("second"));
    expect((await store.get(key))?.reveal()).toBe("second");

    // A second backend over the same path is what a second `apexnova` process
    // is: the value has to be on disk, not in the first instance's memory.
    const reopened = new SystemCredentialStore(new FileCredentialBackend(path, { platform: "linux" }));
    expect((await reopened.get(key))?.reveal()).toBe("second");

    await store.delete(key);
    expect(await reopened.get(key)).toBeNull();
    // Deleting the last secret of a service must not take the others with it.
    await store.delete(key);
  });

  onPosix("keeps the directory and file private to the user", async () => {
    const path = await temporaryFile("apexnova-file-mode-");
    const store = new SystemCredentialStore(new FileCredentialBackend(path, { platform: "linux" }));
    await store.set(key, SecretValue.from("private"));

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  onPosix("refuses a credential file other users can read instead of repairing it", async () => {
    const path = await temporaryFile("apexnova-file-exposed-");
    const backend = new FileCredentialBackend(path, { platform: "linux" });
    const store = new SystemCredentialStore(backend);
    await store.set(key, SecretValue.from("exposed"));
    chmodSync(path, 0o644);

    // Widening happened outside this process, so the secret has already been
    // readable by every account on the machine. chmod here would hide that;
    // the error names the rotation the user now has to do.
    await expect(store.get(key)).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    await expect(store.get(key)).rejects.toThrowError(/revoke them/);
  });

  onPosix("never overwrites a credential file it cannot parse", async () => {
    const path = await temporaryFile("apexnova-file-corrupt-");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "not json at all", { mode: 0o600 });
    const store = new SystemCredentialStore(new FileCredentialBackend(path, { platform: "linux" }));

    await expect(store.get(key)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    await expect(store.set(key, SecretValue.from("new"))).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    expect(readFileSync(path, "utf8")).toBe("not json at all");
  });

  it("is what Linux gets by default, and what Windows does not", () => {
    const runner = new FakeCommandRunner(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    const environment = { HOME: "/home/tester" } satisfies NodeJS.ProcessEnv;

    // ADR 0036: the Secret Service is absent in most of the Linux sessions this
    // runs in, so Linux starts here rather than at a keyring nobody installed.
    expect(
      resolveCredentialBackendSelection({ platform: "linux", environment }),
    ).toMatchObject({
      kind: "file",
      source: "default",
      path: "/home/tester/.local/share/apexnova-connect/credentials.json",
    });

    // Windows Credential Manager is present and verified, so nothing there
    // trades OS protection away for a convenience Windows already has.
    expect(
      resolveCredentialBackendSelection({ platform: "win32", environment }),
    ).toMatchObject({ kind: "system", source: "default" });

    // Both directions are selectable: the default is a starting point, not a
    // ceiling.
    expect(
      resolveCredentialBackendSelection({ platform: "linux", environment, backend: "system" }),
    ).toMatchObject({ kind: "system", source: "option" });
    expect(
      resolveCredentialBackendSelection({
        platform: "linux",
        environment: { ...environment, APEXNOVA_CREDENTIAL_STORE: "system" },
      }),
    ).toMatchObject({ kind: "system", source: "environment" });

    expect(createDefaultCredentialStore({ platform: "linux", environment, commandRunner: runner }))
      .toBeInstanceOf(SystemCredentialStore);
  });

  it("still fails rather than switching stores when a chosen keyring is missing", async () => {
    // The default moved; the rule did not. Asking for the OS service and
    // finding nothing there is an error, because secrets that quietly relocate
    // are secrets nobody can find again.
    const runner = new FakeCommandRunner(() => {
      throw new CommandRunnerError("not-found", "secret-tool is not installed");
    });
    const store = createDefaultCredentialStore({
      platform: "linux",
      environment: { HOME: "/home/tester" },
      backend: "system",
      commandRunner: runner,
    });

    await expect(store.get(key)).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  });

  it("refuses a misspelled backend rather than guessing which one was meant", () => {
    expect(() =>
      resolveCredentialBackendSelection({
        platform: "linux",
        environment: { HOME: "/home/tester", APEXNOVA_CREDENTIAL_STORE: "keyring" },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("serves an unsupported platform, where no system backend exists", () => {
    const store = createDefaultCredentialStore({
      platform: "freebsd",
      environment: { HOME: "/home/tester", APEXNOVA_CREDENTIAL_STORE: "file" },
    });
    expect(store).toBeInstanceOf(SystemCredentialStore);

    // Unsupported platforms are not quietly handed the file backend either:
    // the refusal names it, and the user takes it or not.
    expect(() => createDefaultCredentialStore({ platform: "freebsd", environment: { HOME: "/home/tester" } }))
      .toThrowError(expect.objectContaining({ code: "UNSUPPORTED_PLATFORM" }));
  });
});
