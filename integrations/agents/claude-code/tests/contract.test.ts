import { readFileSync } from "node:fs";

import { describeIntegrationContract } from "@apexnova-connect/integration-testing";

import { createClaudeCodeIntegration } from "../src/index.js";

const manifestJson: unknown = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);

describeIntegrationContract({
  integration: createClaudeCodeIntegration({
    runVersionCommand: async () => ({ found: true, stdout: "2.1.261 (Claude Code)\n" }),
    pathExists: () => true,
  }),
  manifestJson,
  configFileName: "settings.json",
  intent: {
    planId: "plan.claude-code-contract",
    createdAt: "2026-09-07T12:00:00.000Z",
    deploymentId: "deployment.nova",
    inferenceAlias: "nova-coder",
    modelName: "Nova Coder",
    protocol: "anthropic-messages",
    baseUrl: "https://api.apexnova.example/anthropic/v1/messages",
    apiKeyEnvironmentVariable: "ANTHROPIC_AUTH_TOKEN",
  },
  unsupportedConfigs: [
    {
      label: "a settings file that is not valid JSON",
      content: '{ "model": "must-not-leak",\n',
      status: "invalid",
    },
    {
      label: "a settings file whose env block is not an object",
      content: '{ "env": "must-not-leak" }\n',
      status: "invalid",
    },
  ],
  preservedConfig: {
    content: '{\n  "model": "opus[1m]",\n  "tui": "fullscreen",\n  "theme": "dark"\n}\n',
    mustContain: ['"model": "opus[1m]"', '"tui": "fullscreen"', '"theme": "dark"'],
  },
  unsupportedProtocol: "openai-responses",
});
