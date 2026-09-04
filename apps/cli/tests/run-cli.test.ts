import { describe, expect, it, vi } from "vitest";
import { SecretValue } from "@apexnova-connect/credential-store";
import type { CredentialStore } from "@apexnova-connect/credential-store";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT_CODES, runCli, type CliIo, type HubCommandService } from "../src/index.js";
import type { OpenCodeDetection, OpenCodeInspection } from "@apexnova-connect/integration-opencode";

function captureIo() {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    isInteractive: false,
  };
  return {
    io,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

const installed: OpenCodeDetection = {
  agentId: "opencode",
  displayName: "OpenCode",
  status: "installed",
  productVersion: "2.4.1",
  configPath: "/safe/opencode.jsonc",
  configExists: true,
  configScope: "project",
  evidence: ["test"],
  warnings: [],
};

function mockHub(overrides: Partial<HubCommandService> = {}): HubCommandService {
  return {
    login: async (_profile, prompt) => {
      await prompt({ userCode: "ABCD-EFGH", verificationUri: "https://hub.example.test/device", expiresAt: "2026-09-04T12:10:00Z" });
      return { accessToken: SecretValue.from("access-secret"), refreshToken: SecretValue.from("refresh-secret"), tokenType: "Bearer", expiresAt: "2026-09-04T12:10:00Z", accountId: "account_1" };
    },
    logout: async () => ({ serverRevoked: false }),
    whoami: async () => ({ accountId: "account_1", userId: "user_1", displayName: "Example User", plan: { id: "personal", name: "Personal" }, defaultCurrency: "USD", createdAt: "2026-09-04T12:00:00Z", context: { type: "personal" }, deviceId: "device_1", scopes: ["account:read"] }),
    balance: async () => ({ currency: "USD", normalBalance: "20.000000", held: "2.000000", normalAvailable: "18.000000", promoCredits: [], asOf: "2026-09-04T12:00:00Z" }),
    catalog: async () => ({
      schemaVersion: "0.1", catalogVersion: "cat_1", generatedAt: "2026-09-04T12:00:00Z", expiresAt: "2026-09-04T12:15:00Z", providers: [],
      models: [{ id: "model.nova", name: "Nova Coder", publisher: "apexnova", modelType: "chat", capabilities: ["tool.calling"], deploymentIds: ["deployment.nova"] }],
      deployments: [{ id: "deployment.nova", providerId: "provider.apexnova-ai-hub", modelId: "model.nova", displayName: "Nova Coder", inferenceAlias: "nova", aliases: ["nova"], protocols: [{ protocol: "openai-responses", baseUrl: "https://api.example.test/v1/responses" }], limits: { contextWindow: 128000, maxOutputTokens: 8192 }, capabilities: ["tool.calling"], availability: { status: "available", observedAt: "2026-09-04T12:00:00Z" } }],
    }),
    createRuntimeCredential: async () => ({ credentialId: "rtc_1", expiresAt: "2099-09-05T12:00:00Z", deviceId: "device_1", secret: SecretValue.from("runtime-secret") }),
    revokeRuntimeCredential: async () => undefined,
    ...overrides,
  };
}

function memoryCredentials(): CredentialStore {
  const values = new Map<string, SecretValue>();
  const name = (key: { integrationId: string; accountId: string; kind: string }) => `${key.integrationId}/${key.accountId}/${key.kind}`;
  return {
    set: async (key, secret) => { values.set(name(key), secret); },
    get: async (key) => values.get(name(key)) ?? null,
    delete: async (key) => { values.delete(name(key)); },
  };
}

describe("CLI", () => {
  it("emits the versioned JSON envelope for detect", async () => {
    const capture = captureIo();
    const detect = vi.fn(async () => installed);
    const result = await runCli(["detect", "opencode", "--json"], {
      io: capture.io,
      detectOpenCode: detect,
      createRequestId: () => "local_test",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout())).toEqual({
      schemaVersion: "1",
      command: "detect",
      requestId: "local_test",
      ok: true,
      data: installed,
      warnings: [],
    });
    expect(capture.stderr()).toBe("");
  });

  it("maps a missing requested agent to exit code 5", async () => {
    const capture = captureIo();
    const result = await runCli(["detect", "opencode", "--json"], {
      io: capture.io,
      detectOpenCode: async () => ({
        ...installed,
        status: "not-found",
        productVersion: undefined,
        configExists: false,
      } as unknown as OpenCodeDetection),
      createRequestId: () => "local_missing",
    });

    expect(result.exitCode).toBe(EXIT_CODES.unavailable);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      ok: false,
      error: { code: "AGENT_NOT_FOUND", retryable: false },
    });
  });

  it("returns sanitized inspection metadata", async () => {
    const capture = captureIo();
    const inspection: OpenCodeInspection = {
      agentId: "opencode",
      configPath: installed.configPath,
      status: "configured",
      managed: true,
      provider: {
        id: "apexnova",
        protocol: "openai-responses",
        baseUrl: "https://api.example.test/v1",
        environmentVariables: ["APEXNOVA_API_KEY"],
        modelIds: ["nova-coder"],
      },
      warnings: [],
    };
    const result = await runCli(["inspect", "opencode", "--json"], {
      io: capture.io,
      detectOpenCode: async () => installed,
      inspectOpenCode: async () => inspection,
      createRequestId: () => "local_inspect",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout()).data).toEqual(inspection);
  });

  it("rejects legacy config with the documented conflict exit code", async () => {
    const capture = captureIo();
    const result = await runCli(["inspect", "opencode", "--json"], {
      io: capture.io,
      detectOpenCode: async () => installed,
      inspectOpenCode: async () => ({
        agentId: "opencode",
        configPath: installed.configPath,
        status: "legacy",
        managed: false,
        warnings: ["Legacy config detected."],
      }),
      createRequestId: () => "local_legacy",
    });

    expect(result.exitCode).toBe(EXIT_CODES.conflict);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      ok: false,
      error: { code: "LEGACY_CONFIG", message: "Legacy config detected." },
    });
  });

  it("rejects unknown options without printing a stack trace", async () => {
    const capture = captureIo();
    const result = await runCli(["detect", "--api-key", "secret"], {
      io: capture.io,
      createRequestId: () => "local_bad",
    });

    expect(result.exitCode).toBe(EXIT_CODES.usage);
    expect(capture.stderr()).toContain("UNKNOWN_OPTION");
    expect(capture.stderr()).not.toContain("secret");
  });

  it("runs device login without writing tokens to either output stream", async () => {
    const capture = captureIo();
    const result = await runCli(["login", "--profile", "work", "--json"], { io: capture.io, hubService: mockHub(), createRequestId: () => "local_login" });
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout()).data).toMatchObject({ profile: "work", authenticated: true, accountId: "account_1" });
    expect(capture.stderr()).toContain("ABCD-EFGH");
    expect(`${capture.stdout()}${capture.stderr()}`).not.toContain("access-secret");
    expect(`${capture.stdout()}${capture.stderr()}`).not.toContain("refresh-secret");
  });

  it("joins and filters Hub catalog deployments for OpenCode", async () => {
    const capture = captureIo();
    const result = await runCli(["models", "--agent", "opencode", "--compatible-only", "--json"], { io: capture.io, hubService: mockHub(), createRequestId: () => "local_models" });
    const output = JSON.parse(capture.stdout());
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(output.data.deployments[0]).toMatchObject({ id: "deployment.nova", model: { name: "Nova Coder" }, compatibility: "adapter-supported-unverified" });
    expect(output.warnings[0]).toContain("not Agent compatibility evidence");
  });

  it("reports when best-effort server logout does not complete", async () => {
    const capture = captureIo();
    await runCli(["logout", "--json"], { io: capture.io, hubService: mockHub(), createRequestId: () => "local_logout" });
    expect(JSON.parse(capture.stdout())).toMatchObject({ ok: true, data: { localSessionDeleted: true, serverRevoked: false } });
  });

  it("produces a sanitized connect dry-run without modifying configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-plan-"));
    const configPath = join(root, "opencode.jsonc");
    const original = "{\n  // keep this\n  \"theme\": \"dark\"\n}\n";
    await writeFile(configPath, original, "utf8");
    const capture = captureIo();
    const result = await runCli(["connect", "opencode", "--deployment", "deployment.nova", "--dry-run", "--json"], {
      io: capture.io,
      hubService: mockHub(),
      detectOpenCode: async () => ({ ...installed, configPath }),
      inspectOpenCode: async () => ({ agentId: "opencode", configPath, status: "not-configured", managed: false, warnings: [] }),
      createRequestId: () => "local_plan",
    });
    const output = JSON.parse(capture.stdout());
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(output.data).toMatchObject({ dryRun: true, deploymentId: "deployment.nova", protocol: "openai-responses" });
    expect(output.data.plan.operations[0]).not.toHaveProperty("content");
    expect(output.data.plan.operations[0].contentBytes).toBeGreaterThan(0);
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("requires explicit approval before issuing a runtime credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-approval-"));
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, "{}\n", "utf8");
    const capture = captureIo();
    const issue = vi.fn(mockHub().createRuntimeCredential);
    const result = await runCli(["connect", "opencode", "--deployment", "deployment.nova", "--json"], { io: capture.io, hubService: mockHub({ createRuntimeCredential: issue }), detectOpenCode: async () => ({ ...installed, configPath }), createRequestId: () => "local_approval" });
    expect(result.exitCode).toBe(EXIT_CODES.permission);
    expect(JSON.parse(capture.stdout()).error.code).toBe("APPROVAL_REQUIRED");
    expect(issue).not.toHaveBeenCalled();
  });

  it("applies, launches, and restores an OpenCode connection without leaking the runtime secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-connect-"));
    const configPath = join(root, "opencode.jsonc");
    const original = "{\n  \"theme\": \"dark\"\n}\n";
    await writeFile(configPath, original, "utf8");
    const credentials = memoryCredentials();
    const revoke = vi.fn(async () => undefined);
    const hub = mockHub({ revokeRuntimeCredential: revoke });
    const capture = captureIo();
    const common = {
      io: capture.io,
      hubService: hub,
      credentialStore: credentials,
      detectOpenCode: async () => ({ ...installed, configPath }),
      platform: "win32" as const,
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      cwd: root,
      createRequestId: () => "local_connect",
    };
    const connected = await runCli(["connect", "opencode", "--deployment", "deployment.nova", "--yes", "--json"], common);
    const output = JSON.parse(capture.stdout());
    expect(connected.exitCode).toBe(EXIT_CODES.success);
    expect(output.data).toMatchObject({ connected: true, credentialId: "rtc_1" });
    expect(output.data.transactionId).toMatch(/^transaction-/);
    const connectedConfig = await readFile(configPath, "utf8");
    expect(`${capture.stdout()}${connectedConfig}`).not.toContain("runtime-secret");
    expect(connectedConfig).toContain("APEXNOVA_API_KEY");
    expect(connectedConfig).toContain('"baseURL": "https://api.example.test/v1"');
    expect(connectedConfig).not.toContain("/v1/responses\"");

    let launchedSecret: string | undefined;
    const launchCapture = captureIo();
    const launched = await runCli(["run", "opencode", "--json", "--", "--help"], {
      ...common,
      io: launchCapture.io,
      launchOpenCode: async (args, environment) => {
        expect(args).toEqual(["--help"]);
        launchedSecret = environment.APEXNOVA_API_KEY;
        return 0;
      },
    });
    expect(launched.exitCode).toBe(EXIT_CODES.success);
    expect(launchedSecret).toBe("runtime-secret");
    expect(`${launchCapture.stdout()}${launchCapture.stderr()}`).not.toContain("runtime-secret");

    const restoreCapture = captureIo();
    const restored = await runCli(["restore", output.data.transactionId, "--yes", "--json"], { ...common, io: restoreCapture.io });
    expect(restored.exitCode).toBe(EXIT_CODES.success);
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(revoke).toHaveBeenCalledWith("default", "rtc_1", expect.any(AbortSignal));
  });

  it("performs configuration-only verification without a paid request", async () => {
    const capture = captureIo();
    const result = await runCli(["verify", "opencode", "--json"], {
      io: capture.io,
      detectOpenCode: async () => installed,
      inspectOpenCode: async () => ({ agentId: "opencode", configPath: installed.configPath, status: "configured", managed: true, provider: { id: "apexnova", protocol: "openai-responses", environmentVariables: ["APEXNOVA_API_KEY"], modelIds: ["nova"] }, warnings: [] }),
      createRequestId: () => "local_verify",
    });
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout())).toMatchObject({ data: { valid: true, level: "configuration" } });
  });

  it("lists restore transactions without creating local state", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-restore-"));
    const capture = captureIo();
    const result = await runCli(["restore", "--list", "--json"], {
      io: capture.io,
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      cwd: root,
      createRequestId: () => "local_restore",
    });
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout()).data.backups).toEqual([]);
    await expect(access(join(root, "Apexnova", "connect"))).rejects.toBeDefined();
  });

  it("does not fall back to an implicit production Hub", async () => {
    const capture = captureIo();
    const result = await runCli(["balance", "--json"], {
      io: capture.io,
      environment: {},
      platform: "win32",
      createRequestId: () => "local_no_hub",
    });
    expect(result.exitCode).toBe(EXIT_CODES.runtime);
    expect(JSON.parse(capture.stdout())).toMatchObject({ error: { code: "INVALID_CONFIG" } });
  });
});
