import integrationManifestSchema from "@apexnova-connect/schemas/integration-manifest" with {
  type: "json",
};
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import type {
  IntegrationManifest,
  ManifestValidationIssue,
  ManifestValidationResult,
} from "./types.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

const validate: ValidateFunction<IntegrationManifest> =
  ajv.compile<IntegrationManifest>(integrationManifestSchema);

function toValidationIssue(error: ErrorObject): ManifestValidationIssue {
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "Manifest validation failed.",
  };
}

export function validateIntegrationManifest(value: unknown): ManifestValidationResult {
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
    const details = result.errors
      .map((error) => `${error.instancePath || "/"}: ${error.message}`)
      .join("; ");

    throw new TypeError(`Invalid integration manifest: ${details}`);
  }
}
