import type { IntegrationManifest, Platform } from "./types.js";

/**
 * Everything an integration is allowed to know about the machine it runs on.
 * `configPath` is set only when the caller pointed at an explicit file, which
 * suppresses the integration's own candidate search.
 */
export interface IntegrationContext {
  readonly platform: Platform;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly configPath?: string;
}

export type DetectionStatus =
  | "installed"
  | "config-only"
  | "not-found"
  | "unsupported";

export type ConfigScope = "explicit" | "project" | "global";

interface DetectionBase {
  readonly agentId: string;
  readonly displayName: string;
  readonly productVersion?: string;
  /** The file a change plan would target, whether or not it exists yet. */
  readonly configPath: string;
  readonly configExists: boolean;
  readonly configScope: ConfigScope;
  readonly evidence: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * `installed` means the executable answered a version probe; `config-only`
 * means only a configuration file was found. Both are enough to plan a change,
 * but a launcher requires `installed`.
 */
export interface AvailableDetection extends DetectionBase {
  readonly status: "installed" | "config-only";
}

export interface MissingDetection extends DetectionBase {
  readonly status: "not-found";
}

/** The product was found but sits outside the manifest's supported range. */
export interface UnsupportedDetection extends DetectionBase {
  readonly status: "unsupported";
  readonly unsupportedReason: string;
}

export type DetectionResult =
  | AvailableDetection
  | MissingDetection
  | UnsupportedDetection;

export function isDetectionAvailable(
  detection: DetectionResult,
): detection is AvailableDetection {
  return detection.status === "installed" || detection.status === "config-only";
}

export interface WriteFileOperation {
  readonly type: "write-file";
  readonly path: string;
  readonly mode: "create" | "update";
  readonly expectedContentHash: string | null;
  readonly content: string;
  readonly containsSecrets: false;
}

export type ChangeOperation = WriteFileOperation;

export interface ChangePlan {
  readonly id: string;
  readonly integrationId: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly operations: readonly ChangeOperation[];
  readonly requiresRestart: boolean;
  readonly warnings: readonly string[];
}

export interface ApplyReceipt {
  readonly planId: string;
  readonly appliedAt: string;
  readonly rollbackToken: unknown;
}

export type VerificationResult =
  | {
      readonly valid: true;
      readonly message?: string;
    }
  | {
      readonly valid: false;
      readonly reason: string;
    };

export interface IntegrationAdapter<Intent, Snapshot> {
  readonly manifest: IntegrationManifest;
  detect(context: IntegrationContext): Promise<DetectionResult>;
  inspect(
    context: IntegrationContext,
    detection: AvailableDetection,
  ): Promise<Snapshot>;
  plan(
    context: IntegrationContext,
    detection: AvailableDetection,
    inspection: Snapshot,
    intent: Intent,
  ): Promise<ChangePlan>;
  verify(
    context: IntegrationContext,
    plan: ChangePlan,
    receipt: ApplyReceipt,
  ): Promise<VerificationResult>;
}

export interface ChangeExecutor {
  apply(plan: ChangePlan): Promise<ApplyReceipt>;
  rollback(receipt: ApplyReceipt): Promise<void>;
}

export type ChangeApproval = (plan: ChangePlan) => Promise<boolean>;
