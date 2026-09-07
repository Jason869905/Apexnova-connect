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
  codexProviderTable,
  parseCodexConfig,
  CodexConfigError,
  CODEX_PROVIDER_ID,
} from "./codex-config.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

export const CODEX_AGENT_ID = "codex" as const;
export const CODEX_DISPLAY_NAME = "Codex" as const;
export const CODEX_EXECUTABLE = "codex" as const;

export type CodexInspectionErrorCode = "CONFIG_TOO_LARGE" | "CONFIG_READ_FAILED";

export class CodexInspectionError extends AgentIntegrationError {
  declare readonly code: CodexInspectionErrorCode;

  constructor(code: CodexInspectionErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options ?? {});
    this.name = "CodexInspectionError";
  }
}

interface ConfigCandidate {
  readonly path: string;
  readonly scope: ConfigScope;
}

/**
 * Only user-level configuration is ever written. A project's `.codex/config.toml`
 * is committed with the repository and, per Codex, cannot override machine-local
 * provider settings anyway, so writing a provider there would be both surprising
 * and ineffective.
 */
function configCandidates(context: IntegrationContext): ConfigCandidate[] {
  const cwd = resolve(context.workingDirectory);
  const candidates: ConfigCandidate[] = [];

  if (context.configPath) {
    candidates.push({
      path: isAbsolute(context.configPath)
        ? resolve(context.configPath)
        : resolve(cwd, context.configPath),
      scope: "explicit",
    });
    return candidates;
  }

  const codexHome = context.environment.CODEX_HOME;
  if (codexHome) {
    candidates.push({ path: join(resolve(codexHome), "config.toml"), scope: "global" });
  }
  candidates.push({
    path: join(resolve(context.homeDirectory), ".codex", "config.toml"),
    scope: "global",
  });
  return candidates;
}

export function codexConfigRoots(context: IntegrationContext): readonly string[] {
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

export async function detectCodex(
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
  if (!preferred) throw new Error("No Codex configuration candidate is available.");

  const probe = await probeExecutableVersion({
    executable: CODEX_EXECUTABLE,
    displayName: CODEX_DISPLAY_NAME,
    platform: context.platform,
    ...(runVersionCommand ? { run: runVersionCommand } : {}),
  });

  const evidence = [...probe.evidence];
  if (existing) evidence.push(`configuration file found (${existing.scope})`);

  return {
    agentId: CODEX_AGENT_ID,
    displayName: CODEX_DISPLAY_NAME,
    status: probe.found ? "installed" : existing ? "config-only" : "not-found",
    ...(probe.version ? { productVersion: probe.version } : {}),
    configPath: preferred.path,
    configExists: existing !== undefined,
    configScope: preferred.scope,
    evidence,
    warnings: probe.warnings,
  };
}

export interface CodexInspectionTarget {
  readonly configPath: string;
  readonly configExists: boolean;
}

export async function readCodexConfig(target: CodexInspectionTarget): Promise<string | null> {
  if (!target.configExists) return null;
  let size: number;
  try {
    size = (await stat(target.configPath)).size;
  } catch (cause) {
    throw new CodexInspectionError(
      "CONFIG_READ_FAILED",
      "Codex configuration could not be read.",
      { cause },
    );
  }
  if (size > MAX_CONFIG_BYTES) {
    throw new CodexInspectionError(
      "CONFIG_TOO_LARGE",
      "Codex configuration exceeds the 2 MiB inspection limit.",
    );
  }
  try {
    return await readFile(target.configPath, "utf8");
  } catch (cause) {
    throw new CodexInspectionError(
      "CONFIG_READ_FAILED",
      "Codex configuration could not be read.",
      { cause },
    );
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function inspectCodex(
  target: CodexInspectionTarget,
): Promise<AgentInspection> {
  const base = { agentId: CODEX_AGENT_ID, configPath: target.configPath } as const;
  const content = await readCodexConfig(target);
  if (content === null) {
    return { ...base, status: "not-configured", managed: false, warnings: [] };
  }

  let config;
  try {
    config = parseCodexConfig(content);
  } catch (error) {
    return {
      ...base,
      status: "invalid",
      managed: false,
      warnings: [
        error instanceof CodexConfigError
          ? error.message
          : "Codex configuration could not be parsed.",
      ],
    };
  }

  const provider = codexProviderTable(config);
  if (!provider) {
    return { ...base, status: "not-configured", managed: false, warnings: [] };
  }

  const warnings: string[] = [];
  const selected = config.model_provider === CODEX_PROVIDER_ID;
  if (!selected) {
    warnings.push(
      `The Apexnova provider is present but Codex is configured to use ${
        optionalString(config.model_provider) ?? "its default provider"
      }.`,
    );
  }
  const wireApi = optionalString(provider.wire_api) ?? "responses";
  if (wireApi !== "responses") {
    warnings.push(`Codex only supports the Responses API; wire_api is set to ${wireApi}.`);
  }
  const model = optionalString(config.model);

  return {
    ...base,
    status: "configured",
    managed: true,
    connection: {
      providerId: CODEX_PROVIDER_ID,
      ...(optionalString(provider.name) ? { displayName: provider.name as string } : {}),
      protocol: wireApi === "responses" ? "openai-responses" : "unknown",
      ...(optionalString(provider.base_url) ? { baseUrl: provider.base_url as string } : {}),
      environmentVariables: optionalString(provider.env_key)
        ? [provider.env_key as string]
        : [],
      // Codex binds one model at a time through the root `model` key.
      modelIds: selected && model ? [model] : [],
      ...(selected && model ? { defaultModelId: model } : {}),
    },
    warnings,
  };
}
