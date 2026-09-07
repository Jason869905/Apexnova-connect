import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  AgentIntegrationError,
  probeExecutableVersion,
  type AgentInspection,
  type CommandProbe,
  type ConfigScope,
  type DetectionResult,
  type IntegrationContext,
  type ManagedConnection,
} from "@apexnova-connect/integration-sdk";

import {
  environmentReference,
  parseHermesConfig,
  HermesConfigError,
  HERMES_PROVIDER_ID,
} from "./hermes-config.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_ENV_BYTES = 4 * 1024 * 1024;

export const HERMES_AGENT_ID = "hermes" as const;
export const HERMES_DISPLAY_NAME = "Hermes Agent" as const;
export const HERMES_EXECUTABLE = "hermes" as const;
export const HERMES_CREDENTIAL_VARIABLE = "APEXNOVA_API_KEY" as const;

export type HermesInspectionErrorCode = "CONFIG_TOO_LARGE" | "CONFIG_READ_FAILED";

export class HermesInspectionError extends AgentIntegrationError {
  declare readonly code: HermesInspectionErrorCode;

  constructor(code: HermesInspectionErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options ?? {});
    this.name = "HermesInspectionError";
  }
}

interface ConfigCandidate {
  readonly path: string;
  readonly scope: ConfigScope;
}

/** `HERMES_HOME` overrides the profile directory; verified in env_loader.py. */
function hermesHome(context: IntegrationContext): string {
  const override = context.environment.HERMES_HOME;
  return override ? resolve(override) : join(resolve(context.homeDirectory), ".hermes");
}

function configCandidates(context: IntegrationContext): ConfigCandidate[] {
  if (context.configPath) {
    return [
      {
        path: isAbsolute(context.configPath)
          ? resolve(context.configPath)
          : resolve(context.workingDirectory, context.configPath),
        scope: "explicit",
      },
    ];
  }
  return [{ path: join(hermesHome(context), "config.yaml"), scope: "global" }];
}

export function hermesConfigRoots(context: IntegrationContext): readonly string[] {
  return [...new Set(configCandidates(context).map((candidate) => dirname(candidate.path)))];
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function detectHermes(
  context: IntegrationContext,
  runVersionCommand?: CommandProbe,
): Promise<DetectionResult> {
  const candidates = configCandidates(context);
  let existing: ConfigCandidate | undefined;
  for (const candidate of candidates) {
    if (await isRegularFile(candidate.path)) {
      existing = candidate;
      break;
    }
  }
  const preferred = existing ?? candidates[0];
  if (!preferred) throw new Error("No Hermes configuration candidate is available.");

  const probe = await probeExecutableVersion({
    executable: HERMES_EXECUTABLE,
    displayName: HERMES_DISPLAY_NAME,
    platform: context.platform,
    ...(runVersionCommand ? { run: runVersionCommand } : {}),
  });

  const evidence = [...probe.evidence];
  if (existing) evidence.push(`configuration file found (${existing.scope})`);

  return {
    agentId: HERMES_AGENT_ID,
    displayName: HERMES_DISPLAY_NAME,
    status: probe.found ? "installed" : existing ? "config-only" : "not-found",
    ...(probe.version ? { productVersion: probe.version } : {}),
    configPath: preferred.path,
    configExists: existing !== undefined,
    configScope: preferred.scope,
    evidence,
    warnings: probe.warnings,
  };
}

export interface HermesInspectionTarget {
  readonly configPath: string;
  readonly configExists: boolean;
}

export async function readHermesConfig(
  target: HermesInspectionTarget,
): Promise<string | null> {
  if (!target.configExists) return null;
  let size: number;
  try {
    size = (await stat(target.configPath)).size;
  } catch (cause) {
    throw new HermesInspectionError(
      "CONFIG_READ_FAILED",
      "Hermes configuration could not be read.",
      { cause },
    );
  }
  if (size > MAX_CONFIG_BYTES) {
    throw new HermesInspectionError(
      "CONFIG_TOO_LARGE",
      "Hermes configuration exceeds the 2 MiB inspection limit.",
    );
  }
  try {
    return await readFile(target.configPath, "utf8");
  } catch (cause) {
    throw new HermesInspectionError(
      "CONFIG_READ_FAILED",
      "Hermes configuration could not be read.",
      { cause },
    );
  }
}

/**
 * Whether `~/.hermes/.env` assigns `variable`. Hermes loads that file over the
 * process environment, so a definition there silently beats the credential the
 * launcher injects. Only key names are examined; no value is ever read out of
 * the file, and an unreadable file is simply reported as "unknown".
 */
export async function envFileDefines(
  envPath: string,
  variable: string,
): Promise<boolean | undefined> {
  let content: string;
  try {
    if ((await stat(envPath)).size > MAX_ENV_BYTES) return undefined;
    content = await readFile(envPath, "utf8");
  } catch {
    return undefined;
  }
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`, "m");
  return assignment.test(content);
}

export function hermesEnvPath(context: IntegrationContext): string {
  return join(hermesHome(context), ".env");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function inspectHermes(
  target: HermesInspectionTarget,
  options: { readonly envDefinesCredential?: boolean | undefined } = {},
): Promise<AgentInspection> {
  const base = { agentId: HERMES_AGENT_ID, configPath: target.configPath } as const;
  const content = await readHermesConfig(target);
  if (content === null) {
    return { ...base, status: "not-configured", managed: false, warnings: [] };
  }

  let document;
  try {
    document = parseHermesConfig(content);
  } catch (error) {
    return {
      ...base,
      status: "invalid",
      managed: false,
      warnings: [
        error instanceof HermesConfigError
          ? error.message
          : "Hermes configuration could not be parsed.",
      ],
    };
  }

  const baseUrl = optionalString(document.getIn(["model", "base_url"]));
  if (!baseUrl) {
    return { ...base, status: "not-configured", managed: false, warnings: [] };
  }

  const apiKey = optionalString(document.getIn(["model", "api_key"]));
  const ourReference = environmentReference(HERMES_CREDENTIAL_VARIABLE);
  // Nobody else would reference our variable, so the reference is the marker.
  const managed = apiKey === ourReference;
  const apiMode = optionalString(document.getIn(["model", "api_mode"]));
  const provider = optionalString(document.getIn(["model", "provider"]));
  const model = optionalString(document.getIn(["model", "default"]));

  const warnings: string[] = [];
  if (!managed) {
    warnings.push(
      "A custom model endpoint is configured that Apexnova-connect did not write.",
    );
    if (apiKey && !apiKey.startsWith("${")) {
      warnings.push(
        "The Hermes configuration holds a literal api_key rather than an environment reference.",
      );
    }
  }
  if (managed && options.envDefinesCredential === true) {
    warnings.push(
      `${HERMES_CREDENTIAL_VARIABLE} is defined in ~/.hermes/.env, which Hermes loads over the process environment; it will override the credential the launcher injects. Remove it from .env.`,
    );
  }
  if (managed && provider !== HERMES_PROVIDER_ID) {
    warnings.push(
      `Hermes model.provider is ${provider ?? "unset"} rather than ${HERMES_PROVIDER_ID}; the configured endpoint may not be used.`,
    );
  }

  const protocol: ManagedConnection["protocol"] =
    apiMode === "codex_responses"
      ? "openai-responses"
      : apiMode === "chat_completions"
        ? "openai-chat-completions"
        : apiMode === "anthropic_messages"
          ? "anthropic-messages"
          : "unknown";

  return {
    ...base,
    status: "configured",
    managed,
    connection: {
      providerId: provider ?? HERMES_PROVIDER_ID,
      protocol,
      baseUrl,
      environmentVariables: managed ? [HERMES_CREDENTIAL_VARIABLE] : [],
      // Hermes binds one model at a time through model.default.
      modelIds: managed && model ? [model] : [],
      ...(managed && model ? { defaultModelId: model } : {}),
    },
    warnings,
  };
}
