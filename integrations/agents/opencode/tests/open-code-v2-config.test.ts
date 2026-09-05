import { readFileSync } from "node:fs";

import { assertIntegrationManifest } from "@apexnova-connect/integration-sdk";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import {
  OpenCodeConfigError,
  planOpenCodeV2Config,
  type OpenCodeModelInput,
} from "../src/index.js";

const models = [
  {
    id: "nova-coder",
    upstreamId: "vendor/nova-coder-v1",
    name: "Nova Coder",
    protocol: "openai-responses",
    limits: {
      context: 200_000,
      output: 64_000,
    },
  },
] satisfies readonly OpenCodeModelInput[];

function plan(existingContent: string | null = null) {
  return planOpenCodeV2Config({
    planId: "opencode-plan-1",
    createdAt: "2026-09-02T20:00:00.000Z",
    configPath: "/home/test/.config/opencode/opencode.jsonc",
    existingContent,
    hubBaseUrl: "https://api.apexnova.example/v1/",
    models,
    defaultModelId: "nova-coder",
  });
}

function plannedConfig(existingContent: string | null = null): Record<string, unknown> {
  const changePlan = plan(existingContent);
  const operation = changePlan.operations[0];
  if (!operation || operation.type !== "write-file") {
    throw new TypeError("Expected a write-file operation.");
  }
  return parse(operation.content) as Record<string, unknown>;
}

describe("planOpenCodeV2Config", () => {
  it("ships a valid integration manifest", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
    );

    expect(() => assertIntegrationManifest(manifest)).not.toThrow();
  });

  it("creates a current OpenCode provider without embedding a credential value", () => {
    const changePlan = plan();
    const operation = changePlan.operations[0]!;
    const config = plannedConfig();

    expect(operation.mode).toBe("create");
    expect(operation.expectedContentHash).toBeNull();
    expect(operation.containsSecrets).toBe(false);
    expect(operation.content).toContain('"apiKey": "{env:APEXNOVA_API_KEY}"');
    expect(config).toMatchObject({
      model: "apexnova/nova-coder",
      provider: {
        apexnova: {
          name: "Apexnova AI Hub",
          env: ["APEXNOVA_API_KEY"],
          npm: "@ai-sdk/openai",
          options: {
            apiKey: "{env:APEXNOVA_API_KEY}",
            baseURL: "https://api.apexnova.example/v1",
          },
          models: {
            "nova-coder": {
              id: "vendor/nova-coder-v1",
              name: "Nova Coder",
              limit: { context: 200_000, output: 64_000 },
            },
          },
        },
      },
    });
  });

  it("preserves comments and unrelated settings", () => {
    const existing = `{
  // Keep the user's theme.
  "theme": "system",
}
`;
    const changePlan = plan(existing);
    const operation = changePlan.operations[0]!;

    expect(operation.content).toContain("// Keep the user's theme.");
    expect(plannedConfig(existing)).toMatchObject({ theme: "system" });
    expect(operation.expectedContentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("replaces only the managed provider entry", () => {
    const existing = `{
  "provider": {
    "other": { "name": "Other" },
    "apexnova": { "name": "Old value" }
  }
}
`;

    expect(plannedConfig(existing)).toMatchObject({
      provider: {
        other: { name: "Other" },
        apexnova: { name: "Apexnova AI Hub" },
      },
    });
  });

  it("returns an empty operation list when the managed configuration is unchanged", () => {
    const firstPlan = plan();
    const firstOperation = firstPlan.operations[0]!;
    const secondPlan = plan(firstOperation.content);

    expect(secondPlan.operations).toEqual([]);
  });

  it("uses the Chat Completions package for chat-only catalogs", () => {
    const changePlan = planOpenCodeV2Config({
      planId: "chat-plan",
      createdAt: "2026-09-02T20:00:00.000Z",
      configPath: "/tmp/opencode.jsonc",
      existingContent: null,
      hubBaseUrl: "https://api.apexnova.example/v1",
      models: [{ id: "chat", name: "Chat", protocol: "openai-chat-completions" }],
    });
    const operation = changePlan.operations[0]!;
    const config = parse(operation.content) as {
      provider: { apexnova: { npm: string } };
    };

    expect(config.provider.apexnova.npm).toBe(
      "@ai-sdk/openai-compatible",
    );
  });

  it("preserves existing providers in the current singular configuration", () => {
    expect(plannedConfig(`{ "provider": { "existing": { "name": "Existing" } } }`)).toMatchObject({
      provider: {
        existing: { name: "Existing" },
        apexnova: { name: "Apexnova AI Hub" },
      },
    });
  });

  it("rejects the unsupported plural provider configuration", () => {
    expect(() => plan(`{ "providers": { "existing": {} } }`)).toThrowError(
      expect.objectContaining<Partial<OpenCodeConfigError>>({ code: "LEGACY_CONFIG" }),
    );
  });

  it("rejects secret-bearing Hub base URLs instead of writing them to config", () => {
    expect(() => planOpenCodeV2Config({
      planId: "plan.secret-url",
      createdAt: "2026-09-04T12:00:00Z",
      configPath: "/tmp/opencode.jsonc",
      existingContent: null,
      hubBaseUrl: "https://user:secret@api.example.test/v1?token=secret",
      models,
    })).toThrow(expect.objectContaining<Partial<OpenCodeConfigError>>({ code: "INVALID_INPUT" }));
  });

  it("allows HTTP only for an explicitly enabled loopback Hub", () => {
    const input = {
      planId: "plan.loopback",
      createdAt: "2026-09-04T12:00:00Z",
      configPath: "/tmp/opencode.jsonc",
      existingContent: null,
      hubBaseUrl: "http://api.localhost:18080/v1",
      models,
    } as const;

    expect(() => planOpenCodeV2Config(input)).toThrow(expect.objectContaining<Partial<OpenCodeConfigError>>({ code: "INVALID_INPUT" }));
    const changePlan = planOpenCodeV2Config({ ...input, allowInsecureLoopback: true });
    expect(changePlan.operations[0]?.content).toContain('"baseURL": "http://api.localhost:18080/v1"');
  });

  it("rejects a catalog that mixes provider protocols", () => {
    expect(() =>
      planOpenCodeV2Config({
        planId: "mixed-plan",
        createdAt: "2026-09-02T20:00:00.000Z",
        configPath: "/tmp/opencode.jsonc",
        existingContent: null,
        hubBaseUrl: "https://api.apexnova.example/v1",
        models: [
          ...models,
          { id: "chat", name: "Chat", protocol: "openai-chat-completions" },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<OpenCodeConfigError>>({ code: "MIXED_PROTOCOLS" }),
    );
  });

  it("rejects an unknown default model", () => {
    expect(() =>
      planOpenCodeV2Config({
        planId: "default-plan",
        createdAt: "2026-09-02T20:00:00.000Z",
        configPath: "/tmp/opencode.jsonc",
        existingContent: null,
        hubBaseUrl: "https://api.apexnova.example/v1",
        models,
        defaultModelId: "missing-model",
      }),
    ).toThrow(/not present in the model catalog/);
  });
});
