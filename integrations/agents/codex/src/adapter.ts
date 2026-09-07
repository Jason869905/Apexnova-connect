import { existsSync } from "node:fs";
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

import { planCodexConfig } from "./codex-config.js";
import {
  codexConfigRoots,
  detectCodex,
  inspectCodex,
  readCodexConfig,
  CODEX_AGENT_ID,
  CODEX_DISPLAY_NAME,
  CODEX_EXECUTABLE,
} from "./discovery.js";
import { codexManifest } from "./manifest.js";

/**
 * Codex dropped every wire API but Responses, so a Chat Completions deployment
 * is genuinely unusable here. Saying so is better than silently configuring an
 * endpoint Codex will not call correctly.
 */
const SUPPORTED_PROTOCOLS: readonly ProtocolId[] = ["openai-responses"];

function requireResponses(protocol: ProtocolId): void {
  if (protocol === "openai-responses") return;
  throw new AgentIntegrationError(
    "PROTOCOL_NOT_SUPPORTED",
    `Codex only speaks the Responses API and cannot consume ${protocol}.`,
    { details: { protocol, supportedProtocols: SUPPORTED_PROTOCOLS } },
  );
}

export function resolveCodexExecutable(
  context: IntegrationContext,
  pathExists: (path: string) => boolean = existsSync,
): string {
  if (context.platform !== "windows") return CODEX_EXECUTABLE;

  // A `.cmd` shim cannot be spawned with `shell:false`, and nothing here is
  // interpolated into a command line, so only a real `codex.exe` will do.
  const pathValue = context.environment.PATH ?? context.environment.Path ?? "";
  for (const directory of pathValue.split(";").filter(Boolean)) {
    const executable = win32.join(directory, "codex.exe");
    if (pathExists(executable)) return executable;
  }

  throw new AgentIntegrationError(
    "AGENT_NOT_FOUND",
    "Codex was detected, but no native codex.exe target was found on PATH.",
  );
}

export interface CodexIntegrationOptions {
  /** Test seam that replaces every real version probe. */
  readonly runVersionCommand?: CommandProbe;
  readonly pathExists?: (path: string) => boolean;
}

export function createCodexIntegration(
  options: CodexIntegrationOptions = {},
): AgentIntegration {
  return {
    manifest: codexManifest,
    credentialEnvironmentVariable: "APEXNOVA_API_KEY",
    supportedProtocols: SUPPORTED_PROTOCOLS,

    detect(context: IntegrationContext): Promise<DetectionResult> {
      return detectCodex(context, options.runVersionCommand);
    },

    inspect(
      _context: IntegrationContext,
      detection: AvailableDetection,
    ): Promise<AgentInspection> {
      return inspectCodex(detection);
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
          inspection.warnings[0] ?? "Codex configuration is not supported.",
          { details: { configPath: inspection.configPath, status: inspection.status } },
        );
      }
      requireResponses(intent.protocol);

      return planCodexConfig({
        planId: intent.planId,
        createdAt: intent.createdAt,
        configPath: detection.configPath,
        existingContent: await readCodexConfig(detection),
        hubBaseUrl: protocolRootUrl(intent.baseUrl, intent.protocol),
        modelId: intent.inferenceAlias,
        apiKeyEnvironmentVariable: intent.apiKeyEnvironmentVariable,
        ...(intent.allowInsecureLoopback === undefined
          ? {}
          : { allowInsecureLoopback: intent.allowInsecureLoopback }),
      });
    },

    async verify(
      _context: IntegrationContext,
      plan: ChangePlan,
      _receipt: ApplyReceipt,
    ): Promise<VerificationResult> {
      const target = plan.operations[0];
      if (!target) {
        return { valid: true, message: "No Codex configuration change was required." };
      }
      const inspection = await inspectCodex({ configPath: target.path, configExists: true });
      if (inspection.status !== "configured" || !inspection.managed) {
        return {
          valid: false,
          reason:
            inspection.warnings[0] ??
            `Codex configuration at ${target.path} does not contain a managed Apexnova provider.`,
        };
      }
      if ((inspection.connection?.modelIds.length ?? 0) === 0) {
        return {
          valid: false,
          reason:
            inspection.warnings[0] ??
            "Codex is not selecting the Apexnova provider after the change.",
        };
      }
      return {
        valid: true,
        message: `Codex configured for ${inspection.connection?.modelIds.join(", ")}.`,
      };
    },

    configRoots(context: IntegrationContext): readonly string[] {
      return codexConfigRoots(context);
    },

    async planLaunch(request: LaunchRequest): Promise<LaunchPlan> {
      return {
        executable: resolveCodexExecutable(request.context, options.pathExists),
        args: [...request.args],
        environment: {
          ...request.context.environment,
          ...request.credentialEnvironment,
        },
      };
    },

    async diagnose(context: IntegrationContext): Promise<readonly DiagnosticCheck[]> {
      const checks: DiagnosticCheck[] = [];
      const detection = await detectCodex(context, options.runVersionCommand);
      checks.push({
        id: `${CODEX_AGENT_ID}.discovery`,
        status: detection.status === "not-found" ? "fail" : "pass",
        code: `discovery.${detection.status}`,
        severity: detection.status === "not-found" ? "error" : "info",
        message: `${CODEX_DISPLAY_NAME}: ${detection.status}${detection.productVersion ? ` ${detection.productVersion}` : ""}`,
        ...(detection.status === "not-found"
          ? { remediation: "Install the Codex CLI, or pass --config to point at an existing config.toml." }
          : {}),
      });
      if (detection.status === "not-found") return checks;

      try {
        const inspection = await inspectCodex(detection);
        const failed = inspection.status === "invalid";
        checks.push({
          id: `${CODEX_AGENT_ID}.config`,
          status: failed ? "fail" : inspection.managed && inspection.warnings.length === 0 ? "pass" : "warning",
          code: `config.${inspection.status}`,
          severity: failed ? "error" : "info",
          message: `${CODEX_DISPLAY_NAME} configuration: ${inspection.status}`,
          ...(inspection.warnings[0] ? { remediation: inspection.warnings[0] } : {}),
        });
      } catch (error) {
        checks.push({
          id: `${CODEX_AGENT_ID}.config`,
          status: "fail",
          code: error instanceof AgentIntegrationError ? `config.${error.code}` : "config.unreadable",
          severity: "error",
          message: `${CODEX_DISPLAY_NAME} configuration could not be read.`,
        });
      }
      return checks;
    },
  };
}

export const codexIntegration: AgentIntegration = createCodexIntegration();
