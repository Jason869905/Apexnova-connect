import { readFileSync } from "node:fs";

import { describeIntegrationContract } from "@apexnova-connect/integration-testing";

import { createExampleAgentIntegration } from "../src/index.js";

const manifestJson: unknown = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);

describeIntegrationContract({
  integration: createExampleAgentIntegration({
    runVersionCommand: async () => ({ found: true, stdout: "example-agent 1.4.0\n" }),
  }),
  manifestJson,
  configFileName: "config.json",
  readOnly: true,
  intent: {
    planId: "plan.example-agent-contract",
    createdAt: "2026-09-07T12:00:00.000Z",
    deploymentId: "deployment.nova",
    inferenceAlias: "nova-coder",
    protocol: "openai-responses",
    baseUrl: "https://api.apexnova.example/v1/responses",
    apiKeyEnvironmentVariable: "EXAMPLE_AGENT_API_KEY",
  },
  unsupportedConfigs: [
    {
      label: "a configuration file that is not valid JSON",
      content: '{ "provider": "must-not-leak",\n',
      status: "invalid",
    },
  ],
});
