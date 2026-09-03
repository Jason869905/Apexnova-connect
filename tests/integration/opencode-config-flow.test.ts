import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  IntegrationAdapter,
  IntegrationManifest,
} from "../../sdks/typescript/src/index.js";
import { assertIntegrationManifest } from "../../sdks/typescript/src/index.js";
import { FileConfigExecutor } from "../../packages/config-engine/src/index.js";
import { runIntegrationChange } from "../../packages/core/src/index.js";
import {
  planOpenCodeV2Config,
  type OpenCodeModelInput,
} from "../../integrations/agents/opencode/src/index.js";

interface OpenCodeIntent {
  readonly hubBaseUrl: string;
  readonly models: readonly OpenCodeModelInput[];
  readonly defaultModelId: string;
}

interface OpenCodeSnapshot {
  readonly configPath: string;
  readonly content: string;
}

async function removeTestRoot(root: string): Promise<void> {
  const resolvedTemp = await realpath(tmpdir());
  if (
    (await realpath(dirname(root))) !== resolvedTemp ||
    !basename(root).startsWith("apexnova-connect-flow-")
  ) {
    throw new Error(`Refusing to remove unexpected test directory: ${root}`);
  }
  await rm(root, { recursive: true, force: true });
}

describe("OpenCode configuration lifecycle", () => {
  it("plans, approves, applies, verifies, and restores a real temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-connect-flow-"));

    try {
      const configRoot = join(root, "config");
      const backupRoot = join(root, "backups");
      const configPath = join(configRoot, "opencode.jsonc");
      await mkdir(configRoot);
      const original = `{
  // This user setting must survive the provider update.
  "theme": "system",
}
`;
      await writeFile(configPath, original, "utf8");

      const manifestValue: unknown = JSON.parse(
        await readFile(
          new URL(
            "../../integrations/agents/opencode/manifest.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      assertIntegrationManifest(manifestValue);
      const manifest: IntegrationManifest = manifestValue;

      const adapter: IntegrationAdapter<OpenCodeIntent, OpenCodeSnapshot> = {
        manifest,
        detect: async () => ({
          status: "available",
          productVersion: "2.0.0",
          configPath,
        }),
        inspect: async () => ({
          snapshot: {
            configPath,
            content: await readFile(configPath, "utf8"),
          },
          warnings: [],
        }),
        plan: async (_context, inspection, intent) =>
          planOpenCodeV2Config({
            planId: "opencode-flow-plan",
            createdAt: "2026-09-02T20:00:00.000Z",
            configPath: inspection.snapshot.configPath,
            existingContent: inspection.snapshot.content,
            hubBaseUrl: intent.hubBaseUrl,
            models: intent.models,
            defaultModelId: intent.defaultModelId,
          }),
        verify: async (_context, changePlan) => {
          const current = await readFile(configPath, "utf8");
          const verificationPlan = planOpenCodeV2Config({
            planId: `${changePlan.id}-verify`,
            createdAt: "2026-09-02T20:00:01.000Z",
            configPath,
            existingContent: current,
            hubBaseUrl: "https://api.apexnova.example/v1",
            models: [
              {
                id: "nova-coder",
                name: "Nova Coder",
                protocol: "openai-responses",
              },
            ],
            defaultModelId: "nova-coder",
          });
          return verificationPlan.operations.length === 0
            ? ({ valid: true } as const)
            : ({ valid: false, reason: "OpenCode config does not match the plan." } as const);
        },
      };

      const executor = new FileConfigExecutor({
        allowedRoots: [configRoot],
        backupRoot,
        now: () => new Date("2026-09-02T20:00:02.000Z"),
      });
      const approve = vi.fn(async () => true);

      const result = await runIntegrationChange({
        adapter,
        executor,
        context: {
          platform: process.platform === "win32" ? "windows" : "linux",
          workingDirectory: root,
        },
        intent: {
          hubBaseUrl: "https://api.apexnova.example/v1",
          models: [
            {
              id: "nova-coder",
              name: "Nova Coder",
              protocol: "openai-responses",
            },
          ],
          defaultModelId: "nova-coder",
        },
        approve,
      });

      expect(result.status).toBe("applied");
      expect(approve).toHaveBeenCalledOnce();
      const applied = await readFile(configPath, "utf8");
      expect(applied).toContain("// This user setting must survive");
      expect(applied).toContain('"apexnova"');
      expect(applied).not.toContain("apiKey");

      if (result.status !== "applied") {
        throw new TypeError("Expected the change to be applied.");
      }
      await executor.rollback(result.receipt);
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await removeTestRoot(root);
    }
  });
});

