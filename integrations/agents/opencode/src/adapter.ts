import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { win32 } from "node:path";

import {
  AgentIntegrationError,
  protocolRootUrl,
  type AgentInspection,
  type AgentIntegration,
  type ApplyReceipt,
  type AvailableDetection,
  type ChangePlan,
  type CommandProbe,
  type ConnectionIntent,
  type DetectionResult,
  type DiagnosticCheck,
  type IntegrationContext,
  type LaunchPlan,
  type LaunchRequest,
  type ProtocolId,
  type VerificationResult,
} from "@apexnova-connect/integration-sdk";

import {
  detectOpenCode,
  inspectOpenCode,
  OpenCodeInspectionError,
  openCodeConfigRoots,
  OPENCODE_AGENT_ID,
  OPENCODE_DISPLAY_NAME,
  OPENCODE_EXECUTABLE,
} from "./discovery.js";
import { openCodeManifest } from "./manifest.js";
import {
  planOpenCodeV2Config,
  type OpenCodeProtocol,
} from "./open-code-v2-config.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

const SUPPORTED_PROTOCOLS: readonly ProtocolId[] = [
  "openai-responses",
  "openai-chat-completions",
];

function requireOpenCodeProtocol(protocol: ProtocolId): OpenCodeProtocol {
  if (protocol === "openai-responses" || protocol === "openai-chat-completions") {
    return protocol;
  }
  throw new AgentIntegrationError(
    "PROTOCOL_NOT_SUPPORTED",
    `OpenCode cannot consume ${protocol}.`,
    { details: { protocol, supportedProtocols: SUPPORTED_PROTOCOLS } },
  );
}

async function readExistingConfig(configPath: string, exists: boolean): Promise<string | null> {
  if (!exists) return null;
  let size: number;
  try {
    size = (await stat(configPath)).size;
  } catch (cause) {
    throw new OpenCodeInspectionError(
      "CONFIG_READ_FAILED",
      "OpenCode configuration could not be read.",
      { cause },
    );
  }
  if (size > MAX_CONFIG_BYTES) {
    throw new OpenCodeInspectionError(
      "CONFIG_TOO_LARGE",
      "OpenCode configuration exceeds the 2 MiB planning limit.",
    );
  }
  try {
    return await readFile(configPath, "utf8");
  } catch (cause) {
    throw new OpenCodeInspectionError(
      "CONFIG_READ_FAILED",
      "OpenCode configuration could not be read.",
      { cause },
    );
  }
}

/**
 * On Windows the npm shim is a `.cmd` that cannot be spawned with `shell:false`,
 * so the launcher resolves the fixed native target instead of interpolating any
 * user argument into a shell command line.
 */
export function resolveOpenCodeExecutable(
  context: IntegrationContext,
  pathExists: (path: string) => boolean = existsSync,
): string {
  if (context.platform !== "windows") return OPENCODE_EXECUTABLE;

  const pathValue = context.environment.PATH ?? context.environment.Path ?? "";
  for (const directory of pathValue.split(";").filter(Boolean)) {
    const standalone = win32.join(directory, "opencode.exe");
    if (pathExists(standalone)) return standalone;

    const npmBinary = win32.join(
      directory,
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (pathExists(npmBinary)) return npmBinary;
  }

  throw new AgentIntegrationError(
    "AGENT_NOT_FOUND",
    "OpenCode was detected, but no native opencode.exe target was found on PATH.",
  );
}

export interface OpenCodeIntegrationOptions {
  /** Test seam that replaces every real version probe. */
  readonly runVersionCommand?: CommandProbe;
  readonly pathExists?: (path: string) => boolean;
}

export function createOpenCodeIntegration(
  options: OpenCodeIntegrationOptions = {},
): AgentIntegration {
  return {
    manifest: openCodeManifest,
    credentialEnvironmentVariable: "APEXNOVA_API_KEY",
    supportedProtocols: SUPPORTED_PROTOCOLS,

    detect(context: IntegrationContext): Promise<DetectionResult> {
      return detectOpenCode(context, options.runVersionCommand);
    },

    inspect(
      _context: IntegrationContext,
      detection: AvailableDetection,
    ): Promise<AgentInspection> {
      return inspectOpenCode(detection);
    },

    async plan(
      _context: IntegrationContext,
      detection: AvailableDetection,
      inspection: AgentInspection,
      intent: ConnectionIntent,
    ): Promise<ChangePlan> {
      if (inspection.status === "legacy" || inspection.status === "invalid") {
        throw new AgentIntegrationError(
          inspection.status === "legacy" ? "LEGACY_CONFIG" : "INVALID_CONFIG",
          inspection.warnings[0] ?? "OpenCode configuration is not supported.",
          { details: { configPath: inspection.configPath, status: inspection.status } },
        );
      }
      const protocol = requireOpenCodeProtocol(intent.protocol);
      const existingContent = await readExistingConfig(
        detection.configPath,
        detection.configExists,
      );

      return planOpenCodeV2Config({
        planId: intent.planId,
        createdAt: intent.createdAt,
        configPath: detection.configPath,
        existingContent,
        hubBaseUrl: protocolRootUrl(intent.baseUrl, intent.protocol),
        ...(intent.allowInsecureLoopback === undefined
          ? {}
          : { allowInsecureLoopback: intent.allowInsecureLoopback }),
        apiKeyEnvironmentVariable: intent.apiKeyEnvironmentVariable,
        models: [
          {
            id: intent.inferenceAlias,
            name: intent.modelName ?? intent.inferenceAlias,
            protocol,
            upstreamId: intent.inferenceAlias,
            ...(intent.limits ? { limits: intent.limits } : {}),
          },
        ],
        defaultModelId: intent.inferenceAlias,
      });
    },

    async verify(
      _context: IntegrationContext,
      plan: ChangePlan,
      _receipt: ApplyReceipt,
    ): Promise<VerificationResult> {
      const target = plan.operations[0];
      if (!target) {
        return { valid: true, message: "No OpenCode configuration change was required." };
      }
      const inspection = await inspectOpenCode({
        configPath: target.path,
        configExists: true,
      });
      if (inspection.status !== "configured" || !inspection.managed) {
        return {
          valid: false,
          reason:
            inspection.warnings[0] ??
            `OpenCode configuration at ${target.path} does not contain a managed Apexnova provider.`,
        };
      }
      if ((inspection.connection?.modelIds.length ?? 0) === 0) {
        return {
          valid: false,
          reason: "The applied OpenCode provider declares no models.",
        };
      }
      return {
        valid: true,
        message: `OpenCode provider configured for ${inspection.connection?.modelIds.join(", ")}.`,
      };
    },

    configRoots(context: IntegrationContext): readonly string[] {
      return openCodeConfigRoots(context);
    },

    async planLaunch(request: LaunchRequest): Promise<LaunchPlan> {
      return {
        executable: resolveOpenCodeExecutable(request.context, options.pathExists),
        args: [...request.args],
        environment: {
          ...request.context.environment,
          ...request.credentialEnvironment,
        },
      };
    },

    async diagnose(context: IntegrationContext): Promise<readonly DiagnosticCheck[]> {
      const checks: DiagnosticCheck[] = [];
      const detection = await detectOpenCode(context, options.runVersionCommand);
      checks.push({
        id: `${OPENCODE_AGENT_ID}.discovery`,
        status: detection.status === "not-found" ? "fail" : "pass",
        code: `discovery.${detection.status}`,
        severity: detection.status === "not-found" ? "error" : "info",
        message: `${OPENCODE_DISPLAY_NAME}: ${detection.status}${detection.productVersion ? ` ${detection.productVersion}` : ""}`,
        ...(detection.status === "not-found"
          ? { remediation: "Install OpenCode, or pass --config to point at an existing configuration." }
          : {}),
      });

      if (detection.status === "not-found") return checks;

      try {
        const inspection = await inspectOpenCode(detection);
        const failed = inspection.status === "invalid" || inspection.status === "legacy";
        checks.push({
          id: `${OPENCODE_AGENT_ID}.config`,
          status: failed ? "fail" : inspection.managed ? "pass" : "warning",
          code: `config.${inspection.status}`,
          severity: failed ? "error" : inspection.managed ? "info" : "warning",
          message: `${OPENCODE_DISPLAY_NAME} configuration: ${inspection.status}`,
          ...(inspection.warnings[0] ? { remediation: inspection.warnings[0] } : {}),
        });
      } catch (error) {
        checks.push({
          id: `${OPENCODE_AGENT_ID}.config`,
          status: "fail",
          code: error instanceof AgentIntegrationError ? `config.${error.code}` : "config.unreadable",
          severity: "error",
          message: `${OPENCODE_DISPLAY_NAME} configuration could not be read.`,
        });
      }

      return checks;
    },
  };
}

export const openCodeIntegration: AgentIntegration = createOpenCodeIntegration();
