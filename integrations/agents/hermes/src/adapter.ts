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

import { hermesApiMode, planHermesConfig } from "./hermes-config.js";
import {
  detectHermes,
  envFileDefines,
  hermesConfigRoots,
  hermesEnvPath,
  inspectHermes,
  readHermesConfig,
  HERMES_AGENT_ID,
  HERMES_CREDENTIAL_VARIABLE,
  HERMES_DISPLAY_NAME,
  HERMES_EXECUTABLE,
} from "./discovery.js";
import { hermesManifest } from "./manifest.js";

const SUPPORTED_PROTOCOLS: readonly ProtocolId[] = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
];

export interface HermesIntegrationOptions {
  /** Test seam that replaces every real version probe. */
  readonly runVersionCommand?: CommandProbe;
}

export function createHermesIntegration(
  options: HermesIntegrationOptions = {},
): AgentIntegration {
  return {
    manifest: hermesManifest,
    credentialEnvironmentVariable: HERMES_CREDENTIAL_VARIABLE,
    supportedProtocols: SUPPORTED_PROTOCOLS,

    detect(context: IntegrationContext): Promise<DetectionResult> {
      return detectHermes(context, options.runVersionCommand);
    },

    async inspect(
      context: IntegrationContext,
      detection: AvailableDetection,
    ): Promise<AgentInspection> {
      return inspectHermes(detection, {
        envDefinesCredential: await envFileDefines(
          hermesEnvPath(context),
          HERMES_CREDENTIAL_VARIABLE,
        ),
      });
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
          inspection.warnings[0] ?? "Hermes configuration is not supported.",
          { details: { configPath: inspection.configPath, status: inspection.status } },
        );
      }
      if (!SUPPORTED_PROTOCOLS.includes(intent.protocol)) {
        throw new AgentIntegrationError(
          "PROTOCOL_NOT_SUPPORTED",
          `Hermes cannot consume ${intent.protocol}.`,
          { details: { protocol: intent.protocol, supportedProtocols: SUPPORTED_PROTOCOLS } },
        );
      }

      return planHermesConfig({
        planId: intent.planId,
        createdAt: intent.createdAt,
        configPath: detection.configPath,
        existingContent: await readHermesConfig(detection),
        hubBaseUrl: protocolRootUrl(intent.baseUrl, intent.protocol),
        modelId: intent.inferenceAlias,
        apiMode: hermesApiMode(intent.protocol),
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
        return { valid: true, message: "No Hermes configuration change was required." };
      }
      const inspection = await inspectHermes({ configPath: target.path, configExists: true });
      if (inspection.status !== "configured" || !inspection.managed) {
        return {
          valid: false,
          reason:
            inspection.warnings[0] ??
            `Hermes configuration at ${target.path} does not point at Apexnova AI Hub.`,
        };
      }
      if ((inspection.connection?.modelIds.length ?? 0) === 0) {
        return { valid: false, reason: "The applied Hermes configuration binds no model." };
      }
      return {
        valid: true,
        message: `Hermes configured for ${inspection.connection?.modelIds.join(", ")}.`,
      };
    },

    configRoots(context: IntegrationContext): readonly string[] {
      return hermesConfigRoots(context);
    },

    async planLaunch(request: LaunchRequest): Promise<LaunchPlan> {
      if (request.context.platform === "windows") {
        throw new AgentIntegrationError(
          "AGENT_NOT_FOUND",
          "Hermes Agent has no native Windows build; run it under WSL2.",
        );
      }
      return {
        executable: HERMES_EXECUTABLE,
        args: [...request.args],
        environment: {
          ...request.context.environment,
          ...request.credentialEnvironment,
        },
      };
    },

    async diagnose(context: IntegrationContext): Promise<readonly DiagnosticCheck[]> {
      const checks: DiagnosticCheck[] = [];
      const detection = await detectHermes(context, options.runVersionCommand);
      checks.push({
        id: `${HERMES_AGENT_ID}.discovery`,
        status: detection.status === "not-found" ? "fail" : "pass",
        code: `discovery.${detection.status}`,
        severity: detection.status === "not-found" ? "error" : "info",
        message: `${HERMES_DISPLAY_NAME}: ${detection.status}${detection.productVersion ? ` ${detection.productVersion}` : ""}`,
        ...(detection.status === "not-found"
          ? { remediation: "Install Hermes Agent, or pass --config to point at an existing config.yaml." }
          : {}),
      });
      if (detection.status === "not-found") return checks;

      try {
        const inspection = await inspectHermes(detection, {
          envDefinesCredential: await envFileDefines(
            hermesEnvPath(context),
            HERMES_CREDENTIAL_VARIABLE,
          ),
        });
        const failed = inspection.status === "invalid";
        checks.push({
          id: `${HERMES_AGENT_ID}.config`,
          status: failed ? "fail" : inspection.warnings.length > 0 ? "warning" : inspection.managed ? "pass" : "warning",
          code: `config.${inspection.status}`,
          severity: failed ? "error" : "info",
          message: `${HERMES_DISPLAY_NAME} configuration: ${inspection.status}`,
          ...(inspection.warnings[0] ? { remediation: inspection.warnings[0] } : {}),
        });
      } catch (error) {
        checks.push({
          id: `${HERMES_AGENT_ID}.config`,
          status: "fail",
          code: error instanceof AgentIntegrationError ? `config.${error.code}` : "config.unreadable",
          severity: "error",
          message: `${HERMES_DISPLAY_NAME} configuration could not be read.`,
        });
      }
      return checks;
    },
  };
}

export const hermesIntegration: AgentIntegration = createHermesIntegration();
