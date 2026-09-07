import type { AgentIntegration } from "@apexnova-connect/integration-sdk";
import { claudeCodeIntegration } from "@apexnova-connect/integration-claude-code";
import { codexIntegration } from "@apexnova-connect/integration-codex";
import { openCodeIntegration } from "@apexnova-connect/integration-opencode";

/**
 * The Agent integrations this build ships with. Adding an Agent to the CLI is
 * one entry here plus its own package; nothing else in `apps/cli` names a
 * product.
 */
export function defaultAgentIntegrations(): readonly AgentIntegration[] {
  return [openCodeIntegration, codexIntegration, claudeCodeIntegration];
}
