export {
  planClaudeCodeSettings,
  parseClaudeCodeSettings,
  settingsEnvironment,
  ClaudeCodeConfigError,
  BASE_URL_KEY,
  CLAUDE_CODE_PROVIDER_ID,
  MANAGED_MARKER_KEY,
  MANAGED_MARKER_VALUE,
  MODEL_KEY,
  type ClaudeCodeConfigErrorCode,
  type PlanClaudeCodeSettingsOptions,
} from "./claude-code-settings.js";

export {
  claudeCodeConfigRoots,
  detectClaudeCode,
  inspectClaudeCode,
  readClaudeCodeSettings,
  ClaudeCodeInspectionError,
  CLAUDE_CODE_AGENT_ID,
  CLAUDE_CODE_CREDENTIAL_VARIABLE,
  CLAUDE_CODE_DISPLAY_NAME,
  CLAUDE_CODE_EXECUTABLE,
  type ClaudeCodeInspectionErrorCode,
  type ClaudeCodeInspectionTarget,
} from "./discovery.js";

export { claudeCodeManifest } from "./manifest.js";

export {
  createClaudeCodeIntegration,
  claudeCodeIntegration,
  resolveClaudeCodeExecutable,
  type ClaudeCodeIntegrationOptions,
} from "./adapter.js";
