import { describe, expect, it, vi } from "vitest";
import { SecretValue } from "@apexnova-connect/credential-store";
import type { CredentialStore } from "@apexnova-connect/credential-store";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT_CODES, RuntimeBindingStore, resolveOpenCodeExecutable, runCli, type CliIo, type HubCommandService } from "../src/index.js";
import { HubClientError } from "@apexnova-connect/hub-client";
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
    estimatePricing: async () => ({ deploymentId: "deployment.nova", model: "nova", currency: "USD", billingMode: "token", listAmount: "0.000120", discountRate: "0.5", amount: "0.000060", priceVersion: "2026-09-05T10:00:00Z", estimateOnly: true }),
    usage: async () => undefined,
    usageQuery: async () => ({ items: [], asOf: "2026-09-06T12:00:00Z" }),
    createRuntimeCredential: async () => ({ credentialId: "rtc_1", expiresAt: "2099-09-05T12:00:00Z", deviceId: "device_1", secret: SecretValue.from("runtime-secret") }),
    runtimeCredentials: async () => [{ credentialId: "rtc_1", name: "OpenCode", prefix: "anrt_abcd...wxyz", deviceId: "device_1", protocols: ["openai-responses"], publicDeploymentIds: ["deployment.nova"], expiresAt: "2099-09-05T12:00:00Z", createdAt: "2026-09-05T12:00:00Z" }],
    revokeRuntimeCredential: async () => undefined,
    createApiKey: async () => ({ id: "key_1", name: "OpenCode", prefix: "sk_abcd...wxyz", kind: "user", protocols: ["openai-responses"], publicDeploymentIds: ["deployment.nova"], createdAt: "2026-09-06T12:00:00Z", secret: SecretValue.from("api-key-secret") }),
    apiKeys: async () => [],
    apiKey: async () => ({ id: "key_1", name: "OpenCode", prefix: "sk_abcd...wxyz", kind: "user", protocols: ["openai-responses"], publicDeploymentIds: ["deployment.nova"], createdAt: "2026-09-06T12:00:00Z" }),
    updateApiKey: async () => ({ id: "key_1", name: "OpenCode", prefix: "sk_abcd...wxyz", kind: "user", protocols: ["openai-responses"], publicDeploymentIds: ["deployment.nova"], createdAt: "2026-09-06T12:00:00Z" }),
    revokeApiKey: async () => undefined,
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
  it("resolves the native OpenCode target behind an npm Windows shim without a shell", () => {
    const expected = "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
    expect(resolveOpenCodeExecutable("win32", { PATH: "C:\\other;C:\\npm" }, (path) => path === expected)).toBe(expected);
    expect(resolveOpenCodeExecutable("linux", {}, () => false)).toBe("opencode");
  });

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
    const login = vi.fn(mockHub().login);
    const result = await runCli(["login", "--profile", "work", "--json"], { io: capture.io, hubService: mockHub({ login }), createRequestId: () => "local_login" });
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout()).data).toMatchObject({ profile: "work", authenticated: true, accountId: "account_1" });
    expect(capture.stderr()).toContain("ABCD-EFGH");
    expect(`${capture.stdout()}${capture.stderr()}`).not.toContain("access-secret");
    expect(`${capture.stdout()}${capture.stderr()}`).not.toContain("refresh-secret");
    expect(login.mock.calls[0]?.[2]).toBeUndefined();
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

  it("reissues the previous runtime target when restoring a switch, then disconnects on the initial restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-switch-restore-"));
    const configPath = join(root, "opencode.jsonc");
    const original = "{\n  \"theme\": \"dark\"\n}\n";
    await writeFile(configPath, original, "utf8");
    const credentials = memoryCredentials();
    const bindings = new RuntimeBindingStore(credentials);
    const baseCatalog = await mockHub().catalog("default", new AbortController().signal);
    const catalog = {
      ...baseCatalog,
      deployments: baseCatalog.deployments.map((deployment) => ({
        ...deployment,
        protocols: [
          ...deployment.protocols,
          { protocol: "openai-chat", baseUrl: "https://api.example.test/v1/chat/completions" },
        ],
      })),
    };
    const active = new Map<string, { readonly protocol: string; readonly deploymentId: string; readonly expiresAt: string }>();
    let credentialSequence = 0;
    const createRuntimeCredential: HubCommandService["createRuntimeCredential"] = async (_profile, input) => {
      credentialSequence += 1;
      const credentialId = `rtc_${credentialSequence}`;
      const expiresAt = "2099-09-05T12:00:00Z";
      active.set(credentialId, { protocol: input.protocols[0]!, deploymentId: input.publicDeploymentIds[0]!, expiresAt });
      return { credentialId, expiresAt, deviceId: "device_1", secret: SecretValue.from(`runtime-secret-${credentialSequence}`) };
    };
    const revokeRuntimeCredential = vi.fn(async (_profile: string, credentialId: string) => { active.delete(credentialId); });
    const runtimeCredentials: HubCommandService["runtimeCredentials"] = async () => [...active].map(([credentialId, item]) => ({
      credentialId,
      name: "OpenCode",
      prefix: "anrt_test...test",
      deviceId: "device_1",
      protocols: [item.protocol],
      publicDeploymentIds: [item.deploymentId],
      expiresAt: item.expiresAt,
      createdAt: "2026-09-05T12:00:00Z",
    }));
    const hub = mockHub({ catalog: async () => catalog, createRuntimeCredential, runtimeCredentials, revokeRuntimeCredential });
    const common = {
      hubService: hub,
      credentialStore: credentials,
      detectOpenCode: async () => ({ ...installed, configPath }),
      platform: "win32" as const,
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      cwd: root,
      createRequestId: () => "local_switch_restore",
    };

    const connectCapture = captureIo();
    const connected = await runCli(["connect", "opencode", "--deployment", "deployment.nova", "--protocol", "openai-responses", "--yes", "--json"], { ...common, io: connectCapture.io });
    expect(connected.exitCode).toBe(EXIT_CODES.success);
    const initialTransactionId = JSON.parse(connectCapture.stdout()).data.transactionId as string;

    const switchCapture = captureIo();
    const switched = await runCli(["switch", "opencode", "--deployment", "deployment.nova", "--protocol", "openai-chat", "--yes", "--json"], { ...common, io: switchCapture.io });
    expect(switched.exitCode).toBe(EXIT_CODES.success);
    const switchTransactionId = JSON.parse(switchCapture.stdout()).data.transactionId as string;
    expect(switchTransactionId).not.toBe(initialTransactionId);
    expect((await bindings.load("default"))).toMatchObject({
      credentialId: "rtc_2",
      protocol: "openai-chat",
      transactionId: switchTransactionId,
      restoreTarget: { protocol: "openai-responses", deploymentId: "deployment.nova", transactionId: initialTransactionId },
    });
    const storedAfterSwitch = await credentials.get({ integrationId: "opencode", accountId: "default", kind: "runtime-credential" });
    expect(storedAfterSwitch?.reveal()).not.toContain("runtime-secret-1");
    expect(active.has("rtc_1")).toBe(false);

    const outOfOrderCapture = captureIo();
    const outOfOrder = await runCli(["restore", initialTransactionId, "--yes", "--json"], { ...common, io: outOfOrderCapture.io });
    expect(outOfOrder.exitCode).toBe(EXIT_CODES.conflict);
    expect(JSON.parse(outOfOrderCapture.stdout())).toMatchObject({ error: { code: "RESTORE_ORDER_CONFLICT" } });
    expect((await bindings.load("default"))?.credentialId).toBe("rtc_2");

    const restoreSwitchCapture = captureIo();
    const restoredSwitch = await runCli(["restore", switchTransactionId, "--yes", "--json"], { ...common, io: restoreSwitchCapture.io });
    expect(restoredSwitch.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(restoreSwitchCapture.stdout())).toMatchObject({ data: { runtimeCredentialRestored: true, runtimeCredentialRevoked: true } });
    expect((await bindings.load("default"))).toMatchObject({
      credentialId: "rtc_3",
      protocol: "openai-responses",
      transactionId: initialTransactionId,
    });
    expect((await bindings.load("default"))?.restoreTarget).toBeUndefined();
    expect(active.has("rtc_2")).toBe(false);

    const restoreInitialCapture = captureIo();
    const restoredInitial = await runCli(["restore", initialTransactionId, "--yes", "--json"], { ...common, io: restoreInitialCapture.io });
    expect(restoredInitial.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(restoreInitialCapture.stdout())).toMatchObject({ data: { runtimeCredentialRestored: false, runtimeCredentialRevoked: true } });
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await bindings.load("default")).toBeNull();
    expect(active.size).toBe(0);
    expect(revokeRuntimeCredential.mock.calls.map((call) => call[1])).toEqual(["rtc_1", "rtc_2", "rtc_3"]);
  });

  it("renews a runtime credential before launch and revokes the previous credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-renew-"));
    const credentials = memoryCredentials();
    const bindings = new RuntimeBindingStore(credentials);
    await bindings.save("default", {
      credentialId: "rtc_old",
      secret: SecretValue.from("old-runtime-secret"),
      expiresAt: "2026-09-05T10:30:00Z",
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
    });
    const issue = vi.fn(async () => ({ credentialId: "rtc_new", expiresAt: "2026-09-06T10:00:00Z", deviceId: "device_1", secret: SecretValue.from("new-runtime-secret") }));
    const revoke = vi.fn(async () => undefined);
    let launchedSecret: string | undefined;
    const capture = captureIo();
    const result = await runCli(["run", "opencode", "--json"], {
      io: capture.io,
      credentialStore: credentials,
      detectOpenCode: async () => installed,
      hubService: mockHub({
        createRuntimeCredential: issue,
        runtimeCredentials: async () => [{ credentialId: "rtc_new", name: "OpenCode", prefix: "anrt_new...test", deviceId: "device_1", protocols: ["openai-responses"], publicDeploymentIds: ["deployment.nova"], expiresAt: "2026-09-06T10:00:00Z", createdAt: "2026-09-05T10:00:00Z" }],
        revokeRuntimeCredential: revoke,
      }),
      launchOpenCode: async (_args, environment) => { launchedSecret = environment.APEXNOVA_API_KEY; return 0; },
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      now: () => new Date("2026-09-05T10:00:00Z"),
      createRequestId: () => "local_renew",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout())).toMatchObject({ data: { credentialRotated: true, credentialExpiresAt: "2026-09-06T10:00:00Z" } });
    expect(issue).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("default", "rtc_old", expect.any(AbortSignal));
    expect(launchedSecret).toBe("new-runtime-secret");
    expect((await bindings.load("default"))?.credentialId).toBe("rtc_new");
    expect(capture.stdout()).not.toContain("new-runtime-secret");
  });

  it("keeps the previous binding when a renewed credential cannot be verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-renew-fail-"));
    const credentials = memoryCredentials();
    const bindings = new RuntimeBindingStore(credentials);
    await bindings.save("default", {
      credentialId: "rtc_old",
      secret: SecretValue.from("old-runtime-secret"),
      expiresAt: "2026-09-05T10:30:00Z",
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
    });
    const revoke = vi.fn(async () => undefined);
    const launch = vi.fn(async () => 0);
    const capture = captureIo();
    const result = await runCli(["run", "opencode", "--json"], {
      io: capture.io,
      credentialStore: credentials,
      detectOpenCode: async () => installed,
      hubService: mockHub({
        createRuntimeCredential: async () => ({ credentialId: "rtc_new", expiresAt: "2026-09-06T10:00:00Z", deviceId: "device_1", secret: SecretValue.from("new-runtime-secret") }),
        runtimeCredentials: async () => [],
        revokeRuntimeCredential: revoke,
      }),
      launchOpenCode: launch,
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      now: () => new Date("2026-09-05T10:00:00Z"),
      createRequestId: () => "local_renew_fail",
    });

    expect(result.exitCode).toBe(EXIT_CODES.verification);
    expect(JSON.parse(capture.stdout())).toMatchObject({ error: { code: "VERIFICATION_FAILED" } });
    expect(revoke).toHaveBeenCalledWith("default", "rtc_new", expect.any(AbortSignal));
    expect((await bindings.load("default"))?.credentialId).toBe("rtc_old");
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a config-only OpenCode launcher before reading runtime credentials", async () => {
    const capture = captureIo();
    const credentials = {
      ...memoryCredentials(),
      get: vi.fn(async () => null),
    };
    const launch = vi.fn(async () => 0);
    const result = await runCli(["run", "opencode", "--json"], {
      io: capture.io,
      credentialStore: credentials,
      detectOpenCode: async () => {
        const { productVersion: _productVersion, ...configOnly } = installed;
        return { ...configOnly, status: "config-only" };
      },
      launchOpenCode: launch,
      createRequestId: () => "local_run_missing",
    });

    expect(result.exitCode).toBe(EXIT_CODES.unavailable);
    expect(JSON.parse(capture.stdout())).toMatchObject({ error: { code: "AGENT_NOT_FOUND" } });
    expect(credentials.get).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
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

  it("shows a non-binding estimate and requires approval before live verification", async () => {
    const capture = captureIo();
    const credentials = memoryCredentials();
    await new RuntimeBindingStore(credentials).save("default", {
      credentialId: "rtc_1",
      secret: SecretValue.from("runtime-secret"),
      expiresAt: "2099-09-05T12:00:00Z",
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
    });
    const live = vi.fn();
    const result = await runCli(["verify", "opencode", "--live", "--json"], {
      io: capture.io,
      credentialStore: credentials,
      hubService: mockHub(),
      detectOpenCode: async () => installed,
      inspectOpenCode: async () => ({ agentId: "opencode", configPath: installed.configPath, status: "configured", managed: true, provider: { id: "apexnova", protocol: "openai-responses", environmentVariables: ["APEXNOVA_API_KEY"], modelIds: ["nova"] }, warnings: [] }),
      verifyHubInference: live,
      createRequestId: () => "local_live_approval",
    });

    expect(result.exitCode).toBe(EXIT_CODES.permission);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      error: { code: "APPROVAL_REQUIRED", details: { estimate: { amount: "0.000060", currency: "USD", estimateOnly: true }, estimateAssumptions: { inputTokens: 64, outputTokens: 256 } } },
    });
    expect(live).not.toHaveBeenCalled();
    expect(capture.stdout()).not.toContain("runtime-secret");
  });

  it("performs an approved live verification without exposing the credential", async () => {
    const capture = captureIo();
    const credentials = memoryCredentials();
    await new RuntimeBindingStore(credentials).save("default", {
      credentialId: "rtc_1",
      secret: SecretValue.from("runtime-secret"),
      expiresAt: "2099-09-05T12:00:00Z",
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
    });
    const live = vi.fn(async () => ({ status: 200, protocol: "openai-responses" as const, requestId: "req_live", providerId: "provider.apexnova-ai-hub", requestedModel: "nova", resolvedModel: "nova", deploymentId: "deployment.nova" }));
    const result = await runCli(["verify", "opencode", "--live", "--yes", "--json"], {
      io: capture.io,
      credentialStore: credentials,
      hubService: mockHub(),
      detectOpenCode: async () => installed,
      inspectOpenCode: async () => ({ agentId: "opencode", configPath: installed.configPath, status: "configured", managed: true, provider: { id: "apexnova", protocol: "openai-responses", environmentVariables: ["APEXNOVA_API_KEY"], modelIds: ["nova"] }, warnings: [] }),
      verifyHubInference: live,
      createRequestId: () => "local_live",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout())).toMatchObject({ data: { valid: true, level: "live", inference: { requestId: "req_live", deploymentId: "deployment.nova" } } });
    expect(live).toHaveBeenCalledWith(expect.objectContaining({ model: "nova", deploymentId: "deployment.nova", protocol: "openai-responses" }));
    expect(capture.stdout()).not.toContain("runtime-secret");
  });

  it("reconciles the real billed cost from the Hub after live verification", async () => {
    const capture = captureIo();
    const credentials = memoryCredentials();
    await new RuntimeBindingStore(credentials).save("default", {
      credentialId: "rtc_1",
      secret: SecretValue.from("runtime-secret"),
      expiresAt: "2099-09-05T12:00:00Z",
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
    });
    const live = vi.fn(async () => ({ status: 200, protocol: "openai-responses" as const, requestId: "req_billed", providerId: "provider.apexnova-ai-hub", requestedModel: "nova", resolvedModel: "nova", deploymentId: "deployment.nova" }));
    const usage = vi.fn(async () => ({
      id: "use_1", requestId: "req_billed", at: "2026-09-05T23:00:00Z", status: "success" as const,
      resolvedModel: "nova", source: "api", currency: "USD", amount: "0.006978",
      usage: { inputTokens: 6964, outputTokens: 7 },
    }));
    const result = await runCli(["verify", "opencode", "--live", "--yes", "--json"], {
      io: capture.io,
      credentialStore: credentials,
      hubService: mockHub({ usage }),
      detectOpenCode: async () => installed,
      inspectOpenCode: async () => ({ agentId: "opencode", configPath: installed.configPath, status: "configured", managed: true, provider: { id: "apexnova", protocol: "openai-responses", environmentVariables: ["APEXNOVA_API_KEY"], modelIds: ["nova"] }, warnings: [] }),
      verifyHubInference: live,
      createRequestId: () => "local_billed",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output).toMatchObject({ data: { usage: { requestId: "req_billed", amount: "0.006978", currency: "USD" } } });
    expect(output.warnings).toEqual([]);
    expect(usage).toHaveBeenCalledWith("default", "req_billed", expect.any(AbortSignal));
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

  it("loads legacy runtime bindings and upgrades them without inventing a restore target", async () => {
    const credentials = memoryCredentials();
    const key = { integrationId: "opencode", accountId: "legacy", kind: "runtime-credential" } as const;
    await credentials.set(key, SecretValue.from(JSON.stringify({
      version: 1,
      credentialId: "rtc_legacy",
      secret: "legacy-runtime-secret",
      expiresAt: "2099-09-05T12:00:00Z",
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
    })));
    const bindings = new RuntimeBindingStore(credentials);

    const loaded = await bindings.load("legacy");
    expect(loaded).toMatchObject({ credentialId: "rtc_legacy", protocol: "openai-responses", deploymentId: "deployment.nova" });
    expect(loaded?.restoreTarget).toBeUndefined();
    await bindings.save("legacy", loaded!);

    expect(JSON.parse((await credentials.get(key))!.reveal())).toMatchObject({ version: 3, credentialId: "rtc_legacy", kind: "runtime" });
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

  it("retries a rate-limited control-plane call using Retry-After and succeeds", async () => {
    const capture = captureIo();
    let calls = 0;
    const balance = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new HubClientError("RATE_LIMITED", "Rate limited.", { retryable: true, retryAfterSeconds: 2 });
      return { currency: "USD", normalBalance: "20.000000", held: "0.000000", normalAvailable: "20.000000", promoCredits: [], asOf: "2026-09-04T12:00:00Z" };
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await runCli(["balance", "--json"], {
      io: capture.io,
      hubService: mockHub({ balance }),
      sleep,
      createRequestId: () => "local_retry",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(balance).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
  });

  it("stops retrying after the limit and surfaces retryAfterSeconds in the error", async () => {
    const capture = captureIo();
    const balance = vi.fn(async () => {
      throw new HubClientError("RATE_LIMITED", "Rate limited.", { retryable: true, retryAfterSeconds: 1 });
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await runCli(["balance", "--json"], {
      io: capture.io,
      hubService: mockHub({ balance }),
      sleep,
      createRequestId: () => "local_retry_exhausted",
    });

    expect(result.exitCode).toBe(EXIT_CODES.network);
    expect(balance).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(JSON.parse(capture.stdout())).toMatchObject({ error: { code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 1 } });
  });

  it("does not retry a billing-blocked error", async () => {
    const capture = captureIo();
    const balance = vi.fn(async () => {
      throw new HubClientError("BILLING_BLOCKED", "Insufficient balance.", { retryable: false });
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await runCli(["balance", "--json"], {
      io: capture.io,
      hubService: mockHub({ balance }),
      sleep,
      createRequestId: () => "local_billing",
    });

    expect(result.exitCode).toBe(EXIT_CODES.billing);
    expect(balance).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
