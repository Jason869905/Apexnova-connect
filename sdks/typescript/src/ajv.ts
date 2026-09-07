import commonDefinitions from "@apexnova-connect/schemas/common-definitions" with {
  type: "json",
};
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import type { SchemaValidationIssue } from "./types.js";

/**
 * One shared compiler so schemas that `$ref` the common definitions resolve
 * without every caller re-registering them.
 */
export const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

ajv.addSchema(commonDefinitions);

export function toValidationIssue(error: ErrorObject): SchemaValidationIssue {
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "Schema validation failed.",
  };
}

export function describeIssues(
  issues: readonly SchemaValidationIssue[],
): string {
  return issues
    .map((issue) => `${issue.instancePath || "/"}: ${issue.message}`)
    .join("; ");
}
