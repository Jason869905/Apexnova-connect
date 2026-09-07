import type {
  ApplyReceipt,
  AvailableDetection,
  ChangePlan,
  DetectionResult,
  IntegrationContext,
  IntegrationAdapter,
  VerificationResult,
} from "./lifecycle.js";
import type { IntegrationManifest, ProtocolId } from "./types.js";

export type InspectionStatus =
  | "not-configured"
  | "configured"
  | "legacy"
  | "invalid";

/**
 * The Apexnova connection as it currently exists inside the target product's
 * configuration. Credentials are represented by environment variable names
 * only; a secret must never reach this structure.
 */
export interface ManagedConnection {
  readonly providerId: string;
  readonly displayName?: string;
  readonly protocol?: ProtocolId | "unknown";
  readonly baseUrl?: string;
  readonly packageName?: string;
  readonly modelIds: readonly string[];
  readonly defaultModelId?: string;
  readonly environmentVariables: readonly string[];
}

export interface AgentInspection {
  readonly agentId: string;
  readonly configPath: string;
  readonly status: InspectionStatus;
  /** True only when the connection present in the file was written by us. */
  readonly managed: boolean;
  readonly connection?: ManagedConnection;
  readonly warnings: readonly string[];
}

export interface ModelLimits {
  readonly context: number;
  readonly output: number;
}

/**
 * What the orchestrator asks an integration to configure. `protocol` and
 * `baseUrl` come straight from the Hub catalog projection; mapping them onto
 * the target product's own vocabulary is the integration's job.
 */
export interface ConnectionIntent {
  readonly planId: string;
  readonly createdAt: string;
  readonly deploymentId: string;
  readonly inferenceAlias: string;
  readonly modelName?: string;
  readonly protocol: ProtocolId;
  readonly baseUrl: string;
  readonly apiKeyEnvironmentVariable: string;
  readonly limits?: ModelLimits;
  readonly allowInsecureLoopback?: boolean;
  /**
   * A shell command that prints the current credential to stdout, for products
   * that can fetch a rotating credential themselves instead of reading a fixed
   * environment variable. Absent means the launcher injects the credential.
   */
  readonly credentialHelperCommand?: string;
}

export interface LaunchRequest {
  readonly context: IntegrationContext;
  /** Secrets the launcher injects into the child process environment. */
  readonly credentialEnvironment: Readonly<Record<string, string>>;
  readonly args: readonly string[];
}

export interface LaunchPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/** One entry of `checks[]` in `diagnostic-result.schema.json`. */
export interface DiagnosticCheck {
  readonly id: string;
  readonly status: "pass" | "warning" | "fail" | "skipped" | "unknown";
  readonly code: string;
  readonly severity: "info" | "warning" | "error" | "fatal";
  readonly message: string;
  readonly remediation?: string;
}

/**
 * The contract every Agent integration implements. It adds product discovery,
 * launching and recovery surface to the generic change adapter; nothing here
 * knows about Apexnova AI Hub billing, OAuth or credential storage.
 */
export interface AgentIntegration
  extends IntegrationAdapter<ConnectionIntent, AgentInspection> {
  readonly manifest: IntegrationManifest;
  /** Environment variable the written configuration refers to for its key. */
  readonly credentialEnvironmentVariable: string;
  /** Hub catalog protocols this product can actually consume. */
  readonly supportedProtocols: readonly ProtocolId[];
  detect(context: IntegrationContext): Promise<DetectionResult>;
  inspect(
    context: IntegrationContext,
    detection: AvailableDetection,
  ): Promise<AgentInspection>;
  plan(
    context: IntegrationContext,
    detection: AvailableDetection,
    inspection: AgentInspection,
    intent: ConnectionIntent,
  ): Promise<ChangePlan>;
  verify(
    context: IntegrationContext,
    plan: ChangePlan,
    receipt: ApplyReceipt,
  ): Promise<VerificationResult>;
  /**
   * Directories a restore is allowed to write back into. Returned regardless of
   * whether they exist; the caller drops the absent ones.
   */
  configRoots(context: IntegrationContext): readonly string[];
  planLaunch(request: LaunchRequest): Promise<LaunchPlan>;
  diagnose(
    context: IntegrationContext,
  ): Promise<readonly DiagnosticCheck[]>;
}

/**
 * Normalized failure from an Agent integration. Hosts map `code` onto their own
 * exit codes, so a new integration reports errors the CLI already understands
 * without the CLI importing anything product-specific.
 */
export class AgentIntegrationError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options: ErrorOptions & { readonly details?: Readonly<Record<string, unknown>> } = {},
  ) {
    super(message, options);
    this.name = "AgentIntegrationError";
    this.code = code;
    this.details = options.details ?? {};
  }
}
