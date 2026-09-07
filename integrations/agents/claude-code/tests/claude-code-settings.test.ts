import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  protocolRootUrl,
  type IntegrationContext,
} from "@apexnova-connect/integration-sdk";

import {
  createClaudeCodeIntegration,
  detectClaudeCode,
  inspectClaudeCode,
  planClaudeCodeSettings,
} from "../src/index.js";

const testRoots: string[] = [];

async function createTestRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apexnova-claude-code-"));
  testRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of testRoots.splice(0)) {
    const resolvedTemp = await realpath(tmpdir());
    if (
      (await realpath(dirname(root))) !== resolvedTemp ||
      !basename(root).startsWith("apexnova-claude-code-")
    ) {
      throw new Error(`Refusing to remove unexpected test directory: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
});

const planBase = {
  planId: "plan.claude-code",
  createdAt: "2026-09-07T12:00:00.000Z",
  settingsPath: "/home/tester/.claude/settings.json",
  hubBaseUrl: "https://api.apexnova.example/anthropic",
  modelId: "nova-coder",
} as const;

function context(root: string): IntegrationContext {
  return {
    platform: "linux",
    workingDirectory: root,
    homeDirectory: join(root, "home"),
    environment: {},
  };
}

describe("Claude Code discovery", () => {
  it("targets the user settings file, never a project one", async () => {
    const root = await createTestRoot();
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.json"), "{}\n", "utf8");

    const detection = await detectClaudeCode(context(root), async () => ({
      found: true,
      stdout: "2.1.261 (Claude Code)",
    }));

    expect(detection.configPath).toBe(join(root, "home", ".claude", "settings.json"));
    expect(detection.configExists).toBe(false);
    expect(detection.productVersion).toBe("2.1.261");
  });

  it("reports a base URL written by someone else as unmanaged", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "settings.json");
    await writeFile(
      configPath,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other-gateway.example" } }),
      "utf8",
    );

    const inspection = await inspectClaudeCode({ configPath, configExists: true });

    expect(inspection.status).toBe("configured");
    expect(inspection.managed).toBe(false);
    expect(inspection.warnings[0]).toContain("other than Apexnova-connect");
  });

  it("warns about a credential in the settings file that would outrank the launcher", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "settings.json");
    await writeFile(
      configPath,
      JSON.stringify({
        apiKeyHelper: "~/bin/key.sh",
        env: {
          ANTHROPIC_BASE_URL: "https://api.apexnova.example/anthropic",
          APEXNOVA_CONNECT: "managed",
          ANTHROPIC_AUTH_TOKEN: "sk-must-not-leak",
        },
      }),
      "utf8",
    );

    const inspection = await inspectClaudeCode({ configPath, configExists: true });

    expect(inspection.managed).toBe(true);
    expect(inspection.warnings.join(" ")).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(inspection.warnings.join(" ")).toContain("apiKeyHelper");
    // The warning names the variable; it must never carry the value.
    expect(JSON.stringify(inspection)).not.toContain("must-not-leak");
  });
});

describe("planClaudeCodeSettings", () => {
  it("changes only the managed env keys", () => {
    const existing = `{
  // Keep this comment.
  "model": "opus[1m]",
  "tui": "fullscreen",
  "permissions": { "allow": ["Bash(ls:*)"] },
  "env": { "MY_VAR": "keep-me" }
}
`;

    const plan = planClaudeCodeSettings({ ...planBase, existingContent: existing });
    const content = plan.operations[0]!.content;

    expect(content).toContain("// Keep this comment.");
    expect(content).toContain('"model": "opus[1m]"');
    expect(content).toContain('"tui": "fullscreen"');
    expect(content).toContain('"Bash(ls:*)"');
    expect(content).toContain('"MY_VAR": "keep-me"');
    expect(content).toContain('"ANTHROPIC_BASE_URL": "https://api.apexnova.example/anthropic"');
    expect(content).toContain('"ANTHROPIC_MODEL": "nova-coder"');
    expect(content).toContain('"APEXNOVA_CONNECT": "managed"');
  });

  it("never writes a credential and says so in its warnings", () => {
    const plan = planClaudeCodeSettings({ ...planBase, existingContent: null });
    const content = plan.operations[0]!.content;

    expect(plan.operations[0]!.containsSecrets).toBe(false);
    expect(content).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(content).not.toContain("ANTHROPIC_API_KEY");
    expect(plan.warnings.join(" ")).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(plan.warnings.join(" ")).toContain("starting `claude` yourself");
  });

  it("is a no-op once applied", () => {
    const first = planClaudeCodeSettings({ ...planBase, existingContent: null });
    const second = planClaudeCodeSettings({
      ...planBase,
      existingContent: first.operations[0]!.content,
    });

    expect(second.operations).toHaveLength(0);
  });

  it("writes apiKeyHelper only when a helper command is supplied", () => {
    const helper = '"/opt/node" "/opt/apexnova.mjs" credential print claude-code --profile default';
    const withHelper = planClaudeCodeSettings({
      ...planBase,
      existingContent: null,
      credentialHelperCommand: helper,
    });
    const content = withHelper.operations[0]!.content;

    expect(content).toContain('"apiKeyHelper"');
    expect(content).toContain('"APEXNOVA_CONNECT": "managed-helper"');
    expect(withHelper.warnings.join(" ")).toContain("keeps working");
    expect(withHelper.warnings.join(" ")).not.toContain("will be rejected");
  });

  it("removes a helper it wrote when reconnecting without one", () => {
    const helper = '"/opt/node" "/opt/apexnova.mjs" credential print claude-code --profile default';
    const helperContent = planClaudeCodeSettings({
      ...planBase,
      existingContent: null,
      credentialHelperCommand: helper,
    }).operations[0]!.content;

    const backToLauncher = planClaudeCodeSettings({
      ...planBase,
      existingContent: helperContent,
    });
    const content = backToLauncher.operations[0]!.content;

    expect(content).not.toContain("apiKeyHelper");
    expect(content).toContain('"APEXNOVA_CONNECT": "managed"');
  });

  it("leaves a helper the user configured alone", () => {
    const existing = JSON.stringify({ apiKeyHelper: "~/bin/mine.sh" }, null, 2);

    const content = planClaudeCodeSettings({
      ...planBase,
      existingContent: existing,
    }).operations[0]!.content;

    expect(content).toContain('"apiKeyHelper": "~/bin/mine.sh"');
  });

  it("refuses a helper command that spans lines", () => {
    expect(() =>
      planClaudeCodeSettings({
        ...planBase,
        existingContent: null,
        credentialHelperCommand: "echo one\necho two",
      }),
    ).toThrowError(/single non-empty line/);
  });

  it("refuses a base URL carrying credentials", () => {
    expect(() =>
      planClaudeCodeSettings({
        ...planBase,
        existingContent: null,
        hubBaseUrl: "https://user:secret@api.apexnova.example/anthropic",
      }),
    ).toThrowError(/HTTPS and contain no credentials/);
  });
});

describe("Claude Code base URL derivation", () => {
  it("strips the messages path so Claude Code can append its own", () => {
    expect(
      protocolRootUrl(
        "https://api.apexnova.example/anthropic/v1/messages",
        "anthropic-messages",
      ),
    ).toBe("https://api.apexnova.example/anthropic");
  });

  it("plans the derived root, not the raw catalog endpoint", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "settings.json");
    const integration = createClaudeCodeIntegration({
      runVersionCommand: async () => ({ found: true, stdout: "2.1.261" }),
    });
    const withConfig: IntegrationContext = { ...context(root), configPath };
    const detection = await integration.detect(withConfig);
    if (detection.status === "not-found" || detection.status === "unsupported") {
      throw new TypeError("Expected Claude Code to be available.");
    }

    const plan = await integration.plan(
      withConfig,
      detection,
      await integration.inspect(withConfig, detection),
      {
        planId: "plan.derive",
        createdAt: "2026-09-07T12:00:00.000Z",
        deploymentId: "deployment.nova",
        inferenceAlias: "nova-coder",
        protocol: "anthropic-messages",
        baseUrl: "https://api.apexnova.example/anthropic/v1/messages",
        apiKeyEnvironmentVariable: "ANTHROPIC_AUTH_TOKEN",
      },
    );

    expect(plan.operations[0]!.content).toContain(
      '"ANTHROPIC_BASE_URL": "https://api.apexnova.example/anthropic"',
    );
    expect(plan.operations[0]!.content).not.toContain("/v1/messages");
  });
});
