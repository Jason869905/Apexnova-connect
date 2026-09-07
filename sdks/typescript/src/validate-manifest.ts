import integrationManifestSchema from "@apexnova-connect/schemas/integration-manifest" with {
  type: "json",
};
import { type ValidateFunction } from "ajv/dist/2020.js";

import { ajv, describeIssues, toValidationIssue } from "./ajv.js";
import type {
  IntegrationManifest,
  ManifestValidationResult,
} from "./types.js";

let validate: ValidateFunction<IntegrationManifest> | undefined;

export function validateIntegrationManifest(value: unknown): ManifestValidationResult {
  validate ??= ajv.compile<IntegrationManifest>(integrationManifestSchema);
  if (validate(value)) {
    return {
      valid: true,
      value,
    };
  }

  return {
    valid: false,
    errors: (validate.errors ?? []).map(toValidationIssue),
  };
}

export function assertIntegrationManifest(
  value: unknown,
): asserts value is IntegrationManifest {
  const result = validateIntegrationManifest(value);

  if (!result.valid) {
    throw new TypeError(
      `Invalid integration manifest: ${describeIssues(result.errors)}`,
    );
  }
}
