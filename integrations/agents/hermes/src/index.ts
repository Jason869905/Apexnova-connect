export {
  environmentReference,
  hermesApiMode,
  parseHermesConfig,
  planHermesConfig,
  HermesConfigError,
  HERMES_PROVIDER_ID,
  type HermesApiMode,
  type HermesConfigErrorCode,
  type PlanHermesConfigOptions,
} from "./hermes-config.js";

export {
  detectHermes,
  envFileDefines,
  hermesConfigRoots,
  hermesEnvPath,
  inspectHermes,
  readHermesConfig,
  HermesInspectionError,
  HERMES_AGENT_ID,
  HERMES_CREDENTIAL_VARIABLE,
  HERMES_DISPLAY_NAME,
  HERMES_EXECUTABLE,
  type HermesInspectionErrorCode,
  type HermesInspectionTarget,
} from "./discovery.js";

export { hermesManifest } from "./manifest.js";

export {
  createHermesIntegration,
  hermesIntegration,
  type HermesIntegrationOptions,
} from "./adapter.js";
