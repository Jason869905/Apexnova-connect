export {
  IntegrationChangeError,
  runIntegrationChange,
  type IntegrationChangePhase,
  type IntegrationChangeResult,
  type RunIntegrationChangeOptions,
} from "./run-integration-change.js";

export {
  createIntegrationRegistry,
  detectAgent,
  IntegrationRegistryError,
  type IntegrationRegistry,
  type IntegrationRegistryErrorCode,
} from "./registry.js";

export {
  satisfiesVersionRange,
  VersionRangeError,
} from "./version-range.js";
