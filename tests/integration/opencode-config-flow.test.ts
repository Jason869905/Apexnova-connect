import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  ConnectionIntent,
  IntegrationContext,
} from "../../sdks/typescript/src/index.js";
import { FileConfigExecutor } from "../../packages/config-engine/src/index.js";
import { runIntegrationChange } from "../../packages/core/src/index.js";
import { createOpenCodeIntegration } from "../../integrations/agents/opencode/src/index.js";

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

      // The real integration, with only its process probe replaced: this
      // exercises the shipped detect/inspect/plan/verify code, not a stand-in.
      const integration = createOpenCodeIntegration({
        runVersionCommand: async () => ({ found: true, stdout: "opencode 1.18.29\n" }),
      });

      const context: IntegrationContext = {
        platform: process.platform === "win32" ? "windows" : "linux",
        workingDirectory: root,
        homeDirectory: join(root, "home"),
        environment: {},
        configPath,
      };

      const executor = new FileConfigExecutor({
        allowedRoots: [configRoot],
        backupRoot,
        now: () => new Date("2026-09-02T20:00:02.000Z"),
      });
      const approve = vi.fn(async () => true);
      const intent: ConnectionIntent = {
        planId: "opencode-flow-plan",
        createdAt: "2026-09-02T20:00:00.000Z",
        deploymentId: "deployment.nova",
        inferenceAlias: "nova-coder",
        modelName: "Nova Coder",
        protocol: "openai-responses",
        baseUrl: "https://api.apexnova.example/v1/responses",
        apiKeyEnvironmentVariable: "APEXNOVA_API_KEY",
        limits: { context: 128000, output: 8192 },
      };

      const result = await runIntegrationChange({
        adapter: integration,
        executor,
        context,
        intent,
        approve,
      });

      expect(result.status).toBe("applied");
      expect(approve).toHaveBeenCalledOnce();
      const applied = await readFile(configPath, "utf8");
      expect(applied).toContain("// This user setting must survive");
      expect(applied).toContain('"apexnova"');
      expect(applied).toContain('"apiKey": "{env:APEXNOVA_API_KEY}"');
      expect(applied).toContain('"baseURL": "https://api.apexnova.example/v1"');
      expect(applied).not.toContain("runtime-secret");

      if (result.status !== "applied") {
        throw new TypeError("Expected the change to be applied.");
      }
      await executor.rollback(result.receipt);
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await removeTestRoot(root);
    }
  });

  it("re-planning an already configured file is a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "apexnova-connect-flow-"));

    try {
      const configRoot = join(root, "config");
      const configPath = join(configRoot, "opencode.jsonc");
      await mkdir(configRoot);
      await writeFile(configPath, "{}\n", "utf8");

      const integration = createOpenCodeIntegration({
        runVersionCommand: async () => ({ found: true, stdout: "opencode 1.18.29\n" }),
      });
      const context: IntegrationContext = {
        platform: process.platform === "win32" ? "windows" : "linux",
        workingDirectory: root,
        homeDirectory: join(root, "home"),
        environment: {},
        configPath,
      };
      const intent: ConnectionIntent = {
        planId: "opencode-idempotent-plan",
        createdAt: "2026-09-02T20:00:00.000Z",
        deploymentId: "deployment.nova",
        inferenceAlias: "nova-coder",
        modelName: "Nova Coder",
        protocol: "openai-responses",
        baseUrl: "https://api.apexnova.example/v1/responses",
        apiKeyEnvironmentVariable: "APEXNOVA_API_KEY",
      };

      const detection = await integration.detect(context);
      if (detection.status === "not-found" || detection.status === "unsupported") {
        throw new TypeError("Expected the temporary configuration to be detected.");
      }
      const first = await integration.plan(
        context,
        detection,
        await integration.inspect(context, detection),
        intent,
      );
      await writeFile(configPath, first.operations[0]!.content, "utf8");

      const second = await integration.plan(
        context,
        { ...detection, configExists: true },
        await integration.inspect(context, { ...detection, configExists: true }),
        intent,
      );
      expect(second.operations).toHaveLength(0);
    } finally {
      await removeTestRoot(root);
    }
  });
});
