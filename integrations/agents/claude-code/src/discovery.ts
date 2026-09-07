import { stat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  AgentIntegrationError,
  probeExecutableVersion,
  type AgentInspection,
  type CommandProbe,
  type ConfigScope,
  type DetectionResult,
  type IntegrationContext,
} from "@apexnova-connect/integration-sdk";

import {
  isManagedMarker,
  parseClaudeCodeSettings,
  settingsEnvironment,
  API_KEY_HELPER_KEY,
  BASE_URL_KEY,
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeConfigError,
  MANAGED_HELPER_MARKER_VALUE,
  MANAGED_MARKER_KEY,
  MODEL_KEY,
} from "./claude-code-settings.js";

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;

export const CLAUDE_CODE_AGENT_ID = "claude-code" as const;
export const CLAUDE_CODE_DISPLAY_NAME = "Claude Code" as const;
export const CLAUDE_CODE_EXECUTABLE = "claude" as const;
export const CLAUDE_CODE_CREDENTIAL_VARIABLE = "ANTHROPIC_AUTH_TOKEN" as const;

export type ClaudeCodeInspectionErrorCode = "CONFIG_TOO_LARGE" | "CONFIG_READ_FAILED";

export class ClaudeCodeInspectionError extends AgentIntegrationError {
  declare readonly code: ClaudeCodeInspectionErrorCode;

  constructor(
    code: ClaudeCodeInspectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options ?? {});
    this.name = "ClaudeCodeInspectionError";
  }
}

interface ConfigCandidate {
  readonly path: string;
  readonly scope: ConfigScope;
}

/**
 * Only the user-level settings file is ever written. A project's
 * `.claude/settings.json` is committed and shared with everyone who clones the
 * repository, which is the wrong place for a machine's gateway configuration.
 */
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
  return [
    {
      path: join(resolve(context.homeDirectory), ".claude", "settings.json"),
      scope: "global",
    },
  ];
}

export function claudeCodeConfigRoots(context: IntegrationContext): readonly string[] {
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

export async function detectClaudeCode(
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
  if (!preferred) throw new Error("No Claude Code settings candidate is available.");

  const probe = await probeExecutableVersion({
    executable: CLAUDE_CODE_EXECUTABLE,
    displayName: CLAUDE_CODE_DISPLAY_NAME,
    platform: context.platform,
    ...(runVersionCommand ? { run: runVersionCommand } : {}),
  });

  const evidence = [...probe.evidence];
  if (existing) evidence.push(`settings file found (${existing.scope})`);

  return {
    agentId: CLAUDE_CODE_AGENT_ID,
    displayName: CLAUDE_CODE_DISPLAY_NAME,
    status: probe.found ? "installed" : existing ? "config-only" : "not-found",
    ...(probe.version ? { productVersion: probe.version } : {}),
    configPath: preferred.path,
    configExists: existing !== undefined,
    configScope: preferred.scope,
    evidence,
    warnings: probe.warnings,
  };
}

export interface ClaudeCodeInspectionTarget {
  readonly configPath: string;
  readonly configExists: boolean;
}

export async function readClaudeCodeSettings(
  target: ClaudeCodeInspectionTarget,
): Promise<string | null> {
  if (!target.configExists) return null;
  let size: number;
  try {
    size = (await stat(target.configPath)).size;
  } catch (cause) {
    throw new ClaudeCodeInspectionError(
      "CONFIG_READ_FAILED",
      "Claude Code settings could not be read.",
      { cause },
    );
  }
  if (size > MAX_SETTINGS_BYTES) {
    throw new ClaudeCodeInspectionError(
      "CONFIG_TOO_LARGE",
      "Claude Code settings exceed the 2 MiB inspection limit.",
    );
  }
  try {
    return await readFile(target.configPath, "utf8");
  } catch (cause) {
    throw new ClaudeCodeInspectionError(
      "CONFIG_READ_FAILED",
      "Claude Code settings could not be read.",
      { cause },
    );
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function inspectClaudeCode(
  target: ClaudeCodeInspectionTarget,
): Promise<AgentInspection> {
  const base = { agentId: CLAUDE_CODE_AGENT_ID, configPath: target.configPath } as const;
  const content = await readClaudeCodeSettings(target);
  if (content === null) {
    return { ...base, status: "not-configured", managed: false, warnings: [] };
  }

  let settings;
  try {
    settings = parseClaudeCodeSettings(content);
  } catch (error) {
    return {
      ...base,
      status: "invalid",
      managed: false,
      warnings: [
        error instanceof ClaudeCodeConfigError
          ? error.message
          : "Claude Code settings could not be parsed.",
      ],
    };
  }

  const environment = settingsEnvironment(settings);
  const baseUrl = optionalString(environment[BASE_URL_KEY]);
  const marker = environment[MANAGED_MARKER_KEY];
  const managed = isManagedMarker(marker);
  const helperIsOurs = marker === MANAGED_HELPER_MARKER_VALUE;
  if (!baseUrl) {
    return { ...base, status: "not-configured", managed: false, warnings: [] };
  }

  const warnings: string[] = [];
  if (!managed) {
    warnings.push(
      `${BASE_URL_KEY} is already set in this settings file by something other than Apexnova-connect.`,
    );
  }
  // A credential in the settings file outranks the launcher's injection, so it
  // has to be reported rather than silently overridden. The value is never read.
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    if (environment[key] !== undefined) {
      warnings.push(
        `${key} is set in the settings file and takes precedence over the credential the launcher injects; remove it before connecting.`,
      );
    }
  }
  if (settings[API_KEY_HELPER_KEY] !== undefined && !helperIsOurs) {
    warnings.push(
      "apiKeyHelper is configured by something other than Apexnova-connect and supplies its own credential; the launcher's credential will not be used.",
    );
  }

  const model = optionalString(environment[MODEL_KEY]);
  return {
    ...base,
    status: "configured",
    managed,
    connection: {
      providerId: CLAUDE_CODE_PROVIDER_ID,
      protocol: "anthropic-messages",
      baseUrl,
      // In helper mode Claude Code fetches the credential itself, so no
      // environment variable carries it.
      environmentVariables: helperIsOurs ? [] : [CLAUDE_CODE_CREDENTIAL_VARIABLE],
      modelIds: model ? [model] : [],
      ...(model ? { defaultModelId: model } : {}),
    },
    warnings,
  };
}
