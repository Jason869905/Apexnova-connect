import { createHash } from "node:crypto";

import {
  AgentIntegrationError,
  assertSafeBaseUrl,
  type ChangePlan,
} from "@apexnova-connect/integration-sdk";
import { parse, TomlError } from "smol-toml";

export const CODEX_PROVIDER_ID = "apexnova" as const;
export const CODEX_PROVIDER_NAME = "Apexnova AI Hub" as const;

/** Codex reserves these for its own built-in providers. */
const RESERVED_PROVIDER_IDS = new Set(["openai", "ollama", "lmstudio"]);

const TABLE_HEADER = /^\s*\[/;
const PROVIDER_HEADER =
  /^\s*\[\s*model_providers\s*\.\s*(?:apexnova|"apexnova"|'apexnova')\s*\]\s*(?:#.*)?$/;

export type CodexConfigErrorCode =
  | "INVALID_CONFIG"
  | "UNSUPPORTED_LAYOUT"
  | "INVALID_INPUT";

export class CodexConfigError extends AgentIntegrationError {
  declare readonly code: CodexConfigErrorCode;

  constructor(code: CodexConfigErrorCode, message: string) {
    super(code, message);
    this.name = "CodexConfigError";
  }
}

export interface PlanCodexConfigOptions {
  readonly planId: string;
  readonly createdAt: string;
  readonly configPath: string;
  readonly existingContent: string | null;
  readonly hubBaseUrl: string;
  readonly modelId: string;
  readonly apiKeyEnvironmentVariable?: string;
  readonly allowInsecureLoopback?: boolean;
}

type TomlObject = Record<string, unknown>;

function isTomlObject(value: unknown): value is TomlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCodexConfig(content: string): TomlObject {
  let value: unknown;
  try {
    value = parse(content);
  } catch (error) {
    // A parser message quotes the offending line, which would put the user's
    // configuration into a warning, a log and the JSON envelope. Report only
    // where the problem is.
    const at =
      error instanceof TomlError && typeof error.line === "number"
        ? ` at line ${error.line}, column ${error.column}`
        : "";
    throw new CodexConfigError(
      "INVALID_CONFIG",
      `Codex configuration is not valid TOML${at}.`,
    );
  }
  if (!isTomlObject(value)) {
    throw new CodexConfigError(
      "INVALID_CONFIG",
      "Codex configuration root must be a TOML table.",
    );
  }
  return value;
}

export function codexProviderTable(config: TomlObject): TomlObject | undefined {
  const providers = config.model_providers;
  if (!isTomlObject(providers)) return undefined;
  const provider = providers[CODEX_PROVIDER_ID];
  return isTomlObject(provider) ? provider : undefined;
}

function eol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function quote(value: string): string {
  if (/["\\\u0000-\u001f\u007f]/.test(value)) {
    throw new CodexConfigError(
      "INVALID_INPUT",
      "Codex configuration values must not contain escapes or control characters.",
    );
  }
  return `"${value}"`;
}

/**
 * Replaces or inserts a bare key in the root table, which is everything before
 * the first table header. A key of the same name inside another table belongs
 * to that table and must not be touched.
 */
function setRootKey(lines: string[], key: string, value: string): string[] {
  const firstHeader = lines.findIndex((line) => TABLE_HEADER.test(line));
  const end = firstHeader === -1 ? lines.length : firstHeader;
  const assignment = new RegExp(`^\\s*(?:${key}|"${key}"|'${key}')\\s*=`);
  for (let index = 0; index < end; index += 1) {
    if (assignment.test(lines[index]!)) {
      const replaced = [...lines];
      replaced[index] = `${key} = ${value}`;
      return replaced;
    }
  }
  // Append after the last populated root-table line, so an inserted key does
  // not land between a blank separator and the table header that follows it.
  let insertAt = end;
  while (insertAt > 0 && lines[insertAt - 1]!.trim() === "") insertAt -= 1;
  const inserted = [...lines];
  inserted.splice(insertAt, 0, `${key} = ${value}`);
  return inserted;
}

function setProviderTable(lines: string[], body: readonly string[]): string[] {
  const header = lines.findIndex((line) => PROVIDER_HEADER.test(line));
  if (header === -1) {
    const separator = lines.length > 0 ? [""] : [];
    return [...lines, ...separator, `[model_providers.${CODEX_PROVIDER_ID}]`, ...body];
  }
  let end = header + 1;
  while (end < lines.length && !TABLE_HEADER.test(lines[end]!)) end += 1;
  // Give the next table back the blank line that separated it.
  const separator = end < lines.length ? [""] : [];
  return [...lines.slice(0, header + 1), ...body, ...separator, ...lines.slice(end)];
}

/**
 * Splits into editable lines without the empty element a trailing newline
 * produces, so a rewritten file always ends in exactly one newline and planning
 * the same connection twice is a no-op.
 */
function toLines(source: string): string[] {
  if (source === "") return [];
  const lines = source.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function assertAbsolutePath(configPath: string): void {
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(configPath)) {
    throw new CodexConfigError(
      "INVALID_INPUT",
      "Codex configuration path must be absolute.",
    );
  }
}

/**
 * Plans the Codex `config.toml` change as a minimal text edit: only the root
 * `model` / `model_provider` keys and the `[model_providers.apexnova]` table
 * are rewritten, so comments and every other provider or profile survive. A
 * layout the edit cannot address safely is refused rather than guessed at.
 */
export function planCodexConfig(options: PlanCodexConfigOptions): ChangePlan {
  assertAbsolutePath(options.configPath);

  if (RESERVED_PROVIDER_IDS.has(CODEX_PROVIDER_ID)) {
    throw new CodexConfigError(
      "INVALID_INPUT",
      `Codex reserves the provider ID ${CODEX_PROVIDER_ID}.`,
    );
  }
  const apiKeyEnvironmentVariable =
    options.apiKeyEnvironmentVariable ?? "APEXNOVA_API_KEY";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnvironmentVariable)) {
    throw new CodexConfigError(
      "INVALID_INPUT",
      "API key environment variable must use uppercase shell variable syntax.",
    );
  }
  if (!options.modelId || /\s/.test(options.modelId)) {
    throw new CodexConfigError(
      "INVALID_INPUT",
      "Model IDs must be non-empty and contain no whitespace.",
    );
  }

  const source = options.existingContent ?? "";
  const existing = parseCodexConfig(source);
  const lines = toLines(source);
  if (codexProviderTable(existing) && !lines.some((line) => PROVIDER_HEADER.test(line))) {
    throw new CodexConfigError(
      "UNSUPPORTED_LAYOUT",
      "The Codex configuration declares model_providers.apexnova in a layout this integration cannot edit safely; move it to a [model_providers.apexnova] table or remove it.",
    );
  }

  const baseUrl = assertSafeBaseUrl(options.hubBaseUrl, {
    ...(options.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: options.allowInsecureLoopback }),
  });
  const body = [
    `name = ${quote(CODEX_PROVIDER_NAME)}`,
    `base_url = ${quote(baseUrl)}`,
    `env_key = ${quote(apiKeyEnvironmentVariable)}`,
    // Codex only speaks the Responses API; anything else must never be planned.
    `wire_api = "responses"`,
  ];

  let updated = lines;
  updated = setRootKey(updated, "model", quote(options.modelId));
  updated = setRootKey(updated, "model_provider", quote(CODEX_PROVIDER_ID));
  updated = setProviderTable(updated, body);
  const lineEnding = eol(source);
  const content = `${updated.join(lineEnding)}${lineEnding}`;

  // The edit is textual, so re-read it the way Codex will and refuse to ship a
  // plan whose result does not say what it was supposed to say.
  const applied = parseCodexConfig(content);
  const provider = codexProviderTable(applied);
  if (
    applied.model !== options.modelId ||
    applied.model_provider !== CODEX_PROVIDER_ID ||
    !provider ||
    provider.base_url !== baseUrl ||
    provider.env_key !== apiKeyEnvironmentVariable ||
    provider.wire_api !== "responses"
  ) {
    throw new CodexConfigError(
      "UNSUPPORTED_LAYOUT",
      "Editing the Codex configuration did not produce the expected provider; no change was planned.",
    );
  }

  const operations =
    options.existingContent !== null && content === options.existingContent
      ? []
      : [
          {
            type: "write-file" as const,
            path: options.configPath,
            mode:
              options.existingContent === null ? ("create" as const) : ("update" as const),
            expectedContentHash:
              options.existingContent === null ? null : contentHash(options.existingContent),
            content,
            containsSecrets: false as const,
          },
        ];

  return {
    id: options.planId,
    integrationId: "codex",
    summary: "Configure Codex to use Apexnova AI Hub.",
    createdAt: options.createdAt,
    operations,
    requiresRestart: true,
    warnings: [
      "Codex reads config.toml at startup; restart Codex after applying this plan.",
      `The launcher must provide ${apiKeyEnvironmentVariable} from the credential store; no API key is written to the config file.`,
    ],
  };
}
