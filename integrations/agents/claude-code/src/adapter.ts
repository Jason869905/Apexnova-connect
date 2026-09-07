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

import { planClaudeCodeSettings } from "./claude-code-settings.js";
import {
  claudeCodeConfigRoots,
  detectClaudeCode,
  inspectClaudeCode,
  readClaudeCodeSettings,
  CLAUDE_CODE_AGENT_ID,
  CLAUDE_CODE_CREDENTIAL_VARIABLE,
  CLAUDE_CODE_DISPLAY_NAME,
  CLAUDE_CODE_EXECUTABLE,
} from "./discovery.js";
import { claudeCodeManifest } from "./manifest.js";

const SUPPORTED_PROTOCOLS: readonly ProtocolId[] = ["anthropic-messages"];

function requireAnthropicMessages(protocol: ProtocolId): void {
  if (protocol === "anthropic-messages") return;
  throw new AgentIntegrationError(
    "PROTOCOL_NOT_SUPPORTED",
    `Claude Code speaks the Anthropic Messages API and cannot consume ${protocol}.`,
    { details: { protocol, supportedProtocols: SUPPORTED_PROTOCOLS } },
  );
}

export function resolveClaudeCodeExecutable(
  context: IntegrationContext,
  pathExists: (path: string) => boolean = existsSync,
): string {
  if (context.platform !== "windows") return CLAUDE_CODE_EXECUTABLE;

  const pathValue = context.environment.PATH ?? context.environment.Path ?? "";
  for (const directory of pathValue.split(";").filter(Boolean)) {
    const executable = win32.join(directory, "claude.exe");
    if (pathExists(executable)) return executable;
  }

  throw new AgentIntegrationError(
    "AGENT_NOT_FOUND",
    "Claude Code was detected, but no native claude.exe target was found on PATH.",
  );
}

export interface ClaudeCodeIntegrationOptions {
  /** Test seam that replaces every real version probe. */
  readonly runVersionCommand?: CommandProbe;
  readonly pathExists?: (path: string) => boolean;
}

export function createClaudeCodeIntegration(
  options: ClaudeCodeIntegrationOptions = {},
): AgentIntegration {
  return {
    manifest: claudeCodeManifest,
    // Claude Code reads its bearer token from this variable; the settings file
    // never holds it, because the settings env block would outrank the launcher.
    credentialEnvironmentVariable: CLAUDE_CODE_CREDENTIAL_VARIABLE,
    supportedProtocols: SUPPORTED_PROTOCOLS,

    detect(context: IntegrationContext): Promise<DetectionResult> {
      return detectClaudeCode(context, options.runVersionCommand);
    },

    inspect(
      _context: IntegrationContext,
      detection: AvailableDetection,
    ): Promise<AgentInspection> {
      return inspectClaudeCode(detection);
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
          inspection.warnings[0] ?? "Claude Code settings are not supported.",
          { details: { configPath: inspection.configPath, status: inspection.status } },
        );
      }
      requireAnthropicMessages(intent.protocol);

      return planClaudeCodeSettings({
        planId: intent.planId,
        createdAt: intent.createdAt,
        settingsPath: detection.configPath,
        existingContent: await readClaudeCodeSettings(detection),
        hubBaseUrl: protocolRootUrl(intent.baseUrl, intent.protocol),
        modelId: intent.inferenceAlias,
        ...(intent.allowInsecureLoopback === undefined
          ? {}
          : { allowInsecureLoopback: intent.allowInsecureLoopback }),
        ...(intent.credentialHelperCommand === undefined
          ? {}
          : { credentialHelperCommand: intent.credentialHelperCommand }),
      });
    },

    async verify(
      _context: IntegrationContext,
      plan: ChangePlan,
      _receipt: ApplyReceipt,
    ): Promise<VerificationResult> {
      const target = plan.operations[0];
      if (!target) {
        return { valid: true, message: "No Claude Code settings change was required." };
      }
      const inspection = await inspectClaudeCode({
        configPath: target.path,
        configExists: true,
      });
      if (inspection.status !== "configured" || !inspection.managed) {
        return {
          valid: false,
          reason:
            inspection.warnings[0] ??
            `Claude Code settings at ${target.path} do not point at Apexnova AI Hub.`,
        };
      }
      if ((inspection.connection?.modelIds.length ?? 0) === 0) {
        return { valid: false, reason: "The applied Claude Code settings bind no model." };
      }
      return {
        valid: true,
        message: `Claude Code configured for ${inspection.connection?.modelIds.join(", ")}.`,
      };
    },

    configRoots(context: IntegrationContext): readonly string[] {
      return claudeCodeConfigRoots(context);
    },

    async planLaunch(request: LaunchRequest): Promise<LaunchPlan> {
      return {
        executable: resolveClaudeCodeExecutable(request.context, options.pathExists),
        args: [...request.args],
        environment: {
          ...request.context.environment,
          ...request.credentialEnvironment,
        },
      };
    },

    async diagnose(context: IntegrationContext): Promise<readonly DiagnosticCheck[]> {
      const checks: DiagnosticCheck[] = [];
      const detection = await detectClaudeCode(context, options.runVersionCommand);
      checks.push({
        id: `${CLAUDE_CODE_AGENT_ID}.discovery`,
        status: detection.status === "not-found" ? "fail" : "pass",
        code: `discovery.${detection.status}`,
        severity: detection.status === "not-found" ? "error" : "info",
        message: `${CLAUDE_CODE_DISPLAY_NAME}: ${detection.status}${detection.productVersion ? ` ${detection.productVersion}` : ""}`,
        ...(detection.status === "not-found"
          ? { remediation: "Install Claude Code, or pass --config to point at an existing settings file." }
          : {}),
      });
      if (detection.status === "not-found") return checks;

      try {
        const inspection = await inspectClaudeCode(detection);
        const failed = inspection.status === "invalid";
        checks.push({
          id: `${CLAUDE_CODE_AGENT_ID}.settings`,
          status: failed ? "fail" : inspection.warnings.length > 0 ? "warning" : inspection.managed ? "pass" : "warning",
          code: `settings.${inspection.status}`,
          severity: failed ? "error" : "info",
          message: `${CLAUDE_CODE_DISPLAY_NAME} settings: ${inspection.status}`,
          ...(inspection.warnings[0] ? { remediation: inspection.warnings[0] } : {}),
        });
      } catch (error) {
        checks.push({
          id: `${CLAUDE_CODE_AGENT_ID}.settings`,
          status: "fail",
          code: error instanceof AgentIntegrationError ? `settings.${error.code}` : "settings.unreadable",
          severity: "error",
          message: `${CLAUDE_CODE_DISPLAY_NAME} settings could not be read.`,
        });
      }
      return checks;
    },
  };
}

export const claudeCodeIntegration: AgentIntegration = createClaudeCodeIntegration();
