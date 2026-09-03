import type { IntegrationManifest, Platform } from "./types.js";

export interface IntegrationContext {
  readonly platform: Platform;
  readonly workingDirectory: string;
}

export type DetectionResult =
  | {
      readonly status: "available";
      readonly productVersion?: string;
      readonly configPath?: string;
    }
  | {
      readonly status: "not-installed" | "unsupported";
      readonly reason: string;
      readonly productVersion?: string;
    };

export interface InspectionResult<Snapshot> {
  readonly snapshot: Snapshot;
  readonly warnings: readonly string[];
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
    detection: Extract<DetectionResult, { readonly status: "available" }>,
  ): Promise<InspectionResult<Snapshot>>;
  plan(
    context: IntegrationContext,
    inspection: InspectionResult<Snapshot>,
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

