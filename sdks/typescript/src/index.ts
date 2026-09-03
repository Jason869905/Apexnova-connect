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
} from "./types.js";

export type {
  ApplyReceipt,
  ChangeApproval,
  ChangeExecutor,
  ChangeOperation,
  ChangePlan,
  DetectionResult,
  InspectionResult,
  IntegrationAdapter,
  IntegrationContext,
  VerificationResult,
  WriteFileOperation,
} from "./lifecycle.js";

export {
  assertIntegrationManifest,
  validateIntegrationManifest,
} from "./validate-manifest.js";
