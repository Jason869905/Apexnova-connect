import { readFileSync } from "node:fs";

import { describeIntegrationContract } from "@apexnova-connect/integration-testing";

import { createHermesIntegration } from "../src/index.js";

const manifestJson: unknown = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);

describeIntegrationContract({
  integration: createHermesIntegration({
    runVersionCommand: async () => ({
      found: true,
      stdout: "Hermes Agent v0.21.0 (2026.8.31) · upstream a7198a88\n",
    }),
  }),
  manifestJson,
  configFileName: "config.yaml",
  intent: {
    planId: "plan.hermes-contract",
    createdAt: "2026-09-07T12:00:00.000Z",
    deploymentId: "deployment.nova",
    inferenceAlias: "nova-coder",
    modelName: "Nova Coder",
    protocol: "openai-chat-completions",
    baseUrl: "https://api.apexnova.example/v1/chat/completions",
    apiKeyEnvironmentVariable: "APEXNOVA_API_KEY",
  },
  unsupportedConfigs: [
    {
      label: "a config.yaml that is not valid YAML",
      content: "model:\n  default: must-not-leak\n   bad_indent: true\n",
      status: "invalid",
    },
    {
      label: "a config.yaml whose model section is not a mapping",
      content: "model: must-not-leak\n",
      status: "invalid",
    },
  ],
  preservedConfig: {
    content: `# Keep this comment.
model:
  default: anthropic/claude-opus-4.6
  provider: auto
  base_url: https://openrouter.ai/api/v1
agent:
  max_turns: 150
  reasoning_effort: medium
`,
    mustContain: [
      "# Keep this comment.",
      "max_turns: 150",
      "reasoning_effort: medium",
    ],
  },
});
