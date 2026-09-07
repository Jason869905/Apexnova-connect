import type { IntegrationManifest } from "@apexnova-connect/integration-sdk";

/**
 * Source of truth for the Codex manifest; `manifest.json` beside this package
 * is the language-neutral copy and the contract test asserts they never drift.
 */
export const codexManifest: IntegrationManifest = {
  $schema: "../../../schemas/integration-manifest.schema.json",
  schemaVersion: "1",
  id: "codex",
  displayName: "Codex",
  description:
    "Connect the Codex CLI's custom model provider to models served by Apexnova AI Hub.",
  version: "0.1.0",
  status: "experimental",
  category: "agent",
  delivery: {
    modes: ["config-adapter", "launcher"],
  },
  compatibility: {
    platforms: ["windows", "macos", "linux"],
    products: [
      {
        name: "Codex CLI",
        versionRange: ">=0.20.0",
        documentation: "https://learn.chatgpt.com/docs/config-file/config-reference",
      },
    ],
  },
  protocols: [{ id: "openai-responses", transport: "direct" }],
  capabilities: [
    "authentication",
    "balance",
    "model-catalog",
    "provider-config",
    "restart-required",
    "backup-and-restore",
  ],
  permissions: [
    {
      kind: "filesystem-write",
      reason: "Writes the Apexnova model provider into the user's Codex config.toml.",
    },
    {
      kind: "network",
      reason: "Calls Apexnova AI Hub OAuth, control-plane, and inference endpoints.",
    },
    {
      kind: "credential-store",
      reason: "Stores OAuth tokens and runtime credentials in the OS credential backend.",
    },
    {
      kind: "process-launch",
      reason: "Launches Codex with a runtime credential injected via environment.",
    },
  ],
  links: {
    documentation: "https://learn.chatgpt.com/docs/config-file/config-reference",
    repository: "https://github.com/openai/codex",
  },
};
