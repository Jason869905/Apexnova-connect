import { describe, expect, it, vi } from "vitest";

import type {
  ApplyReceipt,
  ChangeExecutor,
  ChangePlan,
  IntegrationAdapter,
  IntegrationContext,
  IntegrationManifest,
} from "@apexnova-connect/integration-sdk";

import { IntegrationChangeError, runIntegrationChange } from "../src/index.js";

interface TestIntent {
  readonly enabled: boolean;
}

interface TestSnapshot {
  readonly enabled: boolean;
}

const context: IntegrationContext = {
  platform: "linux",
  workingDirectory: "/workspace",
};

const manifest = {
  schemaVersion: "1",
  id: "test-agent",
  displayName: "Test Agent",
  description: "Test integration used by lifecycle orchestration tests.",
  version: "0.1.0",
  status: "experimental",
  category: "agent",
  delivery: { modes: ["config-adapter"] },
  compatibility: {
    platforms: ["linux"],
    products: [{ name: "Test Agent" }],
  },
  protocols: [],
  capabilities: ["provider-config"],
  permissions: [],
} satisfies IntegrationManifest;

const plan: ChangePlan = {
  id: "plan-1",
  integrationId: manifest.id,
  summary: "Enable the test provider.",
  createdAt: "2026-09-02T20:00:00.000Z",
  operations: [
    {
      type: "write-file",
      path: "/workspace/config.json",
      mode: "update",
      expectedContentHash: "sha256:before",
      content: "{}\n",
      containsSecrets: false,
    },
  ],
  requiresRestart: true,
  warnings: [],
};

const receipt: ApplyReceipt = {
  planId: plan.id,
  appliedAt: "2026-09-02T20:00:01.000Z",
  rollbackToken: { test: true },
};

function createAdapter(): IntegrationAdapter<TestIntent, TestSnapshot> {
  return {
    manifest,
    detect: vi.fn(async () => ({ status: "available" }) as const),
    inspect: vi.fn(async () => ({ snapshot: { enabled: false }, warnings: [] })),
    plan: vi.fn(async () => plan),
    verify: vi.fn(async () => ({ valid: true }) as const),
  };
}

function createExecutor(): ChangeExecutor {
  return {
    apply: vi.fn(async () => receipt),
    rollback: vi.fn(async () => undefined),
  };
}

describe("runIntegrationChange", () => {
  it("rejects an invalid manifest before product detection", async () => {
    const adapter = createAdapter();
    const detect = adapter.detect;
    const invalidAdapter = {
      ...adapter,
      manifest: { ...manifest, schemaVersion: "999" },
    } as unknown as IntegrationAdapter<TestIntent, TestSnapshot>;

    await expect(
      runIntegrationChange({
        adapter: invalidAdapter,
        executor: createExecutor(),
        context,
        intent: { enabled: true },
        approve: vi.fn(async () => true),
      }),
    ).rejects.toMatchObject({ phase: "manifest" });
    expect(detect).not.toHaveBeenCalled();
  });

  it("stops before inspection when the product is unavailable", async () => {
    const adapter = createAdapter();
    adapter.detect = vi.fn(
      async () =>
        ({
          status: "not-installed",
          reason: "Test Agent was not found.",
        }) as const,
    );
    const executor = createExecutor();

    const result = await runIntegrationChange({
      adapter,
      executor,
      context,
      intent: { enabled: true },
      approve: vi.fn(async () => true),
    });

    expect(result.status).toBe("unavailable");
    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(executor.apply).not.toHaveBeenCalled();
  });

  it("never applies a change without explicit approval", async () => {
    const executor = createExecutor();

    const result = await runIntegrationChange({
      adapter: createAdapter(),
      executor,
      context,
      intent: { enabled: true },
      approve: vi.fn(async () => false),
    });

    expect(result.status).toBe("declined");
    expect(executor.apply).not.toHaveBeenCalled();
  });

  it("applies and verifies an approved change", async () => {
    const executor = createExecutor();

    const result = await runIntegrationChange({
      adapter: createAdapter(),
      executor,
      context,
      intent: { enabled: true },
      approve: vi.fn(async () => true),
    });

    expect(result.status).toBe("applied");
    expect(executor.apply).toHaveBeenCalledWith(plan);
    expect(executor.rollback).not.toHaveBeenCalled();
  });

  it("rolls back when verification rejects the applied state", async () => {
    const adapter = createAdapter();
    adapter.verify = vi.fn(
      async () =>
        ({
          valid: false,
          reason: "The provider is not visible.",
        }) as const,
    );
    const executor = createExecutor();

    const result = await runIntegrationChange({
      adapter,
      executor,
      context,
      intent: { enabled: true },
      approve: vi.fn(async () => true),
    });

    expect(result.status).toBe("rolled-back");
    expect(executor.rollback).toHaveBeenCalledWith(receipt);
  });

  it("rejects a plan produced for another integration", async () => {
    const adapter = createAdapter();
    adapter.plan = vi.fn(async () => ({ ...plan, integrationId: "another-agent" }));

    await expect(
      runIntegrationChange({
        adapter,
        executor: createExecutor(),
        context,
        intent: { enabled: true },
        approve: vi.fn(async () => true),
      }),
    ).rejects.toMatchObject({
      phase: "plan",
    } satisfies Partial<IntegrationChangeError>);
  });
});
