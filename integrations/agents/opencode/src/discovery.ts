import { execFile } from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { OPENCODE_PROVIDER_ID } from "./open-code-v2-config.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 3_000;
const VERSION_OUTPUT_BYTES = 64 * 1024;

export type OpenCodeConfigScope = "explicit" | "project" | "global";

export interface OpenCodeCommandResult {
  readonly found: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

export interface OpenCodeDetectionOptions {
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly configPath?: string;
  readonly runVersionCommand?: () => Promise<OpenCodeCommandResult>;
}

export interface OpenCodeDetection {
  readonly agentId: "opencode";
  readonly displayName: "OpenCode";
  readonly status: "installed" | "config-only" | "not-found";
  readonly productVersion?: string;
  readonly configPath: string;
  readonly configExists: boolean;
  readonly configScope: OpenCodeConfigScope;
  readonly evidence: readonly string[];
  readonly warnings: readonly string[];
}

export interface OpenCodeManagedProvider {
  readonly id: typeof OPENCODE_PROVIDER_ID;
  readonly name?: string;
  readonly npm?: string;
  readonly protocol?: "openai-responses" | "openai-chat-completions" | "unknown";
  readonly baseUrl?: string;
  readonly environmentVariables: readonly string[];
  readonly modelIds: readonly string[];
  readonly defaultModelId?: string;
}

export interface OpenCodeInspection {
  readonly agentId: "opencode";
  readonly configPath: string;
  readonly status: "not-configured" | "configured" | "legacy" | "invalid";
  readonly managed: boolean;
  readonly provider?: OpenCodeManagedProvider;
  readonly warnings: readonly string[];
}

export class OpenCodeInspectionError extends Error {
  readonly code: "CONFIG_TOO_LARGE" | "CONFIG_READ_FAILED";

  constructor(code: OpenCodeInspectionError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenCodeInspectionError";
    this.code = code;
  }
}

interface ConfigCandidate {
  readonly path: string;
  readonly scope: OpenCodeConfigScope;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueCandidates(
  candidates: readonly ConfigCandidate[],
  platform: NodeJS.Platform,
): ConfigCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = platform === "win32" ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function configCandidates(options: OpenCodeDetectionOptions): ConfigCandidate[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const candidates: ConfigCandidate[] = [];

  if (options.configPath) {
    candidates.push({
      path: isAbsolute(options.configPath)
        ? resolve(options.configPath)
        : resolve(cwd, options.configPath),
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

  if (platform === "win32" && environment.APPDATA) {
    candidates.push(
      { path: join(environment.APPDATA, "opencode", "opencode.jsonc"), scope: "global" },
      { path: join(environment.APPDATA, "opencode", "opencode.json"), scope: "global" },
    );
  }

  return uniqueCandidates(candidates, platform);
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function defaultVersionCommand(platform: NodeJS.Platform): Promise<OpenCodeCommandResult> {
  const execute = (executable: string, args: readonly string[]) => new Promise<OpenCodeCommandResult>((resolveCommand) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: VERSION_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveCommand({ found: true, stdout, stderr });
          return;
        }
        const code = "code" in error ? error.code : undefined;
        if (code === "ENOENT") {
          resolveCommand({ found: false });
          return;
        }
        resolveCommand({
          found: true,
          stdout,
          stderr,
          error: error.message,
        });
      },
    );
  });

  if (platform !== "win32") return execute("opencode", ["--version"]);

  return execute("where.exe", ["opencode"]).then((located) => {
    if (!located.found || located.error || !located.stdout?.trim()) return { found: false };
    // `.cmd` shims need cmd.exe on Windows. The command is constant; no user input is interpolated.
    return execute("cmd.exe", ["/d", "/s", "/c", "opencode.cmd --version"]);
  });
}

function extractVersion(result: OpenCodeCommandResult): string | undefined {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
}

export async function detectOpenCode(
  options: OpenCodeDetectionOptions = {},
): Promise<OpenCodeDetection> {
  const candidates = configCandidates(options);
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

  const platform = options.platform ?? process.platform;
  const commandResult = await (options.runVersionCommand ?? (() => defaultVersionCommand(platform)))();
  const productVersion = extractVersion(commandResult);
  const evidence: string[] = [];
  const warnings: string[] = [];
  if (commandResult.found) evidence.push("opencode executable responded to --version");
  if (existingCandidate) evidence.push(`configuration file found (${existingCandidate.scope})`);
  if (commandResult.error) {
    warnings.push("The OpenCode executable was found but its version command did not complete successfully.");
  } else if (commandResult.found && !productVersion) {
    warnings.push("The OpenCode executable did not return a recognizable semantic version.");
  }

  return {
    agentId: "opencode",
    displayName: "OpenCode",
    status: commandResult.found ? "installed" : existingCandidate ? "config-only" : "not-found",
    ...(productVersion ? { productVersion } : {}),
    configPath: preferredCandidate.path,
    configExists: existingCandidate !== undefined,
    configScope: preferredCandidate.scope,
    evidence,
    warnings,
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
): NonNullable<OpenCodeManagedProvider["protocol"]> {
  if (!packageName) return "unknown";
  if (packageName === "@ai-sdk/openai") return "openai-responses";
  if (packageName === "@ai-sdk/openai-compatible") return "openai-chat-completions";
  return "unknown";
}

export async function inspectOpenCode(
  detection: OpenCodeDetection,
): Promise<OpenCodeInspection> {
  if (!detection.configExists) {
    return {
      agentId: "opencode",
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
      agentId: "opencode",
      configPath: detection.configPath,
      status: "invalid",
      managed: false,
      warnings: [`OpenCode configuration is invalid: ${warning}.`],
    };
  }

  if ("providers" in value) {
    return {
      agentId: "opencode",
      configPath: detection.configPath,
      status: "legacy",
      managed: false,
      warnings: ["Unsupported plural OpenCode providers configuration was detected; migrate it to the current provider/npm/options schema before connecting."],
    };
  }

  if ("provider" in value && !isJsonObject(value.provider)) {
    return {
      agentId: "opencode",
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
      agentId: "opencode",
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
    agentId: "opencode",
    configPath: detection.configPath,
    status: "configured",
    managed: true,
    provider: {
      id: OPENCODE_PROVIDER_ID,
      ...(providerName ? { name: providerName } : {}),
      ...(packageName ? { npm: packageName } : {}),
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
