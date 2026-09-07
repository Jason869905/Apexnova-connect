import { readFileSync } from "node:fs";

import { describeIntegrationContract } from "@apexnova-connect/integration-testing";

import { createOpenCodeIntegration } from "../src/index.js";

const manifestJson: unknown = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);

describeIntegrationContract({
  integration: createOpenCodeIntegration({
    runVersionCommand: async () => ({ found: true, stdout: "opencode 1.18.29\n" }),
    pathExists: () => true,
  }),
  manifestJson,
  configFileName: "opencode.jsonc",
  intent: {
    planId: "plan.opencode-contract",
    createdAt: "2026-09-07T12:00:00.000Z",
    deploymentId: "deployment.nova",
    inferenceAlias: "nova-coder",
    modelName: "Nova Coder",
    protocol: "openai-responses",
    baseUrl: "https://api.apexnova.example/v1/responses",
    apiKeyEnvironmentVariable: "APEXNOVA_API_KEY",
    limits: { context: 128000, output: 8192 },
  },
  unsupportedConfigs: [
    {
      label: "the removed plural providers schema",
      content: '{ "providers": { "apexnova": { "secret": "must-not-leak" } } }\n',
      status: "legacy",
    },
    {
      label: "a truncated configuration file",
      content: '{ "model": "must-not-leak",\n',
      status: "invalid",
    },
  ],
  preservedConfig: {
    content: '{\n  // Keep this user setting.\n  "theme": "system",\n}\n',
    mustContain: ["// Keep this user setting.", '"theme": "system"'],
  },
  unsupportedProtocol: "anthropic-messages",
});
