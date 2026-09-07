import { readFileSync } from "node:fs";

import { describeIntegrationContract } from "@apexnova-connect/integration-testing";

import { createCodexIntegration } from "../src/index.js";

const manifestJson: unknown = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);

describeIntegrationContract({
  integration: createCodexIntegration({
    runVersionCommand: async () => ({ found: true, stdout: "codex-cli 0.52.0\n" }),
    pathExists: () => true,
  }),
  manifestJson,
  configFileName: "config.toml",
  intent: {
    planId: "plan.codex-contract",
    createdAt: "2026-09-07T12:00:00.000Z",
    deploymentId: "deployment.nova",
    inferenceAlias: "nova-coder",
    modelName: "Nova Coder",
    protocol: "openai-responses",
    baseUrl: "https://api.apexnova.example/v1/responses",
    apiKeyEnvironmentVariable: "APEXNOVA_API_KEY",
  },
  unsupportedConfigs: [
    {
      label: "a config.toml that is not valid TOML",
      content: 'model = "must-not-leak\n[unterminated\n',
      status: "invalid",
    },
  ],
  preservedConfig: {
    content: `# Keep this comment.
approval_policy = "on-request"

[model_providers.other]
name = "Other"
base_url = "https://other.example/v1"
env_key = "OTHER_KEY"
`,
    mustContain: [
      "# Keep this comment.",
      'approval_policy = "on-request"',
      "[model_providers.other]",
      'env_key = "OTHER_KEY"',
    ],
  },
  unsupportedProtocol: "openai-chat-completions",
});
