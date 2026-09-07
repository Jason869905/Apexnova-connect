import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IntegrationContext } from "@apexnova-connect/integration-sdk";
import { AgentIntegrationError } from "@apexnova-connect/integration-sdk";

import {
  detectCodex,
  inspectCodex,
  planCodexConfig,
} from "../src/index.js";

const testRoots: string[] = [];

async function createTestRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apexnova-codex-"));
  testRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of testRoots.splice(0)) {
    const resolvedTemp = await realpath(tmpdir());
    if (
      (await realpath(dirname(root))) !== resolvedTemp ||
      !basename(root).startsWith("apexnova-codex-")
    ) {
      throw new Error(`Refusing to remove unexpected test directory: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
});

const planBase = {
  planId: "plan.codex",
  createdAt: "2026-09-07T12:00:00.000Z",
  configPath: "/home/tester/.codex/config.toml",
  hubBaseUrl: "https://api.apexnova.example/v1",
  modelId: "nova-coder",
} as const;

function context(root: string, overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return {
    platform: "linux",
    workingDirectory: root,
    homeDirectory: join(root, "home"),
    environment: {},
    ...overrides,
  };
}

describe("Codex discovery", () => {
  it("prefers CODEX_HOME over the default user directory", async () => {
    const root = await createTestRoot();
    const codexHome = join(root, "custom-codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    await mkdir(join(root, "home", ".codex"), { recursive: true });
    await writeFile(join(root, "home", ".codex", "config.toml"), "", "utf8");

    const detection = await detectCodex(
      context(root, { environment: { CODEX_HOME: codexHome } }),
      async () => ({ found: true, stdout: "codex-cli 0.52.0" }),
    );

    expect(detection.configPath).toBe(join(codexHome, "config.toml"));
    expect(detection.configScope).toBe("global");
    expect(detection.productVersion).toBe("0.52.0");
  });

  it("never targets a project .codex directory", async () => {
    const root = await createTestRoot();
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, ".codex", "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const detection = await detectCodex(context(root), async () => ({ found: false }));

    expect(detection.configPath).toBe(join(root, "home", ".codex", "config.toml"));
    expect(detection.configExists).toBe(false);
  });

  it("warns when the Apexnova provider is present but not selected", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "config.toml");
    await writeFile(
      configPath,
      `model = "gpt-5.5"
model_provider = "openai"

[model_providers.apexnova]
name = "Apexnova AI Hub"
base_url = "https://api.apexnova.example/v1"
env_key = "APEXNOVA_API_KEY"
wire_api = "responses"
`,
      "utf8",
    );

    const inspection = await inspectCodex({ configPath, configExists: true });

    expect(inspection.status).toBe("configured");
    expect(inspection.managed).toBe(true);
    expect(inspection.connection?.modelIds).toEqual([]);
    expect(inspection.warnings[0]).toContain("openai");
  });

  it("does not put configuration content into a parse warning", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "config.toml");
    await writeFile(configPath, 'model = "sk-must-not-leak\n[broken\n', "utf8");

    const inspection = await inspectCodex({ configPath, configExists: true });

    expect(inspection.status).toBe("invalid");
    expect(JSON.stringify(inspection)).not.toContain("must-not-leak");
  });
});

describe("planCodexConfig", () => {
  it("replaces an existing Apexnova table instead of appending a second one", () => {
    const existing = `model = "old-model"
model_provider = "apexnova"

[model_providers.apexnova]
name = "Apexnova AI Hub"
base_url = "https://stale.example/v1"
env_key = "APEXNOVA_API_KEY"
wire_api = "responses"

[model_providers.other]
name = "Other"
base_url = "https://other.example/v1"
env_key = "OTHER_KEY"
`;

    const plan = planCodexConfig({ ...planBase, existingContent: existing });
    const content = plan.operations[0]!.content;

    expect(content.match(/\[model_providers\.apexnova\]/g)).toHaveLength(1);
    expect(content).toContain('base_url = "https://api.apexnova.example/v1"');
    expect(content).not.toContain("stale.example");
    expect(content).toContain("[model_providers.other]");
    expect(content).toContain('env_key = "OTHER_KEY"');
    expect(content).toContain('model = "nova-coder"');
    expect(content).not.toContain("old-model");
  });

  it("keeps CRLF line endings", () => {
    const plan = planCodexConfig({
      ...planBase,
      existingContent: '# windows\r\napproval_policy = "on-request"\r\n',
    });
    const content = plan.operations[0]!.content;

    expect(content).toContain("\r\n");
    expect(content.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
  });

  it("never writes a secret and always refers to the environment variable", () => {
    const plan = planCodexConfig({ ...planBase, existingContent: null });

    expect(plan.operations[0]!.containsSecrets).toBe(false);
    expect(plan.operations[0]!.content).toContain('env_key = "APEXNOVA_API_KEY"');
    expect(plan.operations[0]!.content).not.toMatch(/api_?key\s*=/i);
    expect(plan.requiresRestart).toBe(true);
  });

  it("pins wire_api to responses", () => {
    const plan = planCodexConfig({ ...planBase, existingContent: null });

    expect(plan.operations[0]!.content).toContain('wire_api = "responses"');
  });

  it("refuses a base URL carrying credentials or a query", () => {
    expect(() =>
      planCodexConfig({
        ...planBase,
        existingContent: null,
        hubBaseUrl: "https://user:secret@api.apexnova.example/v1?token=leak",
      }),
    ).toThrowError(/HTTPS and contain no credentials/);
  });

  it("refuses plain HTTP unless loopback is explicitly allowed", () => {
    expect(() =>
      planCodexConfig({ ...planBase, existingContent: null, hubBaseUrl: "http://api.localhost:3000/v1" }),
    ).toThrowError(AgentIntegrationError);

    expect(
      planCodexConfig({
        ...planBase,
        existingContent: null,
        hubBaseUrl: "http://api.localhost:3000/v1",
        allowInsecureLoopback: true,
      }).operations,
    ).toHaveLength(1);
  });

  it("refuses a layout it cannot edit safely rather than guessing", () => {
    expect(() =>
      planCodexConfig({
        ...planBase,
        existingContent: 'model_providers = { apexnova = { name = "Inline" } }\n',
      }),
    ).toThrowError(/cannot edit safely/);
  });

  it("refuses a relative configuration path", () => {
    expect(() =>
      planCodexConfig({ ...planBase, configPath: ".codex/config.toml", existingContent: null }),
    ).toThrowError(/must be absolute/);
  });
});
