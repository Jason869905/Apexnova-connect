import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  AgentIntegrationError,
  probeExecutableVersion,
  type AgentInspection,
  type AgentIntegration,
  type CommandProbe,
  type DetectionResult,
  type DiagnosticCheck,
  type IntegrationContext,
  type IntegrationManifest,
} from "@apexnova-connect/integration-sdk";

const AGENT_ID = "example-agent";
const DISPLAY_NAME = "Example Agent";
const EXECUTABLE = "example-agent";
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

/**
 * Source of truth for the manifest; `manifest.json` beside this package is the
 * language-neutral copy, and the contract test asserts they never drift.
 *
 * A detection-only integration declares no capabilities and asks for nothing
 * but filesystem reads. `experimental` rather than `research` because the
 * detection is real and tested: the schema forbids a research or planned
 * integration from declaring any capability or permission at all.
 */
export const exampleAgentManifest: IntegrationManifest = {
  $schema: "../../../schemas/integration-manifest.schema.json",
  schemaVersion: "1",
  id: AGENT_ID,
  displayName: DISPLAY_NAME,
  description:
    "Detection-only integration template: it discovers a product and reports its configuration, and changes nothing.",
  version: "0.1.0",
  status: "experimental",
  category: "agent",
  delivery: { modes: ["config-adapter"] },
  compatibility: {
    platforms: ["windows", "macos", "linux"],
    products: [
      {
        name: DISPLAY_NAME,
        versionRange: ">=1.0.0",
        documentation: "https://example.invalid/docs/configuration",
      },
    ],
  },
  protocols: [],
  capabilities: [],
  permissions: [
    {
      kind: "filesystem-read",
      reason: "Inspect the target product configuration; this integration never writes.",
    },
  ],
  links: { documentation: "https://example.invalid/docs/configuration" },
};

function configPathFor(context: IntegrationContext): string {
  if (context.configPath) {
    return isAbsolute(context.configPath)
      ? resolve(context.configPath)
      : resolve(context.workingDirectory, context.configPath);
  }
  return join(resolve(context.homeDirectory), ".example-agent", "config.json");
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function readOnly(operation: string): AgentIntegrationError {
  return new AgentIntegrationError(
    "READ_ONLY_INTEGRATION",
    `${DISPLAY_NAME} is a detection-only integration and cannot ${operation}.`,
    { details: { agentId: AGENT_ID } },
  );
}

export interface ExampleAgentIntegrationOptions {
  /** Test seam that replaces every real version probe. */
  readonly runVersionCommand?: CommandProbe;
}

export function createExampleAgentIntegration(
  options: ExampleAgentIntegrationOptions = {},
): AgentIntegration {
  return {
    manifest: exampleAgentManifest,
    credentialEnvironmentVariable: "EXAMPLE_AGENT_API_KEY",
    supportedProtocols: [],

    async detect(context: IntegrationContext): Promise<DetectionResult> {
      const configPath = configPathFor(context);
      const configExists = await isRegularFile(configPath);
      const probe = await probeExecutableVersion({
        executable: EXECUTABLE,
        displayName: DISPLAY_NAME,
        platform: context.platform,
        ...(options.runVersionCommand ? { run: options.runVersionCommand } : {}),
      });

      return {
        agentId: AGENT_ID,
        displayName: DISPLAY_NAME,
        status: probe.found ? "installed" : configExists ? "config-only" : "not-found",
        ...(probe.version ? { productVersion: probe.version } : {}),
        configPath,
        configExists,
        configScope: context.configPath ? "explicit" : "global",
        evidence: [
          ...probe.evidence,
          ...(configExists ? ["configuration file found (global)"] : []),
        ],
        warnings: probe.warnings,
      };
    },

    async inspect(
      _context: IntegrationContext,
      detection: { readonly configPath: string; readonly configExists: boolean },
    ): Promise<AgentInspection> {
      const base = { agentId: AGENT_ID, configPath: detection.configPath } as const;
      if (!detection.configExists) {
        return { ...base, status: "not-configured", managed: false, warnings: [] };
      }

      const size = (await stat(detection.configPath)).size;
      if (size > MAX_CONFIG_BYTES) {
        throw new AgentIntegrationError(
          "CONFIG_TOO_LARGE",
          `${DISPLAY_NAME} configuration exceeds the 2 MiB inspection limit.`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(detection.configPath, "utf8"));
      } catch {
        // Report that the file is unreadable, never what it contains.
        return {
          ...base,
          status: "invalid",
          managed: false,
          warnings: [`${DISPLAY_NAME} configuration is not valid JSON.`],
        };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          ...base,
          status: "invalid",
          managed: false,
          warnings: [`${DISPLAY_NAME} configuration root must be an object.`],
        };
      }

      const provider = (parsed as Record<string, unknown>).provider;
      if (typeof provider !== "string" || provider.length === 0) {
        return { ...base, status: "not-configured", managed: false, warnings: [] };
      }
      return {
        ...base,
        status: "configured",
        managed: false,
        connection: {
          providerId: provider,
          modelIds: [],
          environmentVariables: [],
        },
        warnings: [
          `${DISPLAY_NAME} is detected read-only; Apexnova-connect will not change this configuration.`,
        ],
      };
    },

    // Async so callers get a rejected promise, matching the lifecycle contract
    // rather than throwing out of the call itself.
    async plan(): Promise<never> {
      throw readOnly("plan a configuration change");
    },

    async verify(): Promise<never> {
      throw readOnly("verify a configuration change");
    },

    configRoots(context: IntegrationContext): readonly string[] {
      return [dirname(configPathFor(context))];
    },

    async planLaunch(): Promise<never> {
      throw readOnly("launch the product");
    },

    async diagnose(context: IntegrationContext): Promise<readonly DiagnosticCheck[]> {
      const detection = await this.detect(context);
      return [
        {
          id: `${AGENT_ID}.discovery`,
          status: detection.status === "not-found" ? "fail" : "pass",
          code: `discovery.${detection.status}`,
          severity: detection.status === "not-found" ? "error" : "info",
          message: `${DISPLAY_NAME}: ${detection.status}`,
        },
      ];
    },
  };
}

export const exampleAgentIntegration: AgentIntegration = createExampleAgentIntegration();
