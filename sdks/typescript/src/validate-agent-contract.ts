import detectionResultSchema from "@apexnova-connect/schemas/detection-result" with {
  type: "json",
};
import inspectionResultSchema from "@apexnova-connect/schemas/inspection-result" with {
  type: "json",
};
import { type ValidateFunction } from "ajv/dist/2020.js";

import type { AgentInspection, InspectionStatus, ManagedConnection } from "./agent.js";
import { ajv, describeIssues, toValidationIssue } from "./ajv.js";
import type {
  ConfigScope,
  DetectionResult,
  DetectionStatus,
} from "./lifecycle.js";
import type { ProtocolId, SchemaValidationResult } from "./types.js";

export const AGENT_CONTRACT_SCHEMA_VERSION = "0.1" as const;

/** Wire projection of {@link DetectionResult}, matching detection-result.schema.json. */
export interface DetectionResultDocument {
  readonly schemaVersion: typeof AGENT_CONTRACT_SCHEMA_VERSION;
  readonly agentId: string;
  readonly displayName: string;
  readonly status: DetectionStatus;
  readonly productVersion?: string;
  readonly configPath: string;
  readonly configExists: boolean;
  readonly configScope: ConfigScope;
  readonly unsupportedReason?: string;
  readonly evidence: readonly string[];
  readonly warnings: readonly string[];
}

/** Wire projection of {@link AgentInspection}, matching inspection-result.schema.json. */
export interface InspectionResultDocument {
  readonly schemaVersion: typeof AGENT_CONTRACT_SCHEMA_VERSION;
  readonly agentId: string;
  readonly configPath: string;
  readonly status: InspectionStatus;
  readonly managed: boolean;
  readonly connection?: ManagedConnection & {
    readonly protocol?: ProtocolId | "unknown";
  };
  readonly warnings: readonly string[];
}

export function toDetectionDocument(
  detection: DetectionResult,
): DetectionResultDocument {
  return {
    schemaVersion: AGENT_CONTRACT_SCHEMA_VERSION,
    agentId: detection.agentId,
    displayName: detection.displayName,
    status: detection.status,
    ...(detection.productVersion ? { productVersion: detection.productVersion } : {}),
    configPath: detection.configPath,
    configExists: detection.configExists,
    configScope: detection.configScope,
    ...(detection.status === "unsupported"
      ? { unsupportedReason: detection.unsupportedReason }
      : {}),
    evidence: detection.evidence,
    warnings: detection.warnings,
  };
}

export function toInspectionDocument(
  inspection: AgentInspection,
): InspectionResultDocument {
  return {
    schemaVersion: AGENT_CONTRACT_SCHEMA_VERSION,
    agentId: inspection.agentId,
    configPath: inspection.configPath,
    status: inspection.status,
    managed: inspection.managed,
    ...(inspection.connection ? { connection: inspection.connection } : {}),
    warnings: inspection.warnings,
  };
}

// Compiled on first use: a host that only emits documents should not pay to
// build the validators at startup.
let validateDetection: ValidateFunction<DetectionResultDocument> | undefined;
let validateInspection: ValidateFunction<InspectionResultDocument> | undefined;

export function validateDetectionDocument(
  value: unknown,
): SchemaValidationResult<DetectionResultDocument> {
  validateDetection ??= ajv.compile<DetectionResultDocument>(detectionResultSchema);
  if (validateDetection(value)) return { valid: true, value };
  return {
    valid: false,
    errors: (validateDetection.errors ?? []).map(toValidationIssue),
  };
}

export function validateInspectionDocument(
  value: unknown,
): SchemaValidationResult<InspectionResultDocument> {
  validateInspection ??= ajv.compile<InspectionResultDocument>(inspectionResultSchema);
  if (validateInspection(value)) return { valid: true, value };
  return {
    valid: false,
    errors: (validateInspection.errors ?? []).map(toValidationIssue),
  };
}

export function assertDetectionDocument(
  value: unknown,
): asserts value is DetectionResultDocument {
  const result = validateDetectionDocument(value);
  if (!result.valid) {
    throw new TypeError(
      `Invalid detection result: ${describeIssues(result.errors)}`,
    );
  }
}

export function assertInspectionDocument(
  value: unknown,
): asserts value is InspectionResultDocument {
  const result = validateInspectionDocument(value);
  if (!result.valid) {
    throw new TypeError(
      `Invalid inspection result: ${describeIssues(result.errors)}`,
    );
  }
}
