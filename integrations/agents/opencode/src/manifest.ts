import type { IntegrationManifest } from "@apexnova-connect/integration-sdk";

/**
 * Source of truth for the OpenCode manifest. `manifest.json` next to this
 * package is the language-neutral copy; the contract test asserts the two never
 * drift. The bundled CLI cannot read a JSON file at runtime, which is why the
 * TypeScript copy is the one the adapter loads.
 */
export const openCodeManifest: IntegrationManifest = {
  $schema: "../../../schemas/integration-manifest.schema.json",
  schemaVersion: "1",
  id: "opencode",
  displayName: "OpenCode",
  description:
    "Connect OpenCode provider configuration to models served by Apexnova AI Hub.",
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
        name: "OpenCode",
        versionRange: ">=1.18.29 <2.0.0",
        documentation: "https://opencode.ai/docs/providers/",
      },
    ],
  },
  protocols: [
    { id: "openai-responses", transport: "direct" },
    { id: "openai-chat-completions", transport: "direct" },
  ],
  capabilities: [
    "authentication",
    "balance",
    "model-catalog",
    "provider-config",
    "hot-switch",
    "restart-required",
    "backup-and-restore",
  ],
  permissions: [
    {
      kind: "filesystem-write",
      reason: "Writes OpenCode provider configuration to the user config file.",
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
      reason: "Launches OpenCode with a runtime credential injected via environment.",
    },
  ],
  links: {
    documentation: "https://opencode.ai/docs/providers/",
    repository: "https://github.com/anomalyco/opencode",
  },
};
