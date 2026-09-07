import type { IntegrationManifest } from "@apexnova-connect/integration-sdk";

/**
 * Source of truth for the Claude Code manifest; `manifest.json` beside this
 * package is the language-neutral copy and the contract test asserts they never
 * drift.
 */
export const claudeCodeManifest: IntegrationManifest = {
  "$schema": "../../../schemas/integration-manifest.schema.json",
  "schemaVersion": "1",
  "id": "claude-code",
  "displayName": "Claude Code",
  "description": "Point Claude Code at Apexnova AI Hub through its documented LLM gateway settings.",
  "version": "0.1.0",
  "status": "experimental",
  "category": "agent",
  "delivery": {
    "modes": [
      "config-adapter",
      "launcher"
    ]
  },
  "compatibility": {
    "platforms": [
      "windows",
      "macos",
      "linux"
    ],
    "products": [
      {
        "name": "Claude Code",
        "versionRange": ">=2.0.0 <3.0.0",
        "documentation": "https://code.claude.com/docs/en/llm-gateway-connect"
      }
    ]
  },
  "protocols": [
    {
      "id": "anthropic-messages",
      "transport": "direct"
    }
  ],
  "capabilities": [
    "authentication",
    "balance",
    "model-catalog",
    "provider-config",
    "restart-required",
    "backup-and-restore"
  ],
  "permissions": [
    {
      "kind": "filesystem-write",
      "reason": "Writes the gateway base URL and model into the user's Claude Code settings file."
    },
    {
      "kind": "network",
      "reason": "Calls Apexnova AI Hub OAuth, control-plane, and inference endpoints."
    },
    {
      "kind": "credential-store",
      "reason": "Stores OAuth tokens and runtime credentials in the OS credential backend."
    },
    {
      "kind": "process-launch",
      "reason": "Launches Claude Code with a runtime credential injected via environment."
    }
  ],
  "links": {
    "documentation": "https://code.claude.com/docs/en/llm-gateway-connect",
    "repository": "https://github.com/anthropics/claude-code"
  }
};
