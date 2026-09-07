import { describe, expect, it, vi } from "vitest";

import type {
  AgentIntegration,
  DetectionResult,
  IntegrationContext,
  IntegrationManifest,
} from "@apexnova-connect/integration-sdk";

import {
  createIntegrationRegistry,
  detectAgent,
  IntegrationRegistryError,
  satisfiesVersionRange,
  VersionRangeError,
} from "../src/index.js";

const context: IntegrationContext = {
  platform: "linux",
  workingDirectory: "/workspace",
  homeDirectory: "/home/tester",
  environment: {},
};

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    schemaVersion: "1",
    id: "test-agent",
    displayName: "Test Agent",
    description: "Test integration used by registry tests.",
    version: "0.1.0",
    status: "experimental",
    category: "agent",
    delivery: { modes: ["config-adapter"] },
    compatibility: {
      platforms: ["linux"],
      products: [{ name: "Test Agent", versionRange: ">=1.2.0 <2.0.0" }],
    },
    protocols: [{ id: "openai-responses", transport: "direct" }],
    capabilities: ["provider-config"],
    permissions: [],
    ...overrides,
  } as IntegrationManifest;
}

function detection(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    agentId: "test-agent",
    displayName: "Test Agent",
    status: "installed",
    productVersion: "1.5.0",
    configPath: "/workspace/test.json",
    configExists: true,
    configScope: "project",
    evidence: [],
    warnings: [],
    ...overrides,
  } as DetectionResult;
}

function integration(overrides: Partial<AgentIntegration> = {}): AgentIntegration {
  return {
    manifest: manifest(),
    credentialEnvironmentVariable: "APEXNOVA_API_KEY",
    supportedProtocols: ["openai-responses"],
    detect: vi.fn(async () => detection()),
    inspect: vi.fn(async () => ({
      agentId: "test-agent",
      configPath: "/workspace/test.json",
      status: "not-configured" as const,
      managed: false,
      warnings: [],
    })),
    plan: vi.fn(),
    verify: vi.fn(),
    configRoots: () => ["/workspace"],
    planLaunch: vi.fn(),
    diagnose: vi.fn(async () => []),
    ...overrides,
  } as AgentIntegration;
}

describe("createIntegrationRegistry", () => {
  it("rejects an unknown agent and names the ones it has", () => {
    const registry = createIntegrationRegistry([integration()]);

    expect(() => registry.resolve("codex")).toThrowError(IntegrationRegistryError);
    try {
      registry.resolve("codex");
    } catch (error) {
      expect(error).toMatchObject({
        code: "INTEGRATION_NOT_SUPPORTED",
        details: { agentId: "codex", supportedAgents: ["test-agent"] },
      });
    }
  });

  it("refuses a platform the manifest does not declare", () => {
    const registry = createIntegrationRegistry([integration()]);

    expect(() => registry.resolve("test-agent", "windows")).toThrowError(
      IntegrationRegistryError,
    );
    try {
      registry.resolve("test-agent", "windows");
    } catch (error) {
      expect(error).toMatchObject({ code: "PLATFORM_NOT_SUPPORTED" });
    }
    expect(registry.list("windows")).toHaveLength(0);
    expect(registry.list("linux")).toHaveLength(1);
  });

  it("refuses to register the same agent twice", () => {
    expect(() => createIntegrationRegistry([integration(), integration()])).toThrowError(
      /More than one integration is registered as test-agent/,
    );
  });

  it("rejects an integration whose manifest does not validate", () => {
    const broken = integration({ manifest: manifest({ id: "" }) });

    expect(() => createIntegrationRegistry([broken])).toThrowError(TypeError);
  });
});

describe("detectAgent", () => {
  it("passes a version inside the declared range straight through", async () => {
    const result = await detectAgent(integration(), context);

    expect(result.status).toBe("installed");
  });

  it("downgrades a version outside the declared range to unsupported", async () => {
    const drifted = integration({
      detect: vi.fn(async () => detection({ productVersion: "2.0.0" })),
    });

    const result = await detectAgent(drifted, context);

    expect(result.status).toBe("unsupported");
    if (result.status !== "unsupported") throw new TypeError("Expected an unsupported result.");
    expect(result.unsupportedReason).toContain("2.0.0");
    expect(result.unsupportedReason).toContain(">=1.2.0 <2.0.0");
  });

  it("treats an unreadable range as unsupported rather than satisfied", async () => {
    const unreadable = integration({
      manifest: manifest({
        compatibility: {
          platforms: ["linux"],
          products: [{ name: "Test Agent", versionRange: "^1.2.0" }],
        },
      }),
    });

    const result = await detectAgent(unreadable, context);

    expect(result.status).toBe("unsupported");
  });

  it("does not gate a product that reported no version", async () => {
    const unknownVersion = integration({
      detect: vi.fn(async () => {
        const { productVersion: _ignored, ...rest } = detection();
        return rest as DetectionResult;
      }),
    });

    expect((await detectAgent(unknownVersion, context)).status).toBe("installed");
  });
});

describe("satisfiesVersionRange", () => {
  it("evaluates comparator sets", () => {
    expect(satisfiesVersionRange("1.18.29", ">=1.18.29 <2.0.0")).toBe(true);
    expect(satisfiesVersionRange("1.18.28", ">=1.18.29 <2.0.0")).toBe(false);
    expect(satisfiesVersionRange("2.0.0", ">=1.18.29 <2.0.0")).toBe(false);
    expect(satisfiesVersionRange("0.21.0", ">=0.21.0")).toBe(true);
  });

  it("orders a prerelease before its release", () => {
    expect(satisfiesVersionRange("2.0.0-rc.1", "<2.0.0")).toBe(true);
    expect(satisfiesVersionRange("2.0.0", "<2.0.0")).toBe(false);
  });

  it("refuses syntax it cannot evaluate instead of approximating", () => {
    expect(() => satisfiesVersionRange("1.0.0", "^1.0.0")).toThrowError(VersionRangeError);
    expect(() => satisfiesVersionRange("1.0.0", "1.x")).toThrowError(VersionRangeError);
    expect(() => satisfiesVersionRange("not-a-version", ">=1.0.0")).toThrowError(VersionRangeError);
  });
});
