import {
  assertIntegrationManifest,
  type AgentIntegration,
  type DetectionResult,
  type IntegrationContext,
  type Platform,
} from "@apexnova-connect/integration-sdk";

import { satisfiesVersionRange, VersionRangeError } from "./version-range.js";

export type IntegrationRegistryErrorCode =
  | "DUPLICATE_INTEGRATION"
  | "INTEGRATION_NOT_SUPPORTED"
  | "PLATFORM_NOT_SUPPORTED";

export class IntegrationRegistryError extends Error {
  readonly code: IntegrationRegistryErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: IntegrationRegistryErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "IntegrationRegistryError";
    this.code = code;
    this.details = details;
  }
}

export interface IntegrationRegistry {
  /** Every registered Agent ID, sorted, regardless of platform support. */
  readonly agentIds: readonly string[];
  list(platform?: Platform): readonly AgentIntegration[];
  has(agentId: string): boolean;
  resolve(agentId: string, platform?: Platform): AgentIntegration;
}

function supportsPlatform(integration: AgentIntegration, platform: Platform): boolean {
  return integration.manifest.compatibility.platforms.includes(platform);
}

/**
 * Holds the Agent integrations an application has chosen to load. The registry
 * never imports an integration itself, which keeps `packages/core` free of
 * product-specific code.
 */
export function createIntegrationRegistry(
  integrations: readonly AgentIntegration[],
): IntegrationRegistry {
  const byId = new Map<string, AgentIntegration>();

  for (const integration of integrations) {
    assertIntegrationManifest(integration.manifest);
    const id = integration.manifest.id;
    if (byId.has(id)) {
      throw new IntegrationRegistryError(
        "DUPLICATE_INTEGRATION",
        `More than one integration is registered as ${id}.`,
        { agentId: id },
      );
    }
    byId.set(id, integration);
  }

  const agentIds = [...byId.keys()].sort();

  return {
    agentIds,
    has: (agentId) => byId.has(agentId),
    list: (platform) => {
      const all = agentIds.map((id) => byId.get(id)!);
      return platform === undefined
        ? all
        : all.filter((integration) => supportsPlatform(integration, platform));
    },
    resolve: (agentId, platform) => {
      const integration = byId.get(agentId);
      if (!integration) {
        throw new IntegrationRegistryError(
          "INTEGRATION_NOT_SUPPORTED",
          `Unsupported agent: ${agentId}.`,
          { agentId, supportedAgents: agentIds },
        );
      }
      if (platform !== undefined && !supportsPlatform(integration, platform)) {
        throw new IntegrationRegistryError(
          "PLATFORM_NOT_SUPPORTED",
          `${integration.manifest.displayName} does not support ${platform}.`,
          {
            agentId,
            platform,
            supportedPlatforms: integration.manifest.compatibility.platforms,
          },
        );
      }
      return integration;
    },
  };
}

/**
 * Runs an integration's own detection and then applies the manifest's declared
 * product version range. A product outside the range is downgraded to
 * `unsupported` so no caller can plan or apply a change against a version whose
 * configuration format was never tested.
 */
export async function detectAgent(
  integration: AgentIntegration,
  context: IntegrationContext,
): Promise<DetectionResult> {
  const detection = await integration.detect(context);
  if (detection.status !== "installed" || detection.productVersion === undefined) {
    return detection;
  }

  const ranges = integration.manifest.compatibility.products
    .map((product) => product.versionRange)
    .filter((range): range is string => range !== undefined);
  if (ranges.length === 0) return detection;

  for (const range of ranges) {
    try {
      if (satisfiesVersionRange(detection.productVersion, range)) return detection;
    } catch (cause) {
      if (!(cause instanceof VersionRangeError)) throw cause;
      return {
        ...detection,
        status: "unsupported",
        unsupportedReason: `The manifest version range ${range} could not be evaluated: ${cause.message}`,
      };
    }
  }

  return {
    ...detection,
    status: "unsupported",
    unsupportedReason: `${integration.manifest.displayName} ${detection.productVersion} is outside the supported range ${ranges.join(" || ")}.`,
  };
}
