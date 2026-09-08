export {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_DEFINITIONS_DIGEST,
  CAPABILITY_SUITE_ID,
  CAPABILITY_SUITE_VERSION,
  capabilityDefinition,
  capabilityDefinitionsDigest,
  requiredCapabilityIds,
} from "./definitions.js";

export type {
  CapabilityCategory,
  CapabilityDefinition,
  CapabilityLevel,
} from "./definitions.js";

export {
  CapabilityError,
  EVIDENCE_SCHEMA_VERSION,
  addDays,
  assertCompatibilityEvidence,
  assertRedacted,
  createEvidence,
  evidenceDigest,
  evidenceId,
  isEvidenceLive,
  isStatementLive,
  isSuiteCurrent,
  validateCompatibilityEvidence,
} from "./evidence.js";

export type {
  CapabilityErrorCode,
  CapabilityOutcome,
  CapabilityStatement,
  CapabilitySupport,
  CompatibilityEvidence,
  EvidenceInput,
  EvidenceResult,
  EvidenceSourceType,
  EvidenceSubject,
  EvidenceTestSuite,
  EvidenceValidationIssue,
  EvidenceValidationResult,
  EvidenceVerdict,
} from "./evidence.js";

export { FileEvidenceStore, supersededIds } from "./evidence-store.js";

export type {
  EvidenceAppendResult,
  EvidenceFilter,
  EvidenceStoreOptions,
} from "./evidence-store.js";

export { computeVerdict } from "./verdict.js";

export type {
  CapabilityRequirement,
  CapabilityVerdict,
  CompatibilityVerdictResult,
  SubjectVerdict,
  VerdictOptions,
} from "./verdict.js";

export { runCapabilitySuite } from "./suite.js";

export type {
  CapabilityOutcomeDetail,
  CapabilitySuiteOptions,
  CapabilitySuiteResult,
  SuiteProtocol,
} from "./suite.js";

export { buildCompatibilityMatrix, renderCompatibilityMatrix } from "./matrix.js";

export type {
  CompatibilityMatrix,
  CompatibilityMatrixRow,
  MatrixOptions,
} from "./matrix.js";
