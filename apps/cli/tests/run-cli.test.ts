import { describe, expect, it, vi } from "vitest";
import { SecretValue } from "@apexnova-connect/credential-store";
import type { CredentialStore } from "@apexnova-connect/credential-store";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT_CODES, RuntimeBindingStore, runCli, type CliIo, type HubCommandService } from "../src/index.js";
import { HubClientError } from "@apexnova-connect/hub-client";
import { createIntegrationRegistry } from "@apexnova-connect/core";
import {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_SUITE_ID,
  CAPABILITY_SUITE_VERSION,
  FileEvidenceStore,
  createEvidence,
  type CapabilitySuiteResult,
  type CapabilitySupport,
  type EvidenceSubject,
} from "@apexnova-connect/capabilities";
import {
  openCodeIntegration,
  resolveOpenCodeExecutable,
} from "@apexnova-connect/integration-opencode";
import type {
  AgentInspection,
  AgentIntegration,
  DetectionResult,
  IntegrationContext,
} from "@apexnova-connect/integration-sdk";

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

const installed: DetectionResult = {
  agentId: "opencode",
  displayName: "OpenCode",
  status: "installed",
  productVersion: "1.18.29",
  configPath: "/safe/opencode.jsonc",
  configExists: true,
  configScope: "project",
  evidence: ["test"],
  warnings: [],
};

/**
 * The CLI is driven through the registry, so a test swaps in the real OpenCode
 * integration with only the parts it wants to control replaced.
 */
function registryWith(overrides: Partial<AgentIntegration> = {}) {
  return createIntegrationRegistry([{
    ...openCodeIntegration,
    // Executable resolution has its own unit test; CLI tests must not depend on
    // an OpenCode binary existing on the machine running them.
    planLaunch: async (request) => ({
      executable: "opencode",
      args: [...request.args],
      environment: { ...request.context.environment, ...request.credentialEnvironment },
    }),
    ...overrides,
  }]);
}

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
    const context = (platform: "windows" | "linux", environment: Record<string, string>): IntegrationContext => ({
      platform,
      workingDirectory: "/workspace",
      homeDirectory: "/home/tester",
      environment,
    });
    expect(resolveOpenCodeExecutable(context("windows", { PATH: "C:\\other;C:\\npm" }), (path: string) => path === expected)).toBe(expected);
    expect(resolveOpenCodeExecutable(context("linux", {}), () => false)).toBe("opencode");
  });

  it("emits the versioned JSON envelope for detect", async () => {
    const capture = captureIo();
    const detect = vi.fn(async () => installed);
    const result = await runCli(["detect", "opencode", "--json"], {
      io: capture.io,
      registry: registryWith({ detect: detect }),
      createRequestId: () => "local_test",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout())).toEqual({
      schemaVersion: "1",
      command: "detect",
      requestId: "local_test",
      ok: true,
      data: { schemaVersion: "0.1", ...installed },
      warnings: [],
    });
    expect(capture.stderr()).toBe("");
  });

  it("prints a bound credential for an agent helper with nothing else on stdout", async () => {
    const capture = captureIo();
    const credentials = memoryCredentials();
    await new RuntimeBindingStore(credentials).save("opencode", "default", {
      credentialId: "key_1",
      secret: SecretValue.from("helper-secret"),
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
      kind: "user",
    });

    const result = await runCli(["credential", "print", "opencode"], {
      io: capture.io,
      credentialStore: credentials,
      registry: registryWith(),
      hubService: mockHub(),
      createRequestId: () => "local_credential",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(capture.stdout()).toBe("helper-secret\n");
    expect(capture.stderr()).toBe("");
  });

  it("refuses to print a credential that was never bound", async () => {
    const capture = captureIo();
    const result = await runCli(["credential", "print", "opencode", "--json"], {
      io: capture.io,
      credentialStore: memoryCredentials(),
      registry: registryWith(),
      createRequestId: () => "local_credential_missing",
    });

    expect(result.exitCode).toBe(EXIT_CODES.authentication);
    expect(JSON.parse(capture.stdout()).error.code).toBe("RUNTIME_CREDENTIAL_NOT_FOUND");
  });

  it("leaves out an Agent whose manifest excludes this platform", async () => {
    const capture = captureIo();
    const linuxOnly = {
      ...openCodeIntegration,
      manifest: {
        ...openCodeIntegration.manifest,
        compatibility: {
          ...openCodeIntegration.manifest.compatibility,
          platforms: ["linux"] as const,
        },
      },
    } as AgentIntegration;

    const result = await runCli(["detect", "--json"], {
      io: capture.io,
      registry: createIntegrationRegistry([linuxOnly]),
      platform: "win32",
      createRequestId: () => "local_platform",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout()).data.agents).toEqual([]);
  });

  it("refuses an unknown agent and names the ones it supports", async () => {
    const capture = captureIo();
    const result = await runCli(["detect", "hermes", "--json"], {
      io: capture.io,
      registry: registryWith(),
      createRequestId: () => "local_unknown_agent",
    });

    expect(result.exitCode).toBe(EXIT_CODES.unavailable);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      ok: false,
      error: {
        code: "INTEGRATION_NOT_SUPPORTED",
        details: { agentId: "hermes", supportedAgents: ["opencode"] },
      },
    });
  });

  it("refuses to plan against a product version the manifest does not cover", async () => {
    const capture = captureIo();
    const result = await runCli(["connect", "opencode", "--deployment", "deployment.nova", "--dry-run", "--json"], {
      io: capture.io,
      hubService: mockHub(),
      registry: registryWith({
        detect: async () => ({ ...installed, productVersion: "3.0.0" }),
      }),
      createRequestId: () => "local_drift",
    });

    expect(result.exitCode).toBe(EXIT_CODES.conflict);
    const output = JSON.parse(capture.stdout());
    expect(output.error.code).toBe("PRODUCT_VERSION_UNSUPPORTED");
    expect(output.error.message).toContain("3.0.0");
  });

  it("maps a missing requested agent to exit code 5", async () => {
    const capture = captureIo();
    const result = await runCli(["detect", "opencode", "--json"], {
      io: capture.io,
      registry: registryWith({
        detect: async () => ({
          ...installed,
          status: "not-found",
          configExists: false,
        }),
      }),
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
    const inspection: AgentInspection = {
      agentId: "opencode",
      configPath: installed.configPath,
      status: "configured",
      managed: true,
      connection: {
        providerId: "apexnova",
        protocol: "openai-responses",
        baseUrl: "https://api.example.test/v1",
        environmentVariables: ["APEXNOVA_API_KEY"],
        modelIds: ["nova-coder"],
      },
      warnings: [],
    };
    const result = await runCli(["inspect", "opencode", "--json"], {
      io: capture.io,
      registry: registryWith({ detect: async () => installed, inspect: async () => inspection }),
      createRequestId: () => "local_inspect",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout()).data).toEqual({ schemaVersion: "0.1", ...inspection });
  });

  it("rejects legacy config with the documented conflict exit code", async () => {
    const capture = captureIo();
    const result = await runCli(["inspect", "opencode", "--json"], {
      io: capture.io,
      registry: registryWith({
        detect: async () => installed,
        inspect: async () => ({
          agentId: "opencode",
          configPath: installed.configPath,
          status: "legacy",
          managed: false,
          warnings: ["Legacy config detected."],
        }),
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
      registry: registryWith({ detect: async () => ({ ...installed, configPath }), inspect: async () => ({ agentId: "opencode", configPath, status: "not-configured", managed: false, warnings: [] }) }),
      createRequestId: () => "local_plan",
    });
    const output = JSON.parse(capture.stdout());
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(output.data).toMatchObject({ dryRun: true, deploymentId: "deployment.nova", protocol: "openai-responses" });
    expect(output.data.plan.operations[0]).not.toHaveProperty("content");
    expect(output.data.plan.operations[0].contentBytes).toBeGreaterThan(0);
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("accepts the alias the catalog shows, and refuses an ambiguous one", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-alias-"));
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, "{}\n", "utf8");
    const common = {
      registry: registryWith({ detect: async () => ({ ...installed, configPath }) }),
      createRequestId: () => "local_alias",
    };

    // "nova" is the inference alias of deployment.nova; a user reads it off
    // `apexnova models`, not the long catalog ID.
    const capture = captureIo();
    const byAlias = await runCli(
      ["connect", "opencode", "--deployment", "nova", "--dry-run", "--json"],
      { ...common, io: capture.io, hubService: mockHub() },
    );
    expect(byAlias.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout()).data).toMatchObject({ deploymentId: "deployment.nova" });

    // Two deployments answering to one alias is not something to guess at.
    const base = await mockHub().catalog("default", new AbortController().signal);
    const first = base.deployments[0]!;
    const ambiguous = mockHub({
      catalog: async () => ({
        ...base,
        deployments: [first, { ...first, id: "deployment.nova-eu" }],
      }),
    });
    const ambiguousCapture = captureIo();
    const refused = await runCli(
      ["connect", "opencode", "--deployment", "nova", "--dry-run", "--json"],
      { ...common, io: ambiguousCapture.io, hubService: ambiguous },
    );
    expect(refused.exitCode).toBe(EXIT_CODES.usage);
    const error = JSON.parse(ambiguousCapture.stdout()).error;
    expect(error.code).toBe("DEPLOYMENT_AMBIGUOUS");
    expect(error.details.deploymentIds).toEqual(["deployment.nova", "deployment.nova-eu"]);

    // An ID still wins outright, so an alias cannot shadow another deployment.
    const idCapture = captureIo();
    const byId = await runCli(
      ["connect", "opencode", "--deployment", "deployment.nova-eu", "--dry-run", "--json"],
      { ...common, io: idCapture.io, hubService: ambiguous },
    );
    expect(byId.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(idCapture.stdout()).data).toMatchObject({ deploymentId: "deployment.nova-eu" });
  });

  it("requires explicit approval before issuing a runtime credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-approval-"));
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, "{}\n", "utf8");
    const capture = captureIo();
    const issue = vi.fn(mockHub().createRuntimeCredential);
    const result = await runCli(["connect", "opencode", "--deployment", "deployment.nova", "--json"], { io: capture.io, hubService: mockHub({ createRuntimeCredential: issue }), registry: registryWith({ detect: async () => ({ ...installed, configPath }) }), createRequestId: () => "local_approval" });
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
      registry: registryWith({ detect: async () => ({ ...installed, configPath }) }),
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
      launchAgent: async ({ args: args, environment: environment }) => {
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
      registry: registryWith({ detect: async () => ({ ...installed, configPath }) }),
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
    expect((await bindings.load("opencode", "default"))).toMatchObject({
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
    expect((await bindings.load("opencode", "default"))?.credentialId).toBe("rtc_2");

    const restoreSwitchCapture = captureIo();
    const restoredSwitch = await runCli(["restore", switchTransactionId, "--yes", "--json"], { ...common, io: restoreSwitchCapture.io });
    expect(restoredSwitch.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(restoreSwitchCapture.stdout())).toMatchObject({ data: { runtimeCredentialRestored: true, runtimeCredentialRevoked: true } });
    expect((await bindings.load("opencode", "default"))).toMatchObject({
      credentialId: "rtc_3",
      protocol: "openai-responses",
      transactionId: initialTransactionId,
    });
    expect((await bindings.load("opencode", "default"))?.restoreTarget).toBeUndefined();
    expect(active.has("rtc_2")).toBe(false);

    const restoreInitialCapture = captureIo();
    const restoredInitial = await runCli(["restore", initialTransactionId, "--yes", "--json"], { ...common, io: restoreInitialCapture.io });
    expect(restoredInitial.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(restoreInitialCapture.stdout())).toMatchObject({ data: { runtimeCredentialRestored: false, runtimeCredentialRevoked: true } });
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await bindings.load("opencode", "default")).toBeNull();
    expect(active.size).toBe(0);
    expect(revokeRuntimeCredential.mock.calls.map((call) => call[1])).toEqual(["rtc_1", "rtc_2", "rtc_3"]);
  });

  it("restores the transaction the backups name even when the stored binding disagrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-binding-drift-"));
    const configPath = join(root, "opencode.jsonc");
    const original = "{\n  \"theme\": \"dark\"\n}\n";
    await writeFile(configPath, original, "utf8");
    const credentials = memoryCredentials();
    const bindings = new RuntimeBindingStore(credentials);
    const revoke = vi.fn(async () => undefined);
    const capture = captureIo();
    const common = {
      io: capture.io,
      hubService: mockHub({ revokeRuntimeCredential: revoke }),
      credentialStore: credentials,
      registry: registryWith({ detect: async () => ({ ...installed, configPath }) }),
      platform: "win32" as const,
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      cwd: root,
      createRequestId: () => "local_binding_drift",
    };
    const connected = await runCli(["connect", "opencode", "--deployment", "deployment.nova", "--yes", "--json"], common);
    expect(connected.exitCode).toBe(EXIT_CODES.success);
    const transactionId = JSON.parse(capture.stdout()).data.transactionId as string;

    // What an older build left behind: it wrote the configuration without
    // updating the binding. While the binding decided the ordering, this state
    // refused both directions and the CLI had no way out of it.
    const stored = await bindings.load("opencode", "default");
    await bindings.save("opencode", "default", {
      ...stored!,
      transactionId: "transaction-1757000000000-2b1de0f4-2f5c-4a0e-9d0f-1f9a0b6c7d8e",
      restoreTarget: { protocol: "openai-responses", deploymentId: "deployment.nova" },
    });

    const restoreCapture = captureIo();
    const restored = await runCli(["restore", transactionId, "--yes", "--json"], { ...common, io: restoreCapture.io });
    expect(restored.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(restoreCapture.stdout());
    // The chain is dropped rather than reissued from a binding that does not
    // describe the restored files, so the profile disconnects with a warning.
    expect(output.data).toMatchObject({ restored: true, runtimeCredentialRestored: false, runtimeCredentialRevoked: true });
    expect(output.warnings.join(" ")).toContain("does not belong to");
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await bindings.load("opencode", "default")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("default", "rtc_1", expect.any(AbortSignal));
  });

  it("renews a runtime credential before launch and revokes the previous credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-renew-"));
    const credentials = memoryCredentials();
    const bindings = new RuntimeBindingStore(credentials);
    await bindings.save("opencode", "default", {
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
      registry: registryWith({ detect: async () => installed }),
      hubService: mockHub({
        createRuntimeCredential: issue,
        runtimeCredentials: async () => [{ credentialId: "rtc_new", name: "OpenCode", prefix: "anrt_new...test", deviceId: "device_1", protocols: ["openai-responses"], publicDeploymentIds: ["deployment.nova"], expiresAt: "2026-09-06T10:00:00Z", createdAt: "2026-09-05T10:00:00Z" }],
        revokeRuntimeCredential: revoke,
      }),
      launchAgent: async ({ args: _args, environment: environment }) => { launchedSecret = environment.APEXNOVA_API_KEY; return 0; },
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
    expect((await bindings.load("opencode", "default"))?.credentialId).toBe("rtc_new");
    expect(capture.stdout()).not.toContain("new-runtime-secret");
  });

  it("keeps the previous binding when a renewed credential cannot be verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-renew-fail-"));
    const credentials = memoryCredentials();
    const bindings = new RuntimeBindingStore(credentials);
    await bindings.save("opencode", "default", {
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
      registry: registryWith({ detect: async () => installed }),
      hubService: mockHub({
        createRuntimeCredential: async () => ({ credentialId: "rtc_new", expiresAt: "2026-09-06T10:00:00Z", deviceId: "device_1", secret: SecretValue.from("new-runtime-secret") }),
        runtimeCredentials: async () => [],
        revokeRuntimeCredential: revoke,
      }),
      launchAgent: launch,
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      now: () => new Date("2026-09-05T10:00:00Z"),
      createRequestId: () => "local_renew_fail",
    });

    expect(result.exitCode).toBe(EXIT_CODES.verification);
    expect(JSON.parse(capture.stdout())).toMatchObject({ error: { code: "VERIFICATION_FAILED" } });
    expect(revoke).toHaveBeenCalledWith("default", "rtc_new", expect.any(AbortSignal));
    expect((await bindings.load("opencode", "default"))?.credentialId).toBe("rtc_old");
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
      registry: registryWith({
        detect: async () => {
          const { productVersion: _productVersion, ...configOnly } = installed;
          return { ...configOnly, status: "config-only" };
        },
      }),
      launchAgent: launch,
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
      registry: registryWith({ detect: async () => installed, inspect: async () => ({ agentId: "opencode", configPath: installed.configPath, status: "configured", managed: true, connection: { providerId: "apexnova", protocol: "openai-responses", environmentVariables: ["APEXNOVA_API_KEY"], modelIds: ["nova"] }, warnings: [] }) }),
      createRequestId: () => "local_verify",
    });
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(capture.stdout())).toMatchObject({ data: { valid: true, level: "configuration" } });
  });

  it("shows a non-binding estimate and requires approval before live verification", async () => {
    const capture = captureIo();
    const credentials = memoryCredentials();
    await new RuntimeBindingStore(credentials).save("opencode", "default", {
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
      registry: registryWith({ detect: async () => installed, inspect: async () => ({ agentId: "opencode", configPath: installed.configPath, status: "configured", managed: true, connection: { providerId: "apexnova", protocol: "openai-responses", environmentVariables: ["APEXNOVA_API_KEY"], modelIds: ["nova"] }, warnings: [] }) }),
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
    await new RuntimeBindingStore(credentials).save("opencode", "default", {
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
      registry: registryWith({ detect: async () => installed, inspect: async () => ({ agentId: "opencode", configPath: installed.configPath, status: "configured", managed: true, connection: { providerId: "apexnova", protocol: "openai-responses", environmentVariables: ["APEXNOVA_API_KEY"], modelIds: ["nova"] }, warnings: [] }) }),
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
    await new RuntimeBindingStore(credentials).save("opencode", "default", {
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
      registry: registryWith({ detect: async () => installed, inspect: async () => ({ agentId: "opencode", configPath: installed.configPath, status: "configured", managed: true, connection: { providerId: "apexnova", protocol: "openai-responses", environmentVariables: ["APEXNOVA_API_KEY"], modelIds: ["nova"] }, warnings: [] }) }),
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

    const loaded = await bindings.load("opencode", "legacy");
    expect(loaded).toMatchObject({ credentialId: "rtc_legacy", protocol: "openai-responses", deploymentId: "deployment.nova" });
    expect(loaded?.restoreTarget).toBeUndefined();
    await bindings.save("opencode", "legacy", loaded!);

    expect(JSON.parse((await credentials.get(key))!.reveal())).toMatchObject({ version: 3, credentialId: "rtc_legacy", kind: "runtime" });
  });

  it("does not fall back to an implicit production Hub", async () => {
    const home = await mkdtemp(join(tmpdir(), "apexnova-nohub-"));
    const capture = captureIo();
    const result = await runCli(["balance", "--json"], {
      io: capture.io,
      environment: {},
      platform: "win32",
      homeDirectory: home,
      createRequestId: () => "local_no_hub",
    });
    expect(result.exitCode).toBe(EXIT_CODES.usage);
    expect(JSON.parse(capture.stdout())).toMatchObject({ error: { code: "HUB_NOT_CONFIGURED" } });
  });

  it("init stores a Hub endpoint that later commands resolve from the config file", async () => {
    const home = await mkdtemp(join(tmpdir(), "apexnova-init-"));
    const context = { environment: {}, platform: "linux" as const, homeDirectory: home };

    const initCapture = captureIo();
    const init = await runCli(
      ["init", "--hub-url", "https://hub.example.test", "--client-id", "apexnova-connect", "--json"],
      { ...context, io: initCapture.io, createRequestId: () => "local_init" },
    );
    expect(init.exitCode).toBe(EXIT_CODES.success);

    const configPath = join(home, ".config", "apexnova-connect", "config.json");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      version: 1,
      hubBaseUrl: "https://hub.example.test",
      oauthClientId: "apexnova-connect",
    });

    const doctorCapture = captureIo();
    const doctor = await runCli(["doctor", "--json"], {
      ...context,
      io: doctorCapture.io,
      hubService: mockHub(),
      credentialStore: memoryCredentials(),
      registry: registryWith({ detect: async () => installed }),
      createRequestId: () => "local_doctor",
    });
    expect(doctor.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(doctorCapture.stdout()).data.checks).toContainEqual(
      expect.objectContaining({
        id: "hub-endpoint",
        status: "pass",
        message: "https://hub.example.test (config-file)",
      }),
    );
  });

  it("init refuses to clobber an existing config without --force", async () => {
    const home = await mkdtemp(join(tmpdir(), "apexnova-init-force-"));
    const context = { environment: {}, platform: "linux" as const, homeDirectory: home };
    const args = ["init", "--hub-url", "https://hub.example.test", "--client-id", "apexnova-connect", "--json"];

    const first = await runCli(args, { ...context, io: captureIo().io, createRequestId: () => "local_a" });
    expect(first.exitCode).toBe(EXIT_CODES.success);

    const capture = captureIo();
    const second = await runCli(["init", "--json", "--non-interactive"], {
      ...context,
      io: capture.io,
      createRequestId: () => "local_b",
    });
    expect(second.exitCode).toBe(EXIT_CODES.conflict);
    expect(JSON.parse(capture.stdout())).toMatchObject({ error: { code: "CONFIG_EXISTS" } });
  });

  it("keeps environment variables ahead of the stored config file", async () => {
    const home = await mkdtemp(join(tmpdir(), "apexnova-precedence-"));
    await runCli(["init", "--hub-url", "https://stored.example.test", "--client-id", "stored", "--json"], {
      io: captureIo().io,
      environment: {},
      platform: "linux",
      homeDirectory: home,
      createRequestId: () => "local_store",
    });

    const capture = captureIo();
    await runCli(["doctor", "--json"], {
      io: capture.io,
      environment: {
        APEXNOVA_HUB_BASE_URL: "https://env.example.test",
        APEXNOVA_OAUTH_CLIENT_ID: "from-env",
      },
      platform: "linux",
      homeDirectory: home,
      hubService: mockHub(),
      credentialStore: memoryCredentials(),
      registry: registryWith({ detect: async () => installed }),
      createRequestId: () => "local_env",
    });
    expect(JSON.parse(capture.stdout()).data.checks).toContainEqual(
      expect.objectContaining({
        id: "hub-endpoint",
        status: "pass",
        message: "https://env.example.test (environment)",
      }),
    );
  });

  it("refuses an oversized OpenCode config on both the connect and opencode paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "apexnova-bigconfig-"));
    const configPath = join(dir, "opencode.jsonc");
    await writeFile(configPath, `{"$schema":"https://opencode.ai/config.json","x":"${"a".repeat(2 * 1024 * 1024)}"}`, "utf8");
    const detection: DetectionResult = { ...installed, configPath, configExists: true };

    const shared = {
      environment: {},
      platform: "linux" as const,
      homeDirectory: dir,
      hubService: mockHub(),
      credentialStore: memoryCredentials(),
      registry: registryWith({ detect: async () => detection }),
      launchAgent: async () => 0,
    };

    const connectCapture = captureIo();
    const connect = await runCli(
      ["connect", "opencode", "--deployment", "deployment.nova", "--dry-run", "--json"],
      { ...shared, io: connectCapture.io, createRequestId: () => "local_big_connect" },
    );
    expect(connect.exitCode).toBe(EXIT_CODES.conflict);
    expect(JSON.parse(connectCapture.stdout())).toMatchObject({ error: { code: "CONFIG_TOO_LARGE" } });

    // The one-command path used to skip this guard entirely.
    const openCodeCapture = captureIo();
    const openCode = await runCli(
      ["opencode", "--deployment", "deployment.nova", "--json"],
      { ...shared, io: openCodeCapture.io, createRequestId: () => "local_big_opencode" },
    );
    expect(openCode.exitCode).toBe(EXIT_CODES.conflict);
    expect(JSON.parse(openCodeCapture.stdout())).toMatchObject({ error: { code: "CONFIG_TOO_LARGE" } });
  });

  it("refuses to guess a deployment on a non-interactive first run", async () => {
    const capture = captureIo();
    const result = await runCli(["opencode", "--json"], {
      io: capture.io,
      environment: {},
      platform: "linux",
      homeDirectory: "/nonexistent-apexnova-home",
      hubService: mockHub(),
      credentialStore: memoryCredentials(),
      registry: registryWith({ detect: async () => installed }),
      launchAgent: async () => 0,
      createRequestId: () => "local_pick",
    });
    expect(result.exitCode).toBe(EXIT_CODES.usage);
    expect(JSON.parse(capture.stdout())).toMatchObject({ error: { code: "DEPLOYMENT_REQUIRED" } });
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
  const evidenceSubject: EvidenceSubject = {
    agentId: "opencode",
    agentVersion: "1.18.29",
    integrationId: "opencode",
    integrationVersion: "0.1.0",
    deploymentId: "deployment.nova",
    protocol: "openai-responses",
    platform: `windows-${process.arch}`,
  };

  async function withEvidence(
    overrides: Readonly<Record<string, CapabilitySupport>> = {},
    subject: EvidenceSubject = evidenceSubject,
  ) {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-compat-"));
    const store = new FileEvidenceStore({ root: join(root, "Apexnova", "connect", "evidence") });
    const record = await store.append(
      createEvidence({
        sourceType: "maintainer-test",
        subject,
        observedAt: "2026-09-08T10:00:00.000Z",
        outcomes: CAPABILITY_DEFINITIONS.map((definition) => ({
          capabilityId: definition.id,
          support: overrides[definition.id] ?? "supported",
        })),
      }),
    );
    return { root, store, record: record.evidence };
  }

  /** No hubService is injected on purpose: explain must answer offline. */
  function explainDependencies(root: string, now: string, detection: DetectionResult = installed) {
    return {
      registry: registryWith({ detect: async () => detection }),
      platform: "win32" as const,
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      cwd: root,
      now: () => new Date(now),
      createRequestId: () => "local_compat",
    };
  }

  it("explains what the stored evidence adds up to without calling the Hub", async () => {
    const { root, record } = await withEvidence();
    const capture = captureIo();

    const result = await runCli(["compatibility", "explain", "opencode", "--json"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z"),
      io: capture.io,
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data.agents).toHaveLength(1);
    const explained = output.data.agents[0];
    expect(explained).toMatchObject({ agentId: "opencode", installedVersion: "1.18.29" });
    expect(explained.subjects[0]).toMatchObject({
      verdict: "compatible",
      appliesToInstalled: true,
      collectedOnThisPlatform: true,
      subject: { deploymentId: "deployment.nova", protocol: "openai-responses" },
    });
    expect(explained.subjects[0].capabilities).toHaveLength(CAPABILITY_DEFINITIONS.length);
    expect(explained.subjects[0].capabilities[0].evidenceId).toBe(record.id);
    expect(output.warnings).toEqual([]);
  });

  it("reads incompatible when a required capability failed, and names it", async () => {
    const { root } = await withEvidence({ "agent.single-tool-call": "unsupported" });
    const capture = captureIo();

    const result = await runCli(["compatibility", "explain", "opencode"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z"),
      io: capture.io,
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(capture.stdout()).toContain("openai-responses");
    expect(capture.stdout()).toContain("incompatible");
    expect(capture.stdout()).toContain("agent.single-tool-call");
  });

  it("falls back to unknown once the short-lived evidence expires", async () => {
    const { root } = await withEvidence();
    const capture = captureIo();

    // 42 days on: the 30-day streaming and tool-call statements have expired.
    await runCli(["compatibility", "explain", "opencode", "--json"], {
      ...explainDependencies(root, "2026-10-20T10:00:00.000Z"),
      io: capture.io,
    });

    const subject = JSON.parse(capture.stdout()).data.agents[0].subjects[0];
    expect(subject.verdict).toBe("unknown");
    expect(
      subject.capabilities.find((item: { capabilityId: string }) => item.capabilityId === "protocol.streaming-order"),
    ).toMatchObject({ support: "unknown", stale: true });
    expect(
      subject.capabilities.find((item: { capabilityId: string }) => item.capabilityId === "auth.endpoint-reachable"),
    ).toMatchObject({ support: "supported", stale: false });
  });

  it("says the evidence does not apply when a different version is installed", async () => {
    const { root } = await withEvidence();
    const capture = captureIo();

    const result = await runCli(["compatibility", "explain", "opencode", "--json"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z", {
        ...installed,
        productVersion: "1.19.0",
      }),
      io: capture.io,
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data.agents[0].subjects[0].appliesToInstalled).toBe(false);
    expect(output.warnings.join(" ")).toContain("covers 1.18.29, but 1.19.0 is installed");
  });

  it("filters by deployment and answers plainly when nothing was collected", async () => {
    const { root, store } = await withEvidence();
    await store.append(
      createEvidence({
        sourceType: "maintainer-test",
        subject: { ...evidenceSubject, deploymentId: "deployment.other" },
        observedAt: "2026-09-08T10:00:00.000Z",
        outcomes: [{ capabilityId: "auth.endpoint-reachable", support: "supported" }],
      }),
    );
    const capture = captureIo();

    await runCli(["compatibility", "explain", "opencode", "--deployment", "deployment.other", "--json"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z"),
      io: capture.io,
    });
    const filtered = JSON.parse(capture.stdout()).data.agents[0].subjects;
    expect(filtered).toHaveLength(1);
    expect(filtered[0].subject.deploymentId).toBe("deployment.other");

    const emptyCapture = captureIo();
    const empty = await mkdtemp(join(tmpdir(), "apexnova-cli-compat-empty-"));
    const result = await runCli(["compatibility", "explain", "opencode"], {
      ...explainDependencies(empty, "2026-09-20T10:00:00.000Z"),
      io: emptyCapture.io,
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(emptyCapture.stdout()).toContain("no compatibility evidence has been collected");
  });

  it("renders the published matrix from the stored evidence", async () => {
    const { root, record } = await withEvidence({ "agent.structured-output": "unsupported" });
    const capture = captureIo();

    const result = await runCli(["compatibility", "matrix"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z"),
      io: capture.io,
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const rendered = capture.stdout();
    expect(rendered).toContain("# Compatibility Matrix");
    expect(rendered).toContain("apexnova.capability-suite");
    expect(rendered).toContain("deployment.nova");
    // A published verdict has to name the record it rests on.
    expect(rendered).toContain(record.id);
    expect(rendered).toContain("`partial`");

    const emptyCapture = captureIo();
    const empty = await mkdtemp(join(tmpdir(), "apexnova-cli-matrix-empty-"));
    const emptyResult = await runCli(["compatibility", "matrix", "--json"], {
      ...explainDependencies(empty, "2026-09-20T10:00:00.000Z"),
      io: emptyCapture.io,
    });

    expect(emptyResult.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(emptyCapture.stdout());
    expect(output.data.rows).toEqual([]);
    expect(output.warnings).toContain("No evidence has been collected yet.");
  });

  it("replays a recording without storing evidence, and says so", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-replay-"));
    const recordingPath = join(root, "run.recording.json");
    await writeFile(
      recordingPath,
      JSON.stringify({
        version: 1,
        recordedAt: "2026-09-08T10:00:00.000Z",
        suite: { id: "apexnova.capability-suite", version: "0.1.0" },
        endpoint: "https://api.example.test/v1/responses",
        protocol: "openai-responses",
        model: "nova",
        deploymentId: "deployment.nova",
        interactions: [],
      }),
      "utf8",
    );
    const capture = captureIo();

    const result = await runCli(["compatibility", "replay", recordingPath, "--json"], {
      ...runDependencies(root),
      io: capture.io,
      runCapabilitySuite: async () => suiteResult({ "agent.structured-output": "unsupported" }),
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data).toMatchObject({ replayed: true, deploymentId: "deployment.nova" });
    expect(output.warnings[0]).toContain("A replay is not evidence");
    // The recording came from an older suite, which the reader has to be told.
    expect(output.warnings.join(" ")).toContain("recording came from suite 0.1.0");

    // A replay is a check of the suite, not a measurement, so nothing is stored.
    const store = new FileEvidenceStore({ root: join(root, "Apexnova", "connect", "evidence") });
    expect(await store.list()).toEqual([]);

    const badCapture = captureIo();
    const refused = await runCli(["compatibility", "replay", join(root, "missing.json"), "--json"], {
      ...runDependencies(root),
      io: badCapture.io,
    });
    expect(refused.exitCode).toBe(EXIT_CODES.usage);
    expect(JSON.parse(badCapture.stdout()).error.code).toBe("RECORDING_NOT_READABLE");
  });

  it("plans a refresh of what has expired and sends nothing until approved", async () => {
    // Collected on 2026-09-08; 42 days later the 30-day statements have gone.
    const { root } = await withEvidence();
    const suite = vi.fn(async () => suiteResult());
    const capture = captureIo();

    const result = await runCli(["compatibility", "refresh", "--json"], {
      ...runDependencies(root, { now: () => new Date("2026-10-20T10:00:00.000Z") }),
      io: capture.io,
      hubService: mockHub(),
      runCapabilitySuite: suite,
    });

    expect(result.exitCode).toBe(EXIT_CODES.permission);
    const error = JSON.parse(capture.stdout()).error;
    expect(error.code).toBe("APPROVAL_REQUIRED");
    expect(error.details.due).toHaveLength(1);
    expect(error.details.due[0]).toMatchObject({ expired: true, estimate: "0.000060" });
    expect(error.details.estimatedTotal).toBe("0.000060");
    expect(suite).not.toHaveBeenCalled();
  });

  it("says nothing is due when the evidence is still fresh", async () => {
    const { root } = await withEvidence();
    const capture = captureIo();

    const result = await runCli(["compatibility", "refresh"], {
      ...runDependencies(root, { now: () => new Date("2026-09-20T10:00:00.000Z") }),
      io: capture.io,
      hubService: mockHub(),
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(capture.stdout()).toContain("No evidence expires within 7 days.");
  });

  it("re-collects a subject whose deployment changed implementation, expiry or not", async () => {
    const { root } = await withEvidence({}, {
      ...evidenceSubject,
      implementationFingerprint: "impl-a1b2c3d4e5f6",
    });
    const capture = captureIo();

    const result = await runCli(["compatibility", "refresh", "--json"], {
      // Twelve days on: nothing has expired, and nothing is due within 7 days.
      ...runDependencies(root, { now: () => new Date("2026-09-20T10:00:00.000Z") }),
      io: capture.io,
      hubService: mockHub({
        catalog: async () => {
          const base = await mockHub().catalog("default", new AbortController().signal);
          return {
            ...base,
            deployments: base.deployments.map((deployment) => ({
              ...deployment,
              implementationFingerprint: "impl-999999999999",
              implementationChangedAt: "2026-09-15T10:00:00.000Z",
            })),
          };
        },
      }),
      runCapabilitySuite: async () => suiteResult(),
    });

    expect(result.exitCode).toBe(EXIT_CODES.permission);
    const error = JSON.parse(capture.stdout()).error;
    expect(error.code).toBe("APPROVAL_REQUIRED");
    expect(error.details.due).toHaveLength(1);
    expect(error.details.due[0]).toMatchObject({ expired: false });
    expect(error.details.due[0].implementationChanged).toContain("impl-a1b2c3d4e5f6".slice(0, 12));
    expect(error.message).toContain("the implementation changed from");
  });

  it("re-collects the due subjects and reports what each one now says", async () => {
    const { root } = await withEvidence();
    const revoke = vi.fn(async () => undefined);
    const capture = captureIo();

    const result = await runCli(["compatibility", "refresh", "--yes", "--json"], {
      ...runDependencies(root, { now: () => new Date("2026-10-20T10:00:00.000Z") }),
      io: capture.io,
      hubService: mockHub({ revokeRuntimeCredential: revoke }),
      runCapabilitySuite: async () => suiteResult({ "protocol.cancellation": "partial" }),
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data.refreshed).toHaveLength(1);
    expect(output.data.refreshed[0]).toMatchObject({ verdict: "partial" });
    expect(revoke).toHaveBeenCalledTimes(1);

    // The fresh record joins the old one; nothing is overwritten.
    const store = new FileEvidenceStore({ root: join(root, "Apexnova", "connect", "evidence") });
    expect(await store.list()).toHaveLength(2);
  });

  it("skips a subject it cannot re-collect instead of dropping it from the list", async () => {
    const { root } = await withEvidence();
    const capture = captureIo();

    const result = await runCli(["compatibility", "refresh", "--yes", "--json"], {
      ...runDependencies(root, { now: () => new Date("2026-10-20T10:00:00.000Z") }),
      io: capture.io,
      // The deployment the evidence was collected against is gone.
      hubService: mockHub({
        catalog: async () => {
          const base = await mockHub().catalog("default", new AbortController().signal);
          return { ...base, deployments: [] };
        },
      }),
      runCapabilitySuite: async () => suiteResult(),
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data.refreshed).toEqual([]);
    expect(output.data.due[0].skipped).toContain("no longer in the visible catalog");
    expect(output.warnings.join(" ")).toContain("every due subject was skipped");
  });

  it("rejects a subcommand it does not have", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-compat-usage-"));
    const capture = captureIo();

    const result = await runCli(["compatibility", "list", "--json"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z"),
      io: capture.io,
    });

    expect(result.exitCode).toBe(EXIT_CODES.usage);
    expect(JSON.parse(capture.stdout()).error.code).toBe("INVALID_ARGUMENT");
  });

  function suiteResult(overrides: Readonly<Record<string, CapabilitySupport>> = {}): CapabilitySuiteResult {
    return {
      suite: { id: CAPABILITY_SUITE_ID, version: CAPABILITY_SUITE_VERSION },
      outcomes: CAPABILITY_DEFINITIONS.map((definition) => ({
        capabilityId: definition.id,
        support: overrides[definition.id] ?? "supported",
        detail: "probe answered as expected",
        requestIds: ["req_capability_1"],
      })),
      requestIds: ["req_capability_1", "req_capability_2"],
      billableRequests: 5,
    };
  }

  function runDependencies(root: string, overrides: Record<string, unknown> = {}) {
    return {
      registry: registryWith({ detect: async () => installed }),
      platform: "win32" as const,
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      cwd: root,
      now: () => new Date("2026-09-08T10:00:00.000Z"),
      createRequestId: () => "local_compat_run",
      // Reconciliation waits for Hub to settle; no test should wait with it.
      sleep: async () => undefined,
      ...overrides,
    };
  }

  it("shows the estimate and sends nothing until the run is approved", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-run-approval-"));
    const suite = vi.fn(async () => suiteResult());
    const createRuntimeCredential = vi.fn(mockHub().createRuntimeCredential);
    const capture = captureIo();

    const result = await runCli(
      ["compatibility", "run", "opencode", "--deployment", "deployment.nova", "--json"],
      { ...runDependencies(root), io: capture.io, hubService: mockHub({ createRuntimeCredential }), runCapabilitySuite: suite },
    );

    expect(result.exitCode).toBe(EXIT_CODES.permission);
    const output = JSON.parse(capture.stdout());
    expect(output.error.code).toBe("APPROVAL_REQUIRED");
    expect(output.error.details.estimate.amount).toBe("0.000060");
    expect(output.error.details.capabilities).toHaveLength(CAPABILITY_DEFINITIONS.length);
    expect(suite).not.toHaveBeenCalled();
    expect(createRuntimeCredential).not.toHaveBeenCalled();
  });

  it("refuses a run whose estimate is over the local ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-run-budget-"));
    const suite = vi.fn(async () => suiteResult());
    const expensive = mockHub({
      estimatePricing: async () => ({
        deploymentId: "deployment.nova", model: "nova", currency: "USD", billingMode: "token",
        listAmount: "0.900000", discountRate: "0", amount: "0.900000",
        priceVersion: "2026-09-05T10:00:00Z", estimateOnly: true,
      }),
    });
    const capture = captureIo();

    const refused = await runCli(
      ["compatibility", "run", "opencode", "--deployment", "deployment.nova", "--yes", "--json"],
      { ...runDependencies(root), io: capture.io, hubService: expensive, runCapabilitySuite: suite },
    );

    expect(refused.exitCode).toBe(EXIT_CODES.billing);
    expect(JSON.parse(capture.stdout()).error.code).toBe("BUDGET_EXCEEDED");
    expect(suite).not.toHaveBeenCalled();

    // The ceiling is a guard, not a wall: raising it deliberately lets the run through.
    const raisedCapture = captureIo();
    const raised = await runCli(
      ["compatibility", "run", "opencode", "--deployment", "deployment.nova", "--budget", "1", "--yes", "--json"],
      { ...runDependencies(root), io: raisedCapture.io, hubService: expensive, runCapabilitySuite: suite },
    );

    expect(raised.exitCode).toBe(EXIT_CODES.success);
    expect(suite).toHaveBeenCalledTimes(1);
  });

  it("runs the suite on a scoped credential, revokes it, reconciles the cost and stores the evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-run-"));
    const suite = vi.fn(async () => suiteResult({ "protocol.cancellation": "partial" }));
    const revoke = vi.fn(async () => undefined);
    const createRuntimeCredential = vi.fn(mockHub().createRuntimeCredential);
    const usage: HubCommandService["usage"] = async (_profile, requestId) => ({
      id: `usage_${requestId}`,
      requestId,
      at: "2026-09-08T10:00:00.000Z",
      status: "success",
      resolvedModel: "nova",
      resolvedDeploymentId: "deployment.nova",
      source: "capability-suite",
      usage: { inputTokens: 17, outputTokens: 70 },
      currency: "USD",
      amount: "0.000100",
    });
    const capture = captureIo();

    const result = await runCli(
      ["compatibility", "run", "opencode", "--deployment", "deployment.nova", "--yes", "--json"],
      {
        ...runDependencies(root),
        io: capture.io,
        hubService: mockHub({ createRuntimeCredential, revokeRuntimeCredential: revoke, usage }),
        runCapabilitySuite: suite,
      },
    );

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data).toMatchObject({
      verdict: "partial",
      billed: { amount: "0.000200", currency: "USD" },
      requestIds: ["req_capability_1", "req_capability_2"],
      subject: { agentVersion: "1.18.29", deploymentId: "deployment.nova", protocol: "openai-responses" },
    });

    // The credential exists only for the run.
    expect(createRuntimeCredential).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("default", "rtc_1", expect.any(AbortSignal));

    // And the finding is on disk, which is what explain reads next.
    const store = new FileEvidenceStore({ root: join(root, "Apexnova", "connect", "evidence") });
    const stored = await store.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(output.data.evidenceId);
    expect(stored[0]?.result.summary).toContain("billed 0.000200 USD");
    expect(stored[0]?.result.capabilities?.find((item) => item.capabilityId === "protocol.cancellation"))
      .toMatchObject({ support: "partial", value: "probe answered as expected" });
  });

  it("reports what Hub has not settled instead of reporting it as free", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-run-unsettled-"));
    const sleep = vi.fn(async () => undefined);
    const capture = captureIo();

    const result = await runCli(
      ["compatibility", "run", "opencode", "--deployment", "deployment.nova", "--yes", "--json"],
      {
        ...runDependencies(root),
        io: capture.io,
        // The Hub answers before it settles, which is what a run sees in practice.
        hubService: mockHub({ usage: async () => undefined }),
        runCapabilitySuite: async () => suiteResult(),
        sleep,
      },
    );

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data.billed).toMatchObject({ amount: "0.000000", settledRequests: 0, attributedRequests: 2 });
    expect(output.warnings.join(" ")).toContain("has not settled 2 of 2 requests");
    expect(sleep).toHaveBeenCalled();

    const store = new FileEvidenceStore({ root: join(root, "Apexnova", "connect", "evidence") });
    const stored = await store.list();
    expect(stored[0]?.result.summary).toContain("over 0 settled of 2 attributed requests");
  });

  it("tells apart what is unsettled, what is not billable and what never reached the ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-run-settlement-"));
    const capture = captureIo();
    const usage: HubCommandService["usage"] = async (_profile, requestId) => {
      const base = {
        id: `usage_${requestId}`,
        requestId,
        at: "2026-09-08T10:00:00.000Z",
        status: "success" as const,
        resolvedModel: "nova",
        source: "capability-suite",
        usage: { inputTokens: 17, outputTokens: 70 },
        currency: "USD",
      };
      if (requestId === "req_capability_1") return { ...base, settlementStatus: "settled" as const, amount: "0.000100" };
      // Billed nothing on purpose is not the same as not billed yet, and the
      // run has to stop conflating them.
      return { ...base, settlementStatus: "not-billable" as const };
    };

    const result = await runCli(
      ["compatibility", "run", "opencode", "--deployment", "deployment.nova", "--yes", "--json"],
      {
        ...runDependencies(root),
        io: capture.io,
        hubService: mockHub({ usage }),
        runCapabilitySuite: async () => ({
          ...suiteResult(),
          // The third failed at the edge: the ID is not a ledger key.
          requestIds: ["req_capability_1", "req_capability_2", "edge_7f3a"],
        }),
      },
    );

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data.billed).toMatchObject({
      amount: "0.000100",
      settledRequests: 1,
      notBillableRequests: 1,
      edgeRequests: 1,
    });
    expect(output.data.unsettledRequestIds).toBeUndefined();
    expect(output.data.edgeRequestIds).toEqual(["edge_7f3a"]);
    expect(output.warnings.join(" ")).toContain("failed at the edge");
    expect(output.warnings.join(" ")).not.toContain("has not settled");
  });

  it("revokes the run credential even when the suite itself fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-run-failure-"));
    const revoke = vi.fn(async () => undefined);
    const capture = captureIo();

    const result = await runCli(
      ["compatibility", "run", "opencode", "--deployment", "deployment.nova", "--yes", "--json"],
      {
        ...runDependencies(root),
        io: capture.io,
        hubService: mockHub({ revokeRuntimeCredential: revoke }),
        runCapabilitySuite: async () => { throw new Error("endpoint unreachable"); },
      },
    );

    expect(result.exitCode).not.toBe(EXIT_CODES.success);
    expect(revoke).toHaveBeenCalledWith("default", "rtc_1", expect.any(AbortSignal));
    const store = new FileEvidenceStore({ root: join(root, "Apexnova", "connect", "evidence") });
    expect(await store.list()).toEqual([]);
  });
});
