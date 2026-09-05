import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectOpenCode, inspectOpenCode } from "../src/index.js";

const testRoots: string[] = [];

async function createTestRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apexnova-opencode-discovery-"));
  testRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of testRoots.splice(0)) {
    const resolvedTemp = await realpath(tmpdir());
    if (
      (await realpath(dirname(root))) !== resolvedTemp ||
      !basename(root).startsWith("apexnova-opencode-discovery-")
    ) {
      throw new Error(`Refusing to remove unexpected test directory: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("OpenCode discovery", () => {
  it("detects an executable and a project JSONC configuration", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, "{ // valid\n}\n", "utf8");

    const result = await detectOpenCode({
      cwd: root,
      homeDirectory: join(root, "home"),
      environment: {},
      platform: "linux",
      runVersionCommand: async () => ({ found: true, stdout: "opencode 2.4.1\n" }),
    });

    expect(result).toMatchObject({
      status: "installed",
      productVersion: "2.4.1",
      configPath,
      configExists: true,
      configScope: "project",
    });
  });

  it("reports config-only without guessing that the executable exists", async () => {
    const root = await createTestRoot();
    const configRoot = join(root, "xdg", "opencode");
    await mkdir(configRoot, { recursive: true });
    await writeFile(join(configRoot, "opencode.json"), "{}\n", "utf8");

    const result = await detectOpenCode({
      cwd: root,
      homeDirectory: join(root, "home"),
      environment: { XDG_CONFIG_HOME: join(root, "xdg") },
      platform: "linux",
      runVersionCommand: async () => ({ found: false }),
    });

    expect(result.status).toBe("config-only");
    expect(result.configScope).toBe("global");
    expect(result.configExists).toBe(true);
  });

  it("uses an explicit absent path as the preferred future configuration", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "custom", "opencode.jsonc");
    const result = await detectOpenCode({
      cwd: root,
      homeDirectory: join(root, "home"),
      environment: {},
      configPath,
      runVersionCommand: async () => ({ found: true, stdout: "2.0.0" }),
    });

    expect(result.configPath).toBe(configPath);
    expect(result.configExists).toBe(false);
    expect(result.configScope).toBe("explicit");
  });
});

describe("OpenCode inspection", () => {
  it("returns only managed provider metadata and never the whole config", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "opencode.jsonc");
    await writeFile(
      configPath,
      `{
  // unrelated user setting
  "theme": "system",
  "model": "apexnova/nova-coder",
  "provider": {
    "apexnova": {
      "name": "Apexnova AI Hub",
      "env": ["APEXNOVA_API_KEY"],
      "npm": "@ai-sdk/openai",
      "options": { "apiKey": "{env:APEXNOVA_API_KEY}", "baseURL": "https://api.example.test/v1" },
      "models": { "nova-coder": { "name": "Nova Coder" } }
    }
  }
}
`,
      "utf8",
    );
    const detection = await detectOpenCode({
      cwd: root,
      configPath,
      runVersionCommand: async () => ({ found: true, stdout: "2.1.0" }),
    });

    const result = await inspectOpenCode(detection);

    expect(result).toEqual({
      agentId: "opencode",
      configPath,
      status: "configured",
      managed: true,
      provider: {
        id: "apexnova",
        name: "Apexnova AI Hub",
        npm: "@ai-sdk/openai",
        protocol: "openai-responses",
        baseUrl: "https://api.example.test/v1",
        environmentVariables: ["APEXNOVA_API_KEY"],
        modelIds: ["nova-coder"],
        defaultModelId: "nova-coder",
      },
      warnings: [],
    });
    expect(JSON.stringify(result)).not.toContain("theme");
  });

  it("reports legacy and invalid configurations without returning their content", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "opencode.json");
    const baseDetection = {
      agentId: "opencode" as const,
      displayName: "OpenCode" as const,
      status: "installed" as const,
      configPath,
      configExists: true,
      configScope: "explicit" as const,
      evidence: [],
      warnings: [],
    };

    await writeFile(configPath, '{ "providers": {} }\n', "utf8");
    expect((await inspectOpenCode(baseDetection)).status).toBe("legacy");

    await writeFile(configPath, '{ "secret": "must-not-leak",', "utf8");
    const invalid = await inspectOpenCode(baseDetection);
    expect(invalid.status).toBe("invalid");
    expect(JSON.stringify(invalid)).not.toContain("must-not-leak");
  });

  it("removes credentials and query tokens from a displayed base URL", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          apexnova: {
            options: { baseURL: "https://user:secret@example.test/v1?api_key=hidden#token" },
            models: {},
          },
        },
      }),
      "utf8",
    );
    const result = await inspectOpenCode({
      agentId: "opencode",
      displayName: "OpenCode",
      status: "installed",
      configPath,
      configExists: true,
      configScope: "explicit",
      evidence: [],
      warnings: [],
    });

    expect(result.provider?.baseUrl).toBe("https://example.test/v1");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(result.warnings).toHaveLength(1);
  });
});
