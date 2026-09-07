export {
  OPENCODE_PROVIDER_ID,
  OPENCODE_PROVIDER_NAME,
  OpenCodeConfigError,
  planOpenCodeV2Config,
  type OpenCodeConfigErrorCode,
  type OpenCodeModelInput,
  type OpenCodeProtocol,
  type PlanOpenCodeV2ConfigOptions,
} from "./open-code-v2-config.js";

export {
  detectOpenCode,
  inspectOpenCode,
  openCodeConfigRoots,
  OpenCodeInspectionError,
  OPENCODE_AGENT_ID,
  OPENCODE_DISPLAY_NAME,
  OPENCODE_EXECUTABLE,
  type OpenCodeInspectionErrorCode,
  type OpenCodeInspectionTarget,
} from "./discovery.js";

export { openCodeManifest } from "./manifest.js";

export {
  createOpenCodeIntegration,
  openCodeIntegration,
  resolveOpenCodeExecutable,
  type OpenCodeIntegrationOptions,
} from "./adapter.js";
