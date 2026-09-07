import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IntegrationContext } from "@apexnova-connect/integration-sdk";

import {
  detectHermes,
  envFileDefines,
  hermesApiMode,
  inspectHermes,
  planHermesConfig,
} from "../src/index.js";

const testRoots: string[] = [];

async function createTestRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apexnova-hermes-"));
  testRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of testRoots.splice(0)) {
    const resolvedTemp = await realpath(tmpdir());
    if (
      (await realpath(dirname(root))) !== resolvedTemp ||
      !basename(root).startsWith("apexnova-hermes-")
    ) {
      throw new Error(`Refusing to remove unexpected test directory: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
});

const planBase = {
  planId: "plan.hermes",
  createdAt: "2026-09-07T12:00:00.000Z",
  configPath: "/home/tester/.hermes/config.yaml",
  hubBaseUrl: "https://api.apexnova.example/v1",
  modelId: "nova-coder",
  apiMode: "chat_completions",
} as const;

// The shape a real v0.21.0 install ships with.
const REAL_CONFIG = `model:
  default: anthropic/claude-opus-4.6
  provider: auto
  base_url: https://openrouter.ai/api/v1
database:
  journal_mode: wal
agent:
  max_turns: 150
  reasoning_effort: medium

# ── Fallback Model ────────────────────────────────────────────────────
# fallback_model:
#   provider: openrouter
`;

function context(root: string, overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return {
    platform: "linux",
    workingDirectory: root,
    homeDirectory: join(root, "home"),
    environment: {},
    ...overrides,
  };
}

describe("Hermes discovery", () => {
  it("reads the version banner a real install prints", async () => {
    const root = await createTestRoot();

    const detection = await detectHermes(context(root), async () => ({
      found: true,
      stdout: "Hermes Agent v0.21.0 (2026.8.31) · upstream a7198a88\n",
    }));

    expect(detection.productVersion).toBe("0.21.0");
    expect(detection.configPath).toBe(join(root, "home", ".hermes", "config.yaml"));
  });

  it("honours HERMES_HOME", async () => {
    const root = await createTestRoot();

    const detection = await detectHermes(
      context(root, { environment: { HERMES_HOME: join(root, "profile-two") } }),
      async () => ({ found: false }),
    );

    expect(detection.configPath).toBe(join(root, "profile-two", "config.yaml"));
  });

  it("treats the stock OpenRouter default as not ours", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "config.yaml");
    await writeFile(configPath, REAL_CONFIG, "utf8");

    const inspection = await inspectHermes({ configPath, configExists: true });

    expect(inspection.status).toBe("configured");
    expect(inspection.managed).toBe(false);
    expect(inspection.connection?.modelIds).toEqual([]);
    expect(inspection.warnings[0]).toContain("did not write");
  });

  it("does not put configuration content into a parse warning", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "config.yaml");
    await writeFile(configPath, "model:\n  default: must-not-leak\n   bad: true\n", "utf8");

    const inspection = await inspectHermes({ configPath, configExists: true });

    expect(inspection.status).toBe("invalid");
    expect(JSON.stringify(inspection)).not.toContain("must-not-leak");
  });
});

describe("Hermes .env precedence", () => {
  it("detects the credential variable by name without reading any value", async () => {
    const root = await createTestRoot();
    const envPath = join(root, ".env");
    await writeFile(
      envPath,
      "# comment\nOPENROUTER_API_KEY=sk-other-must-not-leak\nexport APEXNOVA_API_KEY=sk-must-not-leak\n",
      "utf8",
    );

    expect(await envFileDefines(envPath, "APEXNOVA_API_KEY")).toBe(true);
    expect(await envFileDefines(envPath, "ANTHROPIC_API_KEY")).toBe(false);
    expect(await envFileDefines(join(root, "missing.env"), "APEXNOVA_API_KEY")).toBeUndefined();
  });

  it("warns that a .env definition overrides the injected credential", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "config.yaml");
    await writeFile(
      configPath,
      planHermesConfig({ ...planBase, existingContent: null }).operations[0]!.content,
      "utf8",
    );

    const inspection = await inspectHermes(
      { configPath, configExists: true },
      { envDefinesCredential: true },
    );

    expect(inspection.managed).toBe(true);
    expect(inspection.warnings.join(" ")).toContain("over the process environment");
    expect(JSON.stringify(inspection)).not.toContain("sk-");
  });
});

describe("planHermesConfig", () => {
  it("keeps comments and every unrelated section", () => {
    const content = planHermesConfig({
      ...planBase,
      existingContent: REAL_CONFIG,
    }).operations[0]!.content;

    expect(content).toContain("# ── Fallback Model");
    expect(content).toContain("#   provider: openrouter");
    expect(content).toContain("journal_mode: wal");
    expect(content).toContain("max_turns: 150");
    expect(content).toContain("reasoning_effort: medium");
  });

  it("writes the five endpoint keys the official wizard writes", () => {
    const content = planHermesConfig({
      ...planBase,
      existingContent: REAL_CONFIG,
    }).operations[0]!.content;

    expect(content).toContain("default: nova-coder");
    expect(content).toContain("provider: custom");
    expect(content).toContain("base_url: https://api.apexnova.example/v1");
    expect(content).toContain("api_key: ${APEXNOVA_API_KEY}");
    expect(content).toContain("api_mode: chat_completions");
    expect(content).not.toContain("openrouter.ai/api/v1");
  });

  it("never writes a secret and warns about the .env override", () => {
    const plan = planHermesConfig({ ...planBase, existingContent: null });

    expect(plan.operations[0]!.containsSecrets).toBe(false);
    expect(plan.requiresRestart).toBe(true);
    expect(plan.warnings.join(" ")).toContain(".env");
    expect(plan.warnings.join(" ")).toContain("override");
  });

  it("is a no-op once applied", () => {
    const first = planHermesConfig({ ...planBase, existingContent: REAL_CONFIG });
    const second = planHermesConfig({
      ...planBase,
      existingContent: first.operations[0]!.content,
    });

    expect(second.operations).toHaveLength(0);
  });

  it("maps each protocol onto the api_mode Hermes accepts", () => {
    expect(hermesApiMode("openai-responses")).toBe("codex_responses");
    expect(hermesApiMode("openai-chat-completions")).toBe("chat_completions");
    expect(hermesApiMode("anthropic-messages")).toBe("anthropic_messages");
  });

  it("refuses a base URL carrying credentials", () => {
    expect(() =>
      planHermesConfig({
        ...planBase,
        existingContent: null,
        hubBaseUrl: "https://user:secret@api.apexnova.example/v1",
      }),
    ).toThrowError(/HTTPS and contain no credentials/);
  });
});
