import { describe, expect, it } from "vitest";

import {
  CommandRunnerError,
  CredentialStoreError,
  LinuxSecretServiceBackend,
  MemoryCredentialBackend,
  SecretValue,
  SystemCredentialStore,
  WindowsCredentialManagerBackend,
  createDefaultCredentialStore,
  credentialAccountName,
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
      createDefaultCredentialStore({ platform: "darwin", commandRunner: runner }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_PLATFORM" }));
  });
});
