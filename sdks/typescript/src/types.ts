import type {
  CORE_CAPABILITIES,
  CORE_CATEGORIES,
  CORE_DELIVERY_MODES,
  CORE_PERMISSION_KINDS,
  CORE_PLATFORMS,
  CORE_PROTOCOLS,
  INTEGRATION_SCHEMA_VERSION,
  INTEGRATION_STATUSES,
} from "./constants.js";

type ValueOf<Values extends readonly unknown[]> = Values[number];

export type IntegrationSchemaVersion = typeof INTEGRATION_SCHEMA_VERSION;
export type IntegrationStatus = ValueOf<typeof INTEGRATION_STATUSES>;
export type CoreCategory = ValueOf<typeof CORE_CATEGORIES>;
export type CoreDeliveryMode = ValueOf<typeof CORE_DELIVERY_MODES>;
export type CorePlatform = ValueOf<typeof CORE_PLATFORMS>;
export type CoreProtocol = ValueOf<typeof CORE_PROTOCOLS>;
export type CoreCapability = ValueOf<typeof CORE_CAPABILITIES>;
export type CorePermissionKind = ValueOf<typeof CORE_PERMISSION_KINDS>;

/** Namespaced identifier such as `x-example.custom-capability`. */
export type ExtensionId = `x-${string}.${string}`;

export type IntegrationCategory = CoreCategory | ExtensionId;
export type DeliveryMode = CoreDeliveryMode | ExtensionId;
export type Platform = CorePlatform | ExtensionId;
export type ProtocolId = CoreProtocol | ExtensionId;
export type IntegrationCapability = CoreCapability | ExtensionId;
export type PermissionKind = CorePermissionKind | ExtensionId;

export interface ProductCompatibility {
  readonly name: string;
  readonly versionRange?: string;
  readonly documentation?: string;
}

export interface IntegrationProtocol {
  readonly id: ProtocolId;
  readonly transport: "direct" | "gateway";
}

export interface IntegrationPermission {
  readonly kind: PermissionKind;
  readonly reason: string;
  readonly targets?: readonly string[];
}

export interface IntegrationLinks {
  readonly homepage?: string;
  readonly documentation?: string;
  readonly repository?: string;
}

export interface IntegrationManifest {
  readonly $schema?: string;
  readonly schemaVersion: IntegrationSchemaVersion;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly status: IntegrationStatus;
  readonly category: IntegrationCategory;
  readonly delivery: {
    readonly modes: readonly DeliveryMode[];
  };
  readonly compatibility: {
    readonly platforms: readonly Platform[];
    readonly products: readonly ProductCompatibility[];
  };
  readonly protocols: readonly IntegrationProtocol[];
  readonly capabilities: readonly IntegrationCapability[];
  readonly permissions: readonly IntegrationPermission[];
  readonly links?: IntegrationLinks;
}

export interface SchemaValidationIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

/** Kept for callers written against the manifest-only validator. */
export type ManifestValidationIssue = SchemaValidationIssue;

export type SchemaValidationResult<Value> =
  | {
      readonly valid: true;
      readonly value: Value;
    }
  | {
      readonly valid: false;
      readonly errors: readonly SchemaValidationIssue[];
    };

export type ManifestValidationResult = SchemaValidationResult<IntegrationManifest>;
