export {
  CORE_CAPABILITIES,
  CORE_CATEGORIES,
  CORE_DELIVERY_MODES,
  CORE_PERMISSION_KINDS,
  CORE_PLATFORMS,
  CORE_PROTOCOLS,
  INTEGRATION_SCHEMA_VERSION,
  INTEGRATION_STATUSES,
} from "./constants.js";

export type {
  CoreCapability,
  CoreCategory,
  CoreDeliveryMode,
  CorePermissionKind,
  CorePlatform,
  CoreProtocol,
  DeliveryMode,
  ExtensionId,
  IntegrationCapability,
  IntegrationCategory,
  IntegrationLinks,
  IntegrationManifest,
  IntegrationPermission,
  IntegrationProtocol,
  IntegrationSchemaVersion,
  IntegrationStatus,
  ManifestValidationIssue,
  ManifestValidationResult,
  PermissionKind,
  Platform,
  ProductCompatibility,
  ProtocolId,
  SchemaValidationIssue,
  SchemaValidationResult,
} from "./types.js";

export { isDetectionAvailable } from "./lifecycle.js";

export type {
  ApplyReceipt,
  AvailableDetection,
  ChangeApproval,
  ChangeExecutor,
  ChangeOperation,
  ChangePlan,
  ConfigScope,
  DetectionResult,
  DetectionStatus,
  IntegrationAdapter,
  IntegrationContext,
  MissingDetection,
  UnsupportedDetection,
  VerificationResult,
  WriteFileOperation,
} from "./lifecycle.js";

export { AgentIntegrationError } from "./agent.js";

export type {
  AgentInspection,
  AgentIntegration,
  ConnectionIntent,
  DiagnosticCheck,
  InspectionStatus,
  LaunchPlan,
  LaunchRequest,
  ManagedConnection,
  ModelLimits,
} from "./agent.js";

export { assertSafeBaseUrl, protocolRootUrl } from "./protocol-url.js";

export { probeExecutableVersion, toPlatform } from "./process-probe.js";

export type {
  CommandProbe,
  CommandProbeResult,
  ExecutableProbe,
  ProbeExecutableOptions,
} from "./process-probe.js";

export {
  AGENT_CONTRACT_SCHEMA_VERSION,
  assertDetectionDocument,
  assertInspectionDocument,
  toDetectionDocument,
  toInspectionDocument,
  validateDetectionDocument,
  validateInspectionDocument,
} from "./validate-agent-contract.js";

export type {
  DetectionResultDocument,
  InspectionResultDocument,
} from "./validate-agent-contract.js";

export {
  assertIntegrationManifest,
  validateIntegrationManifest,
} from "./validate-manifest.js";
