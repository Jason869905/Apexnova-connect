import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CORE_CAPABILITIES,
  CORE_CATEGORIES,
  CORE_DELIVERY_MODES,
  CORE_PERMISSION_KINDS,
  CORE_PLATFORMS,
  CORE_PROTOCOLS,
  INTEGRATION_SCHEMA_VERSION,
  INTEGRATION_STATUSES,
  assertIntegrationManifest,
  validateIntegrationManifest,
  type IntegrationManifest,
} from "../src/index.js";

interface SchemaDefinition {
  readonly enum?: readonly string[];
  readonly anyOf?: readonly SchemaDefinition[];
  readonly properties?: Readonly<Record<string, SchemaDefinition>>;
}

interface ManifestSchemaContract {
  readonly properties: {
    readonly schemaVersion: {
      readonly const: string;
    };
  };
  readonly $defs: Readonly<Record<string, SchemaDefinition>>;
}

const exampleManifest = JSON.parse(
  readFileSync(
    new URL("../../../integrations/_template/manifest.example.json", import.meta.url),
    "utf8",
  ),
) as unknown;

const manifestSchema = JSON.parse(
  readFileSync(
    new URL("../../../schemas/integration-manifest.schema.json", import.meta.url),
    "utf8",
  ),
) as ManifestSchemaContract;

function cloneExample(): Record<string, unknown> {
  return structuredClone(exampleManifest) as Record<string, unknown>;
}

describe("integration manifest v1", () => {
  it("accepts the documented example", () => {
    const result = validateIntegrationManifest(exampleManifest);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.id).toBe("example-agent");
    }
  });

  it("narrows a valid unknown value", () => {
    const candidate: unknown = exampleManifest;

    assertIntegrationManifest(candidate);

    expect(candidate.schemaVersion).toBe("1");
  });

  it("rejects undeclared properties", () => {
    const candidate = cloneExample();
    candidate.secret = "must-not-be-accepted";

    const result = validateIntegrationManifest(candidate);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((error) => error.keyword === "additionalProperties")).toBe(
        true,
      );
    }
  });

  it("prevents planned integrations from claiming implemented capabilities", () => {
    const candidate = cloneExample() as unknown as IntegrationManifest & {
      status: "planned";
    };
    Object.assign(candidate, { status: "planned" });

    const result = validateIntegrationManifest(candidate);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((error) => error.keyword === "maxItems")).toBe(true);
    }
  });

  it("rejects unnamespaced custom capabilities", () => {
    const candidate = cloneExample();
    candidate.capabilities = ["future-magic"];

    expect(validateIntegrationManifest(candidate).valid).toBe(false);
  });

  it("accepts namespaced extension capabilities", () => {
    const candidate = cloneExample();
    candidate.capabilities = ["x-example.future-magic"];

    expect(validateIntegrationManifest(candidate).valid).toBe(true);
  });

  it("throws a readable error when assertion fails", () => {
    expect(() => assertIntegrationManifest({ schemaVersion: "1" })).toThrow(
      /Invalid integration manifest/,
    );
  });
});

describe("TypeScript and JSON Schema contract alignment", () => {
  const coreEnum = (definitionName: string): readonly string[] => {
    const definition = manifestSchema.$defs[definitionName];
    const values = definition?.enum ?? definition?.anyOf?.[0]?.enum;

    if (!values) {
      throw new TypeError(`Schema definition ${definitionName} has no core enum.`);
    }

    return values;
  };

  const corePropertyEnum = (
    definitionName: string,
    propertyName: string,
  ): readonly string[] => {
    const property = manifestSchema.$defs[definitionName]?.properties?.[propertyName];
    const values = property?.enum ?? property?.anyOf?.[0]?.enum;

    if (!values) {
      throw new TypeError(
        `Schema definition ${definitionName}.${propertyName} has no core enum.`,
      );
    }

    return values;
  };

  it("keeps schema version and lifecycle constants aligned", () => {
    expect(INTEGRATION_SCHEMA_VERSION).toBe(
      manifestSchema.properties.schemaVersion.const,
    );
    expect(INTEGRATION_STATUSES).toEqual(coreEnum("status"));
  });

  it("keeps extensible core enums aligned", () => {
    expect(CORE_CATEGORIES).toEqual(coreEnum("category"));
    expect(CORE_DELIVERY_MODES).toEqual(coreEnum("deliveryMode"));
    expect(CORE_PLATFORMS).toEqual(coreEnum("platform"));
    expect(CORE_PROTOCOLS).toEqual(corePropertyEnum("protocol", "id"));
    expect(CORE_CAPABILITIES).toEqual(coreEnum("capability"));
    expect(CORE_PERMISSION_KINDS).toEqual(
      corePropertyEnum("permission", "kind"),
    );
  });
});
