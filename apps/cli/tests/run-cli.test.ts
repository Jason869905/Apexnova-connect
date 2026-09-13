import { describe, expect, it, vi } from "vitest";
import { SecretValue } from "@apexnova-connect/credential-store";
import type { CredentialStore } from "@apexnova-connect/credential-store";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { EXIT_CODES, RuntimeBindingStore, runCli, type CliIo, type HubCommandService } from "../src/index.js";
import { HubClientError } from "@apexnova-connect/hub-client";
import { createIntegrationRegistry } from "@apexnova-connect/core";
import { RoutingAuditLog, createRoutingAuditEntry, routingAuditPath } from "@apexnova-connect/routing";
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
import { validateRecommendation } from "@apexnova-connect/recommendation";
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
      deployments: [{ id: "deployment.nova", providerId: "provider.apexnova-ai-hub", modelId: "model.nova", displayName: "Nova Coder", inferenceAlias: "nova", aliases: ["nova"], protocols: [{ protocol: "openai-responses", baseUrl: "https://api.example.test/v1/responses" }], limits: { contextWindow: 128000, maxOutputTokens: 8192 }, capabilities: ["tool.calling"], capabilityStatements: [{ capabilityId: "tool.calling", support: "supported" as const, sourceType: "provider-claim" as const }], availability: { status: "available", observedAt: "2026-09-04T12:00:00Z" } }],
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
    submitEvidence: async (_profile, evidence) => ({
      record: {
        id: String((evidence as { readonly id?: unknown }).id ?? "ev.unknown"),
        payload: evidence,
        received: { receivedAt: "2026-09-09T10:00:00.000Z", signatureStatus: "none" as const, submittedBy: "usr_00000000000000000000000001" },
        derived: { capabilityStatus: [], supportsCurrentVerdict: true, fingerprint: { match: "absent" as const } },
      },
      created: true,
    }),
    evidence: async () => ({ items: [] }),
    revokeEvidence: async (_profile, evidenceId, reason) => ({
      id: evidenceId,
      payload: {},
      received: { revokedAt: "2026-09-09T10:00:00.000Z", revokedReason: reason },
      derived: { capabilityStatus: [], supportsCurrentVerdict: false },
    }),
    registerTestSuite: async (_profile, input) => ({
      suite: {
        suiteId: input.suiteId,
        version: input.version,
        majorVersion: 0,
        capabilityDigest: input.capabilityDigest,
        ttlTable: input.ttlTable,
        registeredAt: "2026-09-09T10:00:00.000Z",
      },
      created: true,
    }),
    ...overrides,
  };
}

/**
 * A state root of its own. Commands write into `localStateRoot`, and a test that
 * leaves it unset writes into the developer's real one -- for the routing audit
 * that means a fabricated route in the one file that must hold only what
 * actually happened.
 */
async function isolatedState() {
  const root = await mkdtemp(join(tmpdir(), "apexnova-cli-state-"));
  return {
    platform: "win32" as const,
    environment: { LOCALAPPDATA: root },
    homeDirectory: root,
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

  it("names the scopes Hub did not grant instead of failing the login", async () => {
    const capture = captureIo();
    const login: HubCommandService["login"] = async (_profile, prompt) => {
      await prompt({ userCode: "ABCD-EFGH", verificationUri: "https://hub.example.test/device", expiresAt: "2026-09-04T12:10:00Z" });
      return {
        accessToken: SecretValue.from("access-secret"),
        tokenType: "Bearer",
        // The collector scopes are granted per account, so an account without
        // them comes back with a narrower session rather than a refusal.
        requestedScope: "account:read catalog:read compatibility:read compatibility:write",
        scope: "account:read catalog:read compatibility:read",
        accountId: "account_1",
      };
    };

    const result = await runCli(["login", "--json"], { io: capture.io, hubService: mockHub({ login }), createRequestId: () => "local_login" });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data.ungrantedScopes).toEqual(["compatibility:write"]);
    expect(output.warnings.join(" ")).toContain("compatibility:write");
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
    // Isolated state and an in-memory credential store. Without them this read
    // the developer's own machine, and only passed while logout looked at
    // nothing: the guard below made it fail on a box that happened to have a
    // live binding. A test whose result depends on the developer's session is
    // not testing the command.
    await runCli(["logout", "--json"], {
      io: capture.io,
      hubService: mockHub(),
      credentialStore: memoryCredentials(),
      ...(await isolatedState()),
      createRequestId: () => "local_logout",
    });
    expect(JSON.parse(capture.stdout())).toMatchObject({ ok: true, data: { localSessionDeleted: true, serverRevoked: false } });
  });

  it("refuses to log out while a connection it could no longer undo is still in place", async () => {
    // A restore asks Hub to reissue the connection it rolls back to, so once
    // the session is gone the transaction can never be undone -- the Agent
    // keeps a configuration pointing at Hub and there is no account left to
    // manage it with. Walking the user into that and reporting success is the
    // shape ADR 0019 section 4 named.
    const credentials = memoryCredentials();
    await new RuntimeBindingStore(credentials).save("opencode", "default", {
      credentialId: "rtc_1",
      secret: SecretValue.from("runtime-secret"),
      expiresAt: "2099-09-05T12:00:00Z",
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
    });
    const state = await isolatedState();
    const logout = vi.fn(mockHub().logout);
    const capture = captureIo();

    const refused = await runCli(["logout"], {
      io: capture.io,
      hubService: mockHub({ logout }),
      credentialStore: credentials,
      ...state,
      createRequestId: () => "local_logout_guard",
    });

    expect(refused.exitCode).toBe(EXIT_CODES.permission);
    expect(capture.stderr()).toContain("OpenCode");
    expect(capture.stderr()).toContain("--yes");
    // Refused means refused: the session must still be there afterwards.
    expect(logout).not.toHaveBeenCalled();

    const approved = await runCli(["logout", "--yes"], {
      io: captureIo().io,
      hubService: mockHub({ logout }),
      credentialStore: credentials,
      ...state,
      createRequestId: () => "local_logout_forced",
    });

    expect(approved.exitCode).toBe(EXIT_CODES.success);
    expect(logout).toHaveBeenCalledTimes(1);
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

  describe("a switch that fails", () => {
    // The exit condition is that a failed switch does not damage the Agent
    // configuration. Until now only the success path had been exercised, so
    // each of the three places a switch can fail is injected here and the
    // profile is asserted back at where it started -- configuration, binding and
    // which credential Hub still has.
    async function connectedProfile(name: string) {
      const root = await mkdtemp(join(tmpdir(), `apexnova-cli-switch-${name}-`));
      const configPath = join(root, "opencode.jsonc");
      await writeFile(configPath, "{\n  \"theme\": \"dark\"\n}\n", "utf8");
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
      const active = new Set<string>();
      let sequence = 0;
      const createRuntimeCredential: HubCommandService["createRuntimeCredential"] = async () => {
        sequence += 1;
        const credentialId = `rtc_${sequence}`;
        active.add(credentialId);
        return { credentialId, expiresAt: "2099-09-05T12:00:00Z", deviceId: "device_1", secret: SecretValue.from(`runtime-secret-${sequence}`) };
      };
      const revokeRuntimeCredential = vi.fn(async (_profile: string, credentialId: string) => { active.delete(credentialId); });
      const hub = mockHub({
        catalog: async () => catalog,
        createRuntimeCredential,
        revokeRuntimeCredential,
        runtimeCredentials: async () => [...active].map((credentialId) => ({
          credentialId,
          name: "OpenCode",
          prefix: "anrt_test...test",
          deviceId: "device_1",
          protocols: ["openai-responses", "openai-chat"],
          publicDeploymentIds: ["deployment.nova"],
          expiresAt: "2099-09-05T12:00:00Z",
          createdAt: "2026-09-05T12:00:00Z",
        })),
      });
      const common = {
        hubService: hub,
        credentialStore: credentials,
        registry: registryWith({ detect: async () => ({ ...installed, configPath }) }),
        platform: "win32" as const,
        environment: { LOCALAPPDATA: root },
        homeDirectory: root,
        cwd: root,
        createRequestId: () => `local_switch_${name}`,
      };

      const connected = await runCli(
        ["connect", "opencode", "--deployment", "deployment.nova", "--protocol", "openai-responses", "--yes", "--json"],
        { ...common, io: captureIo().io },
      );
      expect(connected.exitCode).toBe(EXIT_CODES.success);

      return {
        common,
        configPath,
        bindings,
        active,
        revokeRuntimeCredential,
        configBefore: await readFile(configPath, "utf8"),
        bindingBefore: await bindings.load("opencode", "default"),
      };
    }

    it("leaves everything alone when the new credential cannot be issued", async () => {
      const profile = await connectedProfile("issue");
      const capture = captureIo();

      const result = await runCli(
        ["switch", "opencode", "--deployment", "deployment.nova", "--protocol", "openai-chat", "--yes"],
        {
          ...profile.common,
          io: capture.io,
          hubService: mockHub({
            ...profile.common.hubService,
            createRuntimeCredential: async () => { throw new Error("Hub refused to issue a credential"); },
          }),
        },
      );

      expect(result.exitCode).not.toBe(EXIT_CODES.success);
      // Nothing was written, so there is nothing to undo.
      expect(await readFile(profile.configPath, "utf8")).toBe(profile.configBefore);
      expect(await profile.bindings.load("opencode", "default")).toEqual(profile.bindingBefore);
      expect(profile.active.has("rtc_1")).toBe(true);
    });

    it("rolls the configuration back and revokes the new credential when verification fails", async () => {
      const profile = await connectedProfile("verify");
      const capture = captureIo();

      const result = await runCli(
        ["switch", "opencode", "--deployment", "deployment.nova", "--protocol", "openai-chat", "--yes"],
        {
          ...profile.common,
          io: capture.io,
          registry: registryWith({
            detect: async () => ({ ...installed, configPath: profile.configPath }),
            verify: async () => ({ valid: false as const, reason: "the written configuration did not read back" }),
          }),
        },
      );

      expect(result.exitCode).toBe(EXIT_CODES.verification);
      expect(await readFile(profile.configPath, "utf8")).toBe(profile.configBefore);
      // The credential minted for the switch must not outlive the switch, and
      // the one still in use must survive it.
      expect(profile.active.has("rtc_2")).toBe(false);
      expect(profile.active.has("rtc_1")).toBe(true);
      expect(await profile.bindings.load("opencode", "default")).toEqual(profile.bindingBefore);
    });

    it("stays on the previous credential when the new binding cannot be saved", async () => {
      const profile = await connectedProfile("binding");
      const capture = captureIo();
      const failingStore: CredentialStore = {
        ...profile.common.credentialStore,
        set: async (key, secret) => {
          if (key.kind === "runtime-credential") throw new Error("credential store is unavailable");
          return profile.common.credentialStore.set(key, secret);
        },
      };

      const result = await runCli(
        ["switch", "opencode", "--deployment", "deployment.nova", "--protocol", "openai-chat", "--yes"],
        { ...profile.common, io: capture.io, credentialStore: failingStore },
      );

      expect(result.exitCode).not.toBe(EXIT_CODES.success);
      // A configuration pointing at a credential nobody stored is worse than a
      // failed switch. The file goes back, the credential minted for the switch
      // is revoked, and the profile is left on the one it already had -- which
      // is what the rolled-back configuration points at.
      expect(await readFile(profile.configPath, "utf8")).toBe(profile.configBefore);
      expect(profile.active.has("rtc_2")).toBe(false);
      expect(profile.active.has("rtc_1")).toBe(true);
      expect(await profile.bindings.load("opencode", "default")).toEqual(profile.bindingBefore);
    });
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

    // The log has to tell the same story the transactions do. Without an entry
    // per restore it would show a switch to the second target and then, with
    // nothing in between, a profile pointing somewhere else entirely.
    const audit = await new RoutingAuditLog({
      path: routingAuditPath(join(root, "Apexnova", "connect")),
    }).list();
    expect(audit.map((entry) => `${entry.event}/${entry.command}/${entry.grounds ?? "-"}`)).toEqual([
      "selected/connect/explicit",
      "selected/switch/explicit",
      "selected/restore/restore",
      "released/restore/-",
    ]);
    // Undoing the switch puts the first target back; undoing the first connect
    // leaves none, and says so rather than recording a selection of nothing.
    expect(audit[2]).toMatchObject({ deploymentId: "deployment.nova", protocol: "openai-responses" });
    expect(audit[3]?.deploymentId).toBeUndefined();
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

  it("fails the launch when the Agent billed a credential this launcher did not issue", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-attrib-"));
    const credentials = memoryCredentials();
    await new RuntimeBindingStore(credentials).save("opencode", "default", {
      credentialId: "rtc_ours",
      secret: SecretValue.from("runtime-secret"),
      expiresAt: "2026-12-01T10:00:00Z",
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
    });
    // Before the launch the hour is empty; afterwards two requests exist, paid
    // for by a long-lived key nobody here issued. That is the 2026-09-11 failure
    // exactly: the Agent answered, every command reported success, and the
    // credential the launcher minted served nothing.
    let call = 0;
    const capture = captureIo();
    const result = await runCli(["run", "opencode", "--json"], {
      io: capture.io,
      credentialStore: credentials,
      registry: registryWith({ detect: async () => installed }),
      hubService: mockHub({
        usageQuery: async () => {
          call += 1;
          return call === 1
            ? { granularity: "hour" as const, items: [], asOf: "2026-09-11T15:00:00Z" }
            : {
                granularity: "hour" as const,
                items: [{
                  bucketStart: "2026-09-11T15:00:00Z",
                  apiKeyId: "key_theirs",
                  apiKeyName: "myopencode",
                  publicDeploymentId: "deployment.other",
                  resolvedModel: "glm-5.2",
                  requestCount: 2,
                  normalCost: "0.005693",
                  currency: "USD",
                }],
                asOf: "2026-09-11T15:05:00Z",
              };
        },
      }),
      launchAgent: async () => 0,
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      now: () => new Date("2026-09-11T15:01:00Z"),
      createRequestId: () => "local_attrib",
    });

    expect(result.exitCode).toBe(EXIT_CODES.verification);
    const error = JSON.parse(capture.stdout()).error;
    expect(error.code).toBe("LAUNCH_ATTRIBUTION_MISMATCH");
    expect(error.message).toContain("myopencode");
    expect(error.message).toContain("glm-5.2");
    expect(error.details.expectedCredentialId).toBe("rtc_ours");
  });

  it("reports the requests that did reach the credential it issued", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-attrib-ok-"));
    const credentials = memoryCredentials();
    await new RuntimeBindingStore(credentials).save("opencode", "default", {
      credentialId: "rtc_ours",
      secret: SecretValue.from("runtime-secret"),
      expiresAt: "2026-12-01T10:00:00Z",
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
    });
    let call = 0;
    const capture = captureIo();
    const result = await runCli(["run", "opencode"], {
      io: capture.io,
      credentialStore: credentials,
      registry: registryWith({ detect: async () => installed }),
      hubService: mockHub({
        usageQuery: async () => {
          call += 1;
          const requestCount = call === 1 ? 1 : 4;
          return {
            granularity: "hour" as const,
            items: [{
              bucketStart: "2026-09-11T15:00:00Z",
              apiKeyId: "rtc_ours",
              publicDeploymentId: "deployment.nova",
              requestCount,
              normalCost: "0.001",
              currency: "USD",
            }],
            asOf: "2026-09-11T15:05:00Z",
          };
        },
      }),
      launchAgent: async () => 0,
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      now: () => new Date("2026-09-11T15:01:00Z"),
      createRequestId: () => "local_attrib_ok",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    // Only the difference across the launch is attributed to it: the request
    // that was already in the bucket belongs to whatever ran earlier that hour.
    expect(capture.stdout()).toContain("3 requests billed to this launcher's credential");
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
      // An isolated state root: `verify --live` writes a routing audit entry,
      // and a test that leaves that unset writes a fabricated route into the
      // developer's own audit log -- which is the one file that must contain
      // only things that really happened.
      ...(await isolatedState()),
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
      ...(await isolatedState()),
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

  it("names the file each transaction wrote, because restoring it needs that path", async () => {
    // A transaction applied with `--config` can only be restored with the same
    // `--config`: the target has to fall inside the allowed roots. Observed for
    // real while clearing this machine -- a restore failed with
    // PATH_OUTSIDE_ALLOWED_ROOT and the only way to learn which path it wanted
    // was to open the receipt by hand. An id alone does not say.
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-restore-paths-"));
    const configPath = join(root, "elsewhere", "opencode.jsonc");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "{}\n", "utf8");
    const state = await isolatedState();
    const credentials = memoryCredentials();
    const deps = {
      credentialStore: credentials,
      registry: registryWith({ detect: async () => ({ ...installed, configPath }) }),
      hubService: mockHub(),
      ...state,
      cwd: root,
    };

    const connected = await runCli(
      ["connect", "opencode", "--config", configPath, "--deployment", "deployment.nova", "--yes"],
      { io: captureIo().io, ...deps, createRequestId: () => "local_paths_connect" },
    );
    expect(connected.exitCode).toBe(EXIT_CODES.success);

    const capture = captureIo();
    const listed = await runCli(["restore", "--list"], {
      io: capture.io, ...deps, createRequestId: () => "local_paths_list",
    });

    expect(listed.exitCode).toBe(EXIT_CODES.success);
    expect(capture.stdout()).toContain(configPath);
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

    const stored = JSON.parse((await credentials.get(key))!.reveal()) as Record<string, unknown>;
    expect(stored).toMatchObject({ version: 4, credentialId: "rtc_legacy", kind: "runtime" });
    // `issuedAt` is not invented for a binding that never carried one. Guessing
    // it would silently change the renewal window, which is derived from it --
    // a made-up issue time is a made-up lifetime.
    expect(stored.issuedAt).toBeUndefined();
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

  it("sends nothing to Hub until the submission list is approved", async () => {
    const { root, record } = await withEvidence();
    const submitEvidence = vi.fn(mockHub().submitEvidence);
    const capture = captureIo();

    const result = await runCli(["compatibility", "sync", "--json"], {
      ...runDependencies(root),
      io: capture.io,
      hubService: mockHub({ submitEvidence }),
    });

    expect(result.exitCode).toBe(EXIT_CODES.permission);
    const error = JSON.parse(capture.stdout()).error;
    expect(error.code).toBe("APPROVAL_REQUIRED");
    expect(error.message).toContain("immutable and public");
    expect(error.details.submitting).toHaveLength(1);
    expect(error.details.submitting[0].evidenceId).toBe(record.id);
    expect(submitEvidence).not.toHaveBeenCalled();
  });

  it("registers the suite, submits the records and reports what Hub makes of them", async () => {
    const { root, record } = await withEvidence();
    const registerTestSuite = vi.fn(mockHub().registerTestSuite);
    const submitEvidence = vi.fn(mockHub().submitEvidence);
    const capture = captureIo();

    const result = await runCli(["compatibility", "sync", "--yes", "--json"], {
      ...runDependencies(root),
      io: capture.io,
      hubService: mockHub({ registerTestSuite, submitEvidence }),
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data.suite).toMatchObject({ id: CAPABILITY_SUITE_ID, version: CAPABILITY_SUITE_VERSION, state: "registered" });
    expect(output.data.submitted).toEqual([
      { evidenceId: record.id, created: true, supportsCurrentVerdict: true, fingerprint: "absent", signatureStatus: "none" },
    ]);
    expect(registerTestSuite).toHaveBeenCalledTimes(1);
    // The suite registration carries what the version stands for, or a later
    // major cannot expire these records.
    expect(registerTestSuite.mock.calls[0]?.[1]).toMatchObject({
      capabilityDigest: { digest: expect.stringContaining("sha256:") },
      ttlTable: { "protocol.non-streaming": 90 },
    });
    // The record goes up exactly as stored: Hub recomputes the hash from it.
    expect(submitEvidence.mock.calls[0]?.[1]).toMatchObject({ id: record.id });
  });

  it("does not submit a record whose id form Hub refuses", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-sync-legacy-"));
    const store = new FileEvidenceStore({ root: join(root, "Apexnova", "connect", "evidence") });
    const legacy = createEvidence({
      sourceType: "maintainer-test",
      subject: evidenceSubject,
      observedAt: "2026-09-08T10:00:00.000Z",
      outcomes: CAPABILITY_DEFINITIONS.map((definition) => ({ capabilityId: definition.id, support: "supported" as const })),
    });
    // The twelve records written before the id form was agreed look like this.
    await store.append({ ...legacy, id: `evidence.${"a".repeat(32)}` });
    const submitEvidence = vi.fn(mockHub().submitEvidence);
    const capture = captureIo();

    const result = await runCli(["compatibility", "sync", "--yes", "--json"], {
      ...runDependencies(root),
      io: capture.io,
      hubService: mockHub({ submitEvidence }),
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data.submitted).toEqual([]);
    expect(output.data.skipped[0].evidenceId).toBe(`evidence.${"a".repeat(32)}`);
    expect(submitEvidence).not.toHaveBeenCalled();
    expect(output.warnings.join(" ")).toContain("cannot be submitted");
  });

  it("refuses to revoke without a reason, and without approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-revoke-"));
    const revokeEvidence = vi.fn(mockHub().revokeEvidence);
    const id = `ev.sha256.${"b".repeat(64)}`;

    const noReason = captureIo();
    const missing = await runCli(["compatibility", "revoke", id, "--yes", "--json"], {
      ...runDependencies(root),
      io: noReason.io,
      hubService: mockHub({ revokeEvidence }),
    });
    expect(missing.exitCode).toBe(EXIT_CODES.usage);
    expect(JSON.parse(noReason.stdout()).error.message).toContain("--reason");

    const unapproved = captureIo();
    const pending = await runCli(["compatibility", "revoke", id, "--reason", "collected against the wrong deployment", "--json"], {
      ...runDependencies(root),
      io: unapproved.io,
      hubService: mockHub({ revokeEvidence }),
    });
    expect(pending.exitCode).toBe(EXIT_CODES.permission);
    expect(JSON.parse(unapproved.stdout()).error.code).toBe("APPROVAL_REQUIRED");
    expect(revokeEvidence).not.toHaveBeenCalled();

    const approved = captureIo();
    const done = await runCli(["compatibility", "revoke", id, "--reason", "collected against the wrong deployment", "--yes", "--json"], {
      ...runDependencies(root),
      io: approved.io,
      hubService: mockHub({ revokeEvidence }),
    });
    expect(done.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(approved.stdout()).data).toMatchObject({ evidenceId: id, reason: "collected against the wrong deployment" });
    expect(revokeEvidence).toHaveBeenCalledWith("default", id, "collected against the wrong deployment", expect.any(AbortSignal));
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
      requestIds: ["req_capability_1", "req_capability_2", "req_capability_rejected"],
      // Answered with an ID but never billed: there is no account behind a
      // rejected credential, so no ledger row is ever written for it.
      preAuthRequestIds: ["req_capability_rejected"],
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
      // The pre-auth probe is attributed to the run but never reconciled: Hub
      // opens no ledger row for a request it refused before authentication.
      billed: { amount: "0.000200", currency: "USD", settledRequests: 2, attributedRequests: 3, preAuthRequests: 1 },
      requestIds: ["req_capability_1", "req_capability_2", "req_capability_rejected"],
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
    expect(output.data.billed).toMatchObject({ amount: "0.000000", settledRequests: 0, attributedRequests: 3, preAuthRequests: 1 });
    expect(output.warnings.join(" ")).toContain("has not settled 2 of 2 requests");
    expect(sleep).toHaveBeenCalled();

    const store = new FileEvidenceStore({ root: join(root, "Apexnova", "connect", "evidence") });
    const stored = await store.list();
    expect(stored[0]?.result.summary).toContain("over 0 settled of 3 attributed requests");
    expect(stored[0]?.result.summary).toContain("1 refused before authentication");
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

  it("ranks the catalog from the evidence on hand, and shows what decided it", async () => {
    const { root, record } = await withEvidence({ "agent.structured-output": "unsupported" });
    const capture = captureIo();

    const result = await runCli(["recommend", "opencode", "--json"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z"),
      io: capture.io,
      hubService: mockHub(),
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data).toMatchObject({
      scenarioId: "coding-general",
      ruleVersion: "coding.v1",
      catalogVersion: "cat_1",
    });
    // What goes out is the Recommendation the schema freezes, not the renderer's
    // convenience shape: it validates, it is content-addressed, and it carries
    // the `expiresAt` the schema has always required.
    expect(validateRecommendation(output.data)).toMatchObject({ valid: true });
    expect(output.data.id).toMatch(/^rec\.sha256\.[0-9a-f]{64}$/);
    expect(output.data.expiresAt).toBe(record.expiresAt);
    expect(output.data.platform).toBeUndefined();

    const top = output.data.candidates[0];
    expect(top).toMatchObject({ deploymentId: "deployment.nova", rank: 1, eligible: true, sponsored: false });
    expect(top.evidenceRefs).toContain(record.id);
    // The schema has no field for a dimension's score and weight, so they are
    // written into `reasons` rather than dropped -- the numbers that produced
    // the ranking stay beside the ranking either way.
    expect(top.reasons.join("\n")).toContain("compatibility scored 0.67 at weight 0.67");
    expect(top.reasons.join("\n")).toContain("preferred capabilities supported");
    expect(top.reasons.join("\n")).toContain(`windows-${process.arch}`);
  });

  it("resolves an allowlist through the catalog, and refuses a name it does not carry", async () => {
    const { root } = await withEvidence();
    const capture = captureIo();

    const bad = await runCli(["recommend", "opencode", "--model-allowlist", "deployment.nova,not-a-model"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z"),
      io: capture.io,
      hubService: mockHub(),
    });

    // An allowlist that silently matches nothing is the same failure as a price
    // ceiling that excludes nobody: the constraint was set and did not apply.
    expect(bad.exitCode).toBe(EXIT_CODES.unavailable);

    const ok = captureIo();
    const good = await runCli(["recommend", "opencode", "--model-allowlist", "deployment.nova", "--json"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z"),
      io: ok.io,
      hubService: mockHub(),
    });

    expect(good.exitCode).toBe(EXIT_CODES.success);
    const data = JSON.parse(ok.stdout()).data;
    expect(data.candidates).toHaveLength(1);
    // The constraints that were applied are recorded on the document, so a
    // reader can tell a narrow ranking from a narrow catalog.
    expect(data.constraints).toMatchObject({ deploymentIds: ["deployment.nova"] });
  });

  it("refuses --deployment and --model-allowlist together rather than guessing", async () => {
    const { root } = await withEvidence();
    const capture = captureIo();

    const result = await runCli(
      ["recommend", "opencode", "--deployment", "deployment.nova", "--model-allowlist", "deployment.nova"],
      { ...explainDependencies(root, "2026-09-20T10:00:00.000Z"), io: capture.io, hubService: mockHub() },
    );

    expect(result.exitCode).toBe(EXIT_CODES.usage);
  });

  it("refuses a restore that names no transaction instead of printing a table", async () => {
    const capture = captureIo();

    // `restore --yes` used to fall through to the listing branch and exit 0: the
    // user had asked to restore and approved it, and the configuration stayed
    // written while the runtime credential stayed live. A command that reports
    // success must have done the thing.
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-restore-yes-"));
    const result = await runCli(["restore", "--yes"], {
      io: capture.io,
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      cwd: root,
      createRequestId: () => "local_restore_yes",
    });

    expect(result.exitCode).toBe(EXIT_CODES.usage);
    expect(capture.stderr()).toContain("needs a transaction ID");
  });

  it("points the Agent at loopback when the gateway is asked for, and says how it attributed", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-gateway-"));
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, "{}\n", "utf8");
    const credentials = memoryCredentials();
    let launchedKey: string | undefined;
    let duringLaunch = "";
    const capture = captureIo();

    const result = await runCli(["run", "opencode", "--gateway", "--deployment", "deployment.nova", "--json"], {
      io: capture.io,
      credentialStore: credentials,
      registry: registryWith({ detect: async () => ({ ...installed, configPath }) }),
      hubService: mockHub(),
      launchAgent: async ({ environment }) => {
        // Read while the Agent is running: the gateway run takes its own
        // configuration back afterwards, because a loopback port and a token
        // that died with the process are no use to the next launch.
        launchedKey = environment.APEXNOVA_API_KEY;
        duringLaunch = await readFile(configPath, "utf8");
        return 0;
      },
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      cwd: root,
      createRequestId: () => "local_gateway",
    });

    if (result.exitCode !== EXIT_CODES.success) throw new Error(`${capture.stdout()}${capture.stderr()}`);
    expect(result.exitCode).toBe(EXIT_CODES.success);
    // The Agent talks to loopback and holds a local token; the Hub credential
    // stays in the gateway process. That boundary is the point, not a detail.
    expect(duringLaunch).toContain("http://127.0.0.1:");
    // And taken back: the address is gone once the gateway is.
    expect(await readFile(configPath, "utf8")).not.toContain("127.0.0.1");
    expect(launchedKey).toBeDefined();
    expect(launchedKey).not.toContain("runtime-secret");

    const audit = await new RoutingAuditLog({
      path: routingAuditPath(join(root, "Apexnova", "connect")),
    }).list();
    const attributed = audit.find((entry) => entry.event === "attributed");
    // No request was made -- the launcher is stubbed -- so the figure is
    // unconfirmed, and the method says a gateway produced it rather than a
    // difference between billing buckets.
    expect(attributed?.attribution).toMatchObject({ method: "gateway", status: "unconfirmed" });
  });

  /**
   * A gateway run whose credential comes due partway through, with the clock
   * and the credential issuer under the test's control.
   *
   * `session` is handed a function that makes one request through the gateway
   * and a clock it can move, so a test decides where the boundary falls.
   */
  async function runAcrossRenewal(
    session: (ask: () => Promise<unknown>, crossExpiry: () => void) => Promise<void>,
    // How long Hub takes to issue the replacement. Real time, not the fake
    // clock: it is what decides whether requests actually overlap inside the
    // renewal, and with instant stubs they never do.
    renewalDelayMs = 0,
    renewalFails = false,
  ) {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-renewal-"));
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, "{}\n", "utf8");

    const presented: string[] = [];
    const upstream = createServer((request, response) => {
      presented.push(String(request.headers.authorization ?? ""));
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json", "x-apexnova-request-id": `req_${presented.length}` });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as { port: number }).port;

    const start = Date.parse("2026-09-12T09:00:00.000Z");
    let clock = start;
    const issued = [
      { credentialId: "rtc_1", expiresAt: new Date(start + 90 * 60_000).toISOString(), secret: "secret-first" },
      { credentialId: "rtc_2", expiresAt: new Date(start + 26 * 60 * 60_000).toISOString(), secret: "secret-second" },
    ];
    const created: string[] = [];
    const revoked: string[] = [];
    let attempts = 0;
    const base = await mockHub().catalog("default");
    const hub = mockHub({
      createRuntimeCredential: async () => {
        attempts += 1;
        if (renewalFails && attempts > 1) throw new Error("Hub is unavailable");
        const next = issued[created.length] ?? issued[issued.length - 1]!;
        created.push(next.credentialId);
        if (created.length > 1 && renewalDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, renewalDelayMs));
        }
        return { credentialId: next.credentialId, expiresAt: next.expiresAt, deviceId: "device_1", secret: SecretValue.from(next.secret) };
      },
      catalog: async () => ({
        ...base,
        deployments: base.deployments.map((deployment) => ({
          ...deployment,
          protocols: [{ protocol: "openai-responses", baseUrl: `http://127.0.0.1:${port}/v1/responses` }],
        })),
      }),
      runtimeCredentials: async () =>
        created.map((credentialId) => ({
          credentialId, name: "OpenCode", prefix: "anrt_abcd...wxyz", deviceId: "device_1",
          protocols: ["openai-responses"], publicDeploymentIds: ["deployment.nova"],
          expiresAt: issued.find((item) => item.credentialId === credentialId)!.expiresAt,
          createdAt: "2026-09-12T09:00:00.000Z",
        })),
      revokeRuntimeCredential: async (_profile, credentialId) => { revoked.push(credentialId); },
    });

    const capture = captureIo();
    const result = await runCli(["run", "opencode", "--gateway", "--deployment", "deployment.nova", "--json"], {
      io: capture.io,
      credentialStore: memoryCredentials(),
      registry: registryWith({ detect: async () => ({ ...installed, configPath }) }),
      hubService: hub,
      now: () => new Date(clock),
      launchAgent: async ({ environment }) => {
        const config = await readFile(configPath, "utf8");
        const address = /http:\/\/127\.0\.0\.1:\d+[^"]*/.exec(config)?.[0];
        if (!address) throw new Error(`no gateway address in ${config}`);
        await session(
          () => fetch(address, {
            method: "POST",
            headers: { authorization: `Bearer ${environment.APEXNOVA_API_KEY}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "nova" }),
          }),
          () => { clock = start + 60 * 60_000; },
        );
        return 0;
      },
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      cwd: root,
      createRequestId: () => "local_renewal",
    });
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (result.exitCode !== EXIT_CODES.success) throw new Error(`${capture.stdout()}${capture.stderr()}`);

    const audit = await new RoutingAuditLog({ path: routingAuditPath(join(root, "Apexnova", "connect")) }).list();
    return { created, revoked, presented, capture, attempts, attributed: audit.find((entry) => entry.event === "attributed") };
  }

  it("renews the credential mid-run and bills each request to the one that paid", async () => {
    // ADR 0019 listed this as untested; it was not implemented. The binding was
    // assigned once at configure time and nothing updated it, so a run that
    // outlived its credential would fail. This drives a run across that
    // boundary with a clock the test moves.
    const run = await runAcrossRenewal(async (ask, crossExpiry) => {
      await ask();
      // The session crosses into the last hour of the credential's life.
      crossExpiry();
      await ask();
      await ask();
    });

    // Exactly two: the configure step and one renewal.
    expect(run.created).toEqual(["rtc_1", "rtc_2"]);
    // The Agent never saw either of them -- it held the local token throughout,
    // which is why the credential could be replaced underneath a running
    // process at all. On a direct connection this would mean rewriting the
    // Agent's configuration while it reads it, which is why that path issues a
    // key that never expires instead.
    expect(run.presented).toEqual(["Bearer secret-first", "Bearer secret-second", "Bearer secret-second"]);
    expect(run.revoked).toContain("rtc_1");

    expect(run.attributed?.attribution?.requestCount).toBe(3);
    // Split, not totalled: one line for the run would put all three requests on
    // a credential that paid for two of them.
    expect(run.attributed?.attribution?.billedTo).toEqual([
      { apiKeyId: "rtc_1", deploymentId: "deployment.nova", requestCount: 1 },
      { apiKeyId: "rtc_2", deploymentId: "deployment.nova", requestCount: 2 },
    ]);
    expect(run.capture.stdout()).toContain("renewed mid-run");
  });

  it("makes eight requests that come due together wait on one renewal, not eight", async () => {
    // What single-flighting prevents is queueing, not over-issuing: rotation
    // takes a cross-process file lock and re-checks under it, so seven extra
    // attempts would each find the credential already replaced and mint
    // nothing. They would each have waited on that lock first, at a 100ms retry
    // interval, which is what the elapsed assertion below is about.
    //
    // The renewal is made slow on purpose. With instant stubs the first one
    // finishes before the other requests reach the check, so they never overlap
    // and the test proves nothing -- which is what an earlier version of it did.
    let elapsed = 0;
    const run = await runAcrossRenewal(async (ask, crossExpiry) => {
      crossExpiry();
      const started = Date.now();
      await Promise.all(Array.from({ length: 8 }, () => ask()));
      elapsed = Date.now() - started;
    }, 50);

    expect(run.created).toEqual(["rtc_1", "rtc_2"]);
    expect(run.presented).toEqual(Array.from({ length: 8 }, () => "Bearer secret-second"));
    expect(run.attributed?.attribution?.billedTo).toEqual([
      { apiKeyId: "rtc_2", deploymentId: "deployment.nova", requestCount: 8 },
    ]);
    // Well under seven lock waits. Removing the single-flight makes this fail.
    expect(elapsed).toBeLessThan(400);
  });

  it("keeps running on the credential it holds when the renewal fails", async () => {
    // Due means inside the last hour of the credential's life, not expired, so
    // a renewal that fails is not a reason to fail a request that would work.
    // When it really does expire, Hub answers 401 and the gateway forwards that
    // unchanged -- the truth about what happened rather than a guess made here.
    const run = await runAcrossRenewal(async (ask, crossExpiry) => {
      await ask();
      crossExpiry();
      await ask();
      await ask();
      await ask();
    }, 0, true);

    expect(run.created).toEqual(["rtc_1"]);
    expect(run.presented).toEqual(Array.from({ length: 4 }, () => "Bearer secret-first"));
    // One retry, not one per request. A Hub that is refusing would otherwise be
    // asked again by every forwarded request, turning its outage into a second
    // one of our own making.
    expect(run.attempts).toBe(2);
    expect(run.capture.stdout()).toContain("could not be renewed mid-run");
    expect(run.attributed?.attribution?.billedTo).toEqual([
      { apiKeyId: "rtc_1", deploymentId: "deployment.nova", requestCount: 4 },
    ]);
  });

  it("takes the gateway back when the Agent exits non-zero", async () => {
    // Closing the gateway and restoring the configuration used to happen only
    // after a successful launch. An Agent exiting non-zero raises AGENT_EXITED,
    // so that path left the server listening -- the process then never exited
    // at all -- and left a dead loopback address in the Agent's config for the
    // next launch to find.
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-gateway-fail-"));
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, "{}\n", "utf8");
    const capture = captureIo();
    let duringLaunch = "";

    const result = await runCli(["run", "opencode", "--gateway", "--deployment", "deployment.nova"], {
      io: capture.io,
      credentialStore: memoryCredentials(),
      registry: registryWith({ detect: async () => ({ ...installed, configPath }) }),
      hubService: mockHub(),
      launchAgent: async () => {
        duringLaunch = await readFile(configPath, "utf8");
        return 1;
      },
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      cwd: root,
      createRequestId: () => "local_gateway_fail",
    });

    expect(result.exitCode).toBe(EXIT_CODES.runtime);
    // The run really did go through the gateway, so the restore below is
    // undoing something rather than passing vacuously.
    expect(duringLaunch).toContain("http://127.0.0.1:");
    expect(await readFile(configPath, "utf8")).not.toContain("127.0.0.1");
  });

  it("honours --credential-ttl, and renews on the same lifetime rather than a day", async () => {
    // ADR 0020's first condition asks for a run that crosses credential expiry.
    // With a fixed 24-hour lifetime the only way to reach that code was to wait
    // out the day, which is why nobody ever had. A configurable lifetime makes
    // the path reachable -- and a ten-minute run has no business holding a
    // day-long credential either.
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-ttl-"));
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, "{}\n", "utf8");

    const start = Date.parse("2026-09-13T09:00:00.000Z");
    let clock = start;
    const asked: number[] = [];
    const created: string[] = [];
    const hub = mockHub({
      createRuntimeCredential: async (_profile, input) => {
        asked.push(input.expiresIn as number);
        created.push(`rtc_${created.length + 1}`);
        return {
          credentialId: created[created.length - 1]!,
          expiresAt: new Date(clock + (input.expiresIn as number) * 1_000).toISOString(),
          deviceId: "device_1",
          secret: SecretValue.from(`secret-${created.length}`),
        };
      },
      runtimeCredentials: async () =>
        created.map((credentialId) => ({
          credentialId, name: "OpenCode", prefix: "anrt_abcd...wxyz", deviceId: "device_1",
          protocols: ["openai-responses"], publicDeploymentIds: ["deployment.nova"],
          expiresAt: new Date(clock + 600_000).toISOString(), createdAt: "2026-09-13T09:00:00.000Z",
        })),
    });
    const credentials = memoryCredentials();
    const deps = () => ({
      credentialStore: credentials,
      registry: registryWith({ detect: async () => ({ ...installed, configPath }) }),
      hubService: hub,
      now: () => new Date(clock),
      launchAgent: async () => 0,
      platform: "win32" as const,
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      cwd: root,
    });

    const capture = captureIo();
    const first = await runCli(
      ["run", "opencode", "--credential-ttl", "600", "--deployment", "deployment.nova", "--json"],
      { io: capture.io, ...deps(), createRequestId: () => "local_ttl" },
    );
    if (first.exitCode !== EXIT_CODES.success) throw new Error(`${capture.stdout()}${capture.stderr()}`);
    expect(asked).toEqual([600]);

    // Six minutes on: past half of a ten-minute life, so this launch replaces
    // it. Under the fixed hour the credential would have been due the instant
    // it was issued, and every launch would have minted another.
    clock = start + 6 * 60_000;
    const again = captureIo();
    const second = await runCli(["run", "opencode", "--json"], { io: again.io, ...deps(), createRequestId: () => "local_ttl_2" });
    if (second.exitCode !== EXIT_CODES.success) throw new Error(`${again.stdout()}${again.stderr()}`);

    // Renewed once, and on the lifetime the run was started with. Reissuing at
    // 86400 would quietly undo the choice the first command made.
    expect(asked).toEqual([600, 600]);
    expect(created).toEqual(["rtc_1", "rtc_2"]);
  });

  it("refuses to send a run direct when the gateway was asked for", async () => {
    // The flag silently doing nothing is the failure this milestone keeps
    // finding; asked-for-and-not-running is a contradiction, not a fallback.
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-gateway-guard-"));
    const credentials = memoryCredentials();
    await new RuntimeBindingStore(credentials).save("opencode", "default", {
      credentialId: "rtc_1",
      secret: SecretValue.from("runtime-secret"),
      expiresAt: "2099-09-05T12:00:00Z",
      protocol: "openai-responses",
      deploymentId: "deployment.nova",
    });
    const capture = captureIo();

    const result = await runCli(["run", "opencode", "--gateway", "--json"], {
      io: capture.io,
      credentialStore: credentials,
      registry: registryWith({ detect: async () => installed }),
      hubService: mockHub({ catalog: async () => { throw new HubClientError("API_ERROR", "catalog unavailable"); } }),
      launchAgent: async () => 0,
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
      createRequestId: () => "local_gateway_guard",
    });

    expect(result.exitCode).not.toBe(EXIT_CODES.success);
  });

  it("reads the audit log back with each cost under the decision it paid for", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-cli-audit-"));
    const state = { platform: "win32" as const, environment: { LOCALAPPDATA: root }, homeDirectory: root };
    const log = new RoutingAuditLog({ path: routingAuditPath(join(root, "Apexnova", "connect")) });
    const selected = await log.append(createRoutingAuditEntry({
      event: "selected",
      agentId: "opencode",
      profile: "default",
      command: "connect",
      deploymentId: "deployment.nova",
      protocol: "openai-responses",
      grounds: "recommendation",
      recommendationId: `rec.sha256.${"c".repeat(64)}`,
      credentialId: "rtc_1",
      recordedAt: "2026-09-11T20:00:00.000Z",
    }));
    await log.append(createRoutingAuditEntry({
      event: "attributed",
      agentId: "opencode",
      profile: "default",
      command: "run",
      selectionId: selected.id,
      attribution: { status: "confirmed", method: "gateway", requestCount: 2, requests: [{ requestId: "req_a", method: "POST", path: "/v1/responses", status: 200, durationMs: 812 }, { requestId: "req_b" }], billedTo: [{ apiKeyId: "rtc_1", requestCount: 2 }] },
      recordedAt: "2026-09-11T20:05:00.000Z",
    }));
    await log.append(createRoutingAuditEntry({
      event: "attributed",
      agentId: "opencode",
      profile: "default",
      command: "verify",
      attribution: { status: "mismatched", method: "ledger-window", requestCount: 1, billedTo: [{ apiKeyId: "key_other", apiKeyName: "someone-else", requestCount: 1 }] },
      recordedAt: "2026-09-11T20:06:00.000Z",
    }));

    const capture = captureIo();
    const result = await runCli(["audit", "opencode"], {
      ...state,
      io: capture.io,
      registry: registryWith(),
      createRequestId: () => "local_audit",
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = capture.stdout();
    // The three questions a route has to answer, together: which deployment, on
    // what grounds, and who actually paid.
    expect(output).toContain("deployment.nova");
    expect(output).toContain("chosen: recommendation (rec.sha256.");
    expect(output).toContain("billed (run): confirmed via gateway, 2 requests — 2 on rtc_1");
    // The per-request line is routing detail, printed as a single reading and
    // never as a latency measurement.
    expect(output).toContain("POST /v1/responses 200 in 812ms (req_a)");
    // An attribution with no recorded decision is still a fact about spending.
    // Dropping it would be the quiet omission the log exists to prevent.
    expect(output).toContain("Not linked to any recorded route");
    expect(output).toContain("someone-else");
  });

  it("refuses an option the command would have ignored", async () => {
    const capture = captureIo();

    const result = await runCli(["balance", "--max-price", "5", "--json"], {
      io: capture.io,
      hubService: mockHub(),
      createRequestId: () => "local_unread",
    });

    // Three times this milestone a switch was set, did nothing and reported
    // success -- `--max-price` excluding nobody, `restore --yes` printing a
    // table, `run --gateway` going direct. None was caught by a test. An option
    // the command never reads is the same failure with the volume turned down,
    // so it is a usage error rather than a silence.
    expect(result.exitCode).toBe(EXIT_CODES.usage);
    const error = JSON.parse(capture.stdout()).error;
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.message).toContain("does not read --max-price");
    expect(error.details.accepted).toBeDefined();
  });

  it("says on every run that the ranking only ever saw the Apexnova catalog", async () => {
    const { root } = await withEvidence();
    const capture = captureIo();

    const result = await runCli(["recommend", "opencode"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z"),
      io: capture.io,
      hubService: mockHub(),
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    // Four ranked deployments read as "the best four there are" unless the
    // boundary is on the page: a Provider outside the catalog is not ranked
    // lower, it never entered. ADR 0008 keeps this stated until M5 supplies a
    // second candidate source.
    expect(capture.stdout()).toContain("Candidates come from the Apexnova catalog only");
    expect(capture.stdout()).toContain("not considered at all");
  });

  it("recommends nothing for a platform it has no evidence for, and says to collect some", async () => {
    // Evidence collected on Linux, recommendation asked for on Windows.
    const { root } = await withEvidence({}, { ...evidenceSubject, platform: "linux-x64" });
    const capture = captureIo();

    const result = await runCli(["recommend", "opencode", "--json"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z"),
      io: capture.io,
      hubService: mockHub(),
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    const output = JSON.parse(capture.stdout());
    expect(output.data.candidates.every((entry: { eligible: boolean }) => !entry.eligible)).toBe(true);
    expect(output.warnings.join(" ")).toContain("compatibility run opencode");
    expect(output.data.candidates[0].reasons.join(" ")).toContain("does not carry over");
  });

  it("refuses to recommend for an Agent that is not installed, and says that is why", async () => {
    const { root } = await withEvidence();
    const capture = captureIo();
    const { productVersion: _version, ...withoutVersion } = installed;

    const result = await runCli(["recommend", "opencode", "--json"], {
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z", { ...withoutVersion, status: "not-found" }),
      io: capture.io,
      hubService: mockHub(),
    });

    expect(result.exitCode).toBe(EXIT_CODES.unavailable);
    const error = JSON.parse(capture.stdout()).error;
    expect(error.code).toBe("AGENT_NOT_FOUND");
    expect(error.message).toContain("was not found in the current environment");
  });

  it("tells a failed version probe apart from an Agent that is not there", async () => {
    const { root } = await withEvidence();
    const capture = captureIo();
    const { productVersion: _version, ...withoutVersion } = installed;

    const result = await runCli(["recommend", "opencode", "--json"], {
      // Found, but nothing answered the version probe -- the state `detect`
      // reports as "installed" plus a warning. Reported as "not installed" it
      // sends the reader to install something that is already there.
      ...explainDependencies(root, "2026-09-20T10:00:00.000Z", {
        ...withoutVersion,
        status: "installed",
        warnings: ["The executable was found but its version command did not complete successfully."],
      }),
      io: capture.io,
      hubService: mockHub(),
    });

    expect(result.exitCode).toBe(EXIT_CODES.unavailable);
    const error = JSON.parse(capture.stdout()).error;
    expect(error.code).toBe("AGENT_VERSION_UNKNOWN");
    expect(error.message).toContain("is present but its version could not be read");
    expect(error.message).toContain("not the same as it being absent");
    expect(error.message).toContain("version command did not complete successfully");
  });
});
