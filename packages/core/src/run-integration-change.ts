import {
  assertIntegrationManifest,
  type ApplyReceipt,
  type ChangeApproval,
  type ChangeExecutor,
  type ChangePlan,
  type DetectionResult,
  type IntegrationAdapter,
  type IntegrationContext,
  type VerificationResult,
} from "@apexnova-connect/integration-sdk";

export type IntegrationChangePhase =
  | "manifest"
  | "detect"
  | "inspect"
  | "plan"
  | "approve"
  | "apply"
  | "verify"
  | "rollback";

export class IntegrationChangeError extends Error {
  readonly phase: IntegrationChangePhase;

  constructor(phase: IntegrationChangePhase, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IntegrationChangeError";
    this.phase = phase;
  }
}

export type IntegrationChangeResult =
  | {
      readonly status: "unavailable";
      readonly detection: Exclude<DetectionResult, { readonly status: "available" }>;
    }
  | {
      readonly status: "declined" | "no-change";
      readonly plan: ChangePlan;
    }
  | {
      readonly status: "applied";
      readonly plan: ChangePlan;
      readonly receipt: ApplyReceipt;
      readonly verification: Extract<VerificationResult, { readonly valid: true }>;
    }
  | {
      readonly status: "rolled-back";
      readonly plan: ChangePlan;
      readonly verification: Extract<VerificationResult, { readonly valid: false }>;
    };

export interface RunIntegrationChangeOptions<Intent, Snapshot> {
  readonly adapter: IntegrationAdapter<Intent, Snapshot>;
  readonly executor: ChangeExecutor;
  readonly context: IntegrationContext;
  readonly intent: Intent;
  readonly approve: ChangeApproval;
}

async function rollbackAfterFailure(
  executor: ChangeExecutor,
  receipt: ApplyReceipt,
  failure: Error,
): Promise<void> {
  try {
    await executor.rollback(receipt);
  } catch (rollbackCause) {
    throw new IntegrationChangeError(
      "rollback",
      "The integration change failed and rollback did not complete.",
      {
        cause: new AggregateError([failure, rollbackCause], "Apply and rollback both failed."),
      },
    );
  }
}

export async function runIntegrationChange<Intent, Snapshot>(
  options: RunIntegrationChangeOptions<Intent, Snapshot>,
): Promise<IntegrationChangeResult> {
  const { adapter, approve, context, executor, intent } = options;

  try {
    assertIntegrationManifest(adapter.manifest);
  } catch (cause) {
    throw new IntegrationChangeError(
      "manifest",
      "Integration manifest validation failed.",
      { cause },
    );
  }

  let detection: DetectionResult;
  try {
    detection = await adapter.detect(context);
  } catch (cause) {
    throw new IntegrationChangeError("detect", "Integration detection failed.", { cause });
  }

  if (detection.status !== "available") {
    return {
      status: "unavailable",
      detection,
    };
  }

  let inspection;
  try {
    inspection = await adapter.inspect(context, detection);
  } catch (cause) {
    throw new IntegrationChangeError("inspect", "Integration inspection failed.", { cause });
  }

  let plan: ChangePlan;
  try {
    plan = await adapter.plan(context, inspection, intent);
  } catch (cause) {
    throw new IntegrationChangeError("plan", "Integration planning failed.", { cause });
  }

  if (plan.integrationId !== adapter.manifest.id) {
    throw new IntegrationChangeError(
      "plan",
      `Plan integration ID ${plan.integrationId} does not match ${adapter.manifest.id}.`,
    );
  }

  if (plan.operations.length === 0) {
    return {
      status: "no-change",
      plan,
    };
  }

  let approved: boolean;
  try {
    approved = await approve(plan);
  } catch (cause) {
    throw new IntegrationChangeError("approve", "Change approval failed.", { cause });
  }

  if (!approved) {
    return {
      status: "declined",
      plan,
    };
  }

  let receipt: ApplyReceipt;
  try {
    receipt = await executor.apply(plan);
  } catch (cause) {
    throw new IntegrationChangeError("apply", "Applying the integration change failed.", {
      cause,
    });
  }

  if (receipt.planId !== plan.id) {
    const failure = new IntegrationChangeError(
      "apply",
      `Apply receipt ${receipt.planId} does not match plan ${plan.id}.`,
    );
    await rollbackAfterFailure(executor, receipt, failure);
    throw failure;
  }

  let verification: VerificationResult;
  try {
    verification = await adapter.verify(context, plan, receipt);
  } catch (cause) {
    const failure = new IntegrationChangeError(
      "verify",
      "Integration verification failed.",
      { cause },
    );
    await rollbackAfterFailure(executor, receipt, failure);
    throw failure;
  }

  if (!verification.valid) {
    await rollbackAfterFailure(
      executor,
      receipt,
      new IntegrationChangeError("verify", verification.reason),
    );

    return {
      status: "rolled-back",
      plan,
      verification,
    };
  }

  return {
    status: "applied",
    plan,
    receipt,
    verification,
  };
}
