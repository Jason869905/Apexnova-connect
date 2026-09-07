import { stat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

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
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { OPENCODE_PROVIDER_ID } from "./open-code-v2-config.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

export const OPENCODE_AGENT_ID = "opencode" as const;
export const OPENCODE_DISPLAY_NAME = "OpenCode" as const;
export const OPENCODE_EXECUTABLE = "opencode" as const;

export type OpenCodeInspectionErrorCode = "CONFIG_TOO_LARGE" | "CONFIG_READ_FAILED";

export class OpenCodeInspectionError extends AgentIntegrationError {
  declare readonly code: OpenCodeInspectionErrorCode;

  constructor(
    code: OpenCodeInspectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options ?? {});
    this.name = "OpenCodeInspectionError";
  }
}

interface ConfigCandidate {
  readonly path: string;
  readonly scope: ConfigScope;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueCandidates(
  candidates: readonly ConfigCandidate[],
  context: IntegrationContext,
): ConfigCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key =
      context.platform === "windows" ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function openCodeConfigRoots(context: IntegrationContext): readonly string[] {
  return [...new Set(configCandidates(context).map((candidate) => dirnameOf(candidate.path)))];
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}

function configCandidates(context: IntegrationContext): ConfigCandidate[] {
  const cwd = resolve(context.workingDirectory);
  const homeDirectory = resolve(context.homeDirectory);
  const environment = context.environment;
  const candidates: ConfigCandidate[] = [];

  if (context.configPath) {
    candidates.push({
      path: isAbsolute(context.configPath)
        ? resolve(context.configPath)
        : resolve(cwd, context.configPath),
      scope: "explicit",
    });
  }

  candidates.push(
    { path: join(cwd, "opencode.jsonc"), scope: "project" },
    { path: join(cwd, "opencode.json"), scope: "project" },
  );

  if (environment.XDG_CONFIG_HOME) {
    candidates.push(
      { path: join(environment.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"), scope: "global" },
      { path: join(environment.XDG_CONFIG_HOME, "opencode", "opencode.json"), scope: "global" },
    );
  }

  candidates.push(
    { path: join(homeDirectory, ".config", "opencode", "opencode.jsonc"), scope: "global" },
    { path: join(homeDirectory, ".config", "opencode", "opencode.json"), scope: "global" },
  );

  if (context.platform === "windows" && environment.APPDATA) {
    candidates.push(
      { path: join(environment.APPDATA, "opencode", "opencode.jsonc"), scope: "global" },
      { path: join(environment.APPDATA, "opencode", "opencode.json"), scope: "global" },
    );
  }

  return uniqueCandidates(candidates, context);
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function detectOpenCode(
  context: IntegrationContext,
  runVersionCommand?: CommandProbe,
): Promise<DetectionResult> {
  const candidates = configCandidates(context);
  const explicitCandidate = candidates.find((candidate) => candidate.scope === "explicit");
  let existingCandidate: ConfigCandidate | undefined;
  const candidatesToProbe = explicitCandidate ? [explicitCandidate] : candidates;
  for (const candidate of candidatesToProbe) {
    if (await isRegularFile(candidate.path)) {
      existingCandidate = candidate;
      break;
    }
  }

  const preferredCandidate =
    existingCandidate ??
    explicitCandidate ??
    candidates.find((candidate) => candidate.scope === "global") ??
    candidates[0];
  if (!preferredCandidate) throw new Error("No OpenCode configuration candidate is available.");

  const probe = await probeExecutableVersion({
    executable: OPENCODE_EXECUTABLE,
    displayName: OPENCODE_DISPLAY_NAME,
    platform: context.platform,
    ...(runVersionCommand ? { run: runVersionCommand } : {}),
  });

  const evidence = [...probe.evidence];
  if (existingCandidate) {
    evidence.push(`configuration file found (${existingCandidate.scope})`);
  }

  return {
    agentId: OPENCODE_AGENT_ID,
    displayName: OPENCODE_DISPLAY_NAME,
    status: probe.found ? "installed" : existingCandidate ? "config-only" : "not-found",
    ...(probe.version ? { productVersion: probe.version } : {}),
    configPath: preferredCandidate.path,
    configExists: existingCandidate !== undefined,
    configScope: preferredCandidate.scope,
    evidence,
    warnings: probe.warnings,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeBaseUrl(value: string | undefined): {
  readonly value?: string;
  readonly warning?: string;
} {
  if (!value) return {};
  try {
    const url = new URL(value);
    const changed = Boolean(url.username || url.password || url.search || url.hash);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return {
      value: url.toString().replace(/\/$/, ""),
      ...(changed
        ? { warning: "Sensitive URL components were removed from the displayed OpenCode base URL." }
        : {}),
    };
  } catch {
    return { warning: "The configured OpenCode base URL is invalid and was omitted." };
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function inferProtocol(
  packageName: string | undefined,
): NonNullable<ManagedConnection["protocol"]> {
  if (packageName === "@ai-sdk/openai") return "openai-responses";
  if (packageName === "@ai-sdk/openai-compatible") return "openai-chat-completions";
  return "unknown";
}

/** Only the target file matters here, so a plan's write target can be re-inspected. */
export interface OpenCodeInspectionTarget {
  readonly configPath: string;
  readonly configExists: boolean;
}

export async function inspectOpenCode(
  detection: OpenCodeInspectionTarget,
): Promise<AgentInspection> {
  if (!detection.configExists) {
    return {
      agentId: OPENCODE_AGENT_ID,
      configPath: detection.configPath,
      status: "not-configured",
      managed: false,
      warnings: [],
    };
  }

  let content: string;
  try {
    const metadata = await stat(detection.configPath);
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new OpenCodeInspectionError(
        "CONFIG_TOO_LARGE",
        "OpenCode configuration exceeds the 2 MiB inspection limit.",
      );
    }
    content = await readFile(detection.configPath, "utf8");
  } catch (error) {
    if (error instanceof OpenCodeInspectionError) throw error;
    throw new OpenCodeInspectionError(
      "CONFIG_READ_FAILED",
      "OpenCode configuration could not be read.",
      { cause: error },
    );
  }

  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isJsonObject(value)) {
    const warning = errors.length
      ? errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")
      : "configuration root is not an object";
    return {
      agentId: OPENCODE_AGENT_ID,
      configPath: detection.configPath,
      status: "invalid",
      managed: false,
      warnings: [`OpenCode configuration is invalid: ${warning}.`],
    };
  }

  if ("providers" in value) {
    return {
      agentId: OPENCODE_AGENT_ID,
      configPath: detection.configPath,
      status: "legacy",
      managed: false,
      warnings: ["Unsupported plural OpenCode providers configuration was detected; migrate it to the current provider/npm/options schema before connecting."],
    };
  }

  if ("provider" in value && !isJsonObject(value.provider)) {
    return {
      agentId: OPENCODE_AGENT_ID,
      configPath: detection.configPath,
      status: "invalid",
      managed: false,
      warnings: ["OpenCode configuration is invalid: provider must be an object."],
    };
  }

  const providers = isJsonObject(value.provider) ? value.provider : {};
  const provider = isJsonObject(providers[OPENCODE_PROVIDER_ID])
    ? providers[OPENCODE_PROVIDER_ID]
    : undefined;
  if (!provider) {
    return {
      agentId: OPENCODE_AGENT_ID,
      configPath: detection.configPath,
      status: "not-configured",
      managed: false,
      warnings: [],
    };
  }

  const settings = isJsonObject(provider.options) ? provider.options : {};
  const models = isJsonObject(provider.models) ? provider.models : {};
  const providerName = optionalString(provider.name);
  const packageName = optionalString(provider.npm);
  const baseUrl = sanitizeBaseUrl(optionalString(settings.baseURL));
  const defaultModel = optionalString(value.model);
  const providerPrefix = `${OPENCODE_PROVIDER_ID}/`;

  return {
    agentId: OPENCODE_AGENT_ID,
    configPath: detection.configPath,
    status: "configured",
    managed: true,
    connection: {
      providerId: OPENCODE_PROVIDER_ID,
      ...(providerName ? { displayName: providerName } : {}),
      ...(packageName ? { packageName } : {}),
      protocol: inferProtocol(packageName),
      ...(baseUrl.value ? { baseUrl: baseUrl.value } : {}),
      environmentVariables: stringArray(provider.env),
      modelIds: Object.keys(models).sort(),
      ...(defaultModel?.startsWith(providerPrefix)
        ? { defaultModelId: defaultModel.slice(providerPrefix.length) }
        : {}),
    },
    warnings: baseUrl.warning ? [baseUrl.warning] : [],
  };
}
