import { createHash } from "node:crypto";

import {
  AgentIntegrationError,
  assertSafeBaseUrl,
  type ChangePlan,
} from "@apexnova-connect/integration-sdk";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export const CLAUDE_CODE_PROVIDER_ID = "apexnova" as const;

/**
 * Claude Code's settings `env` block wins over a shell export, so a credential
 * written here could never be overridden by the launcher. Only these three keys
 * are managed, and none of them is a secret.
 */
export const BASE_URL_KEY = "ANTHROPIC_BASE_URL" as const;
export const MODEL_KEY = "ANTHROPIC_MODEL" as const;
/** Provenance marker: it records who wrote the keys above, nothing more. */
export const MANAGED_MARKER_KEY = "APEXNOVA_CONNECT" as const;
export const MANAGED_MARKER_VALUE = "managed" as const;

export type ClaudeCodeConfigErrorCode = "INVALID_CONFIG" | "INVALID_INPUT";

export class ClaudeCodeConfigError extends AgentIntegrationError {
  declare readonly code: ClaudeCodeConfigErrorCode;

  constructor(code: ClaudeCodeConfigErrorCode, message: string) {
    super(code, message);
    this.name = "ClaudeCodeConfigError";
  }
}

export interface PlanClaudeCodeSettingsOptions {
  readonly planId: string;
  readonly createdAt: string;
  readonly settingsPath: string;
  readonly existingContent: string | null;
  readonly hubBaseUrl: string;
  readonly modelId: string;
  readonly allowInsecureLoopback?: boolean;
}

type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseClaudeCodeSettings(content: string): JsonObject {
  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    // Report where the file breaks, never what it contains.
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new ClaudeCodeConfigError(
      "INVALID_CONFIG",
      `Claude Code settings are not valid JSON: ${details}.`,
    );
  }
  if (!isJsonObject(value)) {
    throw new ClaudeCodeConfigError(
      "INVALID_CONFIG",
      "Claude Code settings root must be an object.",
    );
  }
  if ("env" in value && !isJsonObject(value.env)) {
    throw new ClaudeCodeConfigError(
      "INVALID_CONFIG",
      "Claude Code settings env must be an object.",
    );
  }
  return value;
}

export function settingsEnvironment(settings: JsonObject): JsonObject {
  return isJsonObject(settings.env) ? settings.env : {};
}

function formattingOptions(content: string) {
  return {
    insertSpaces: true,
    tabSize: 2,
    eol: content.includes("\r\n") ? "\r\n" : "\n",
  } as const;
}

function setKey(content: string, path: (string | number)[], value: unknown): string {
  return applyEdits(
    content,
    modify(content, path, value, { formattingOptions: formattingOptions(content) }),
  );
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function assertAbsolutePath(settingsPath: string): void {
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(settingsPath)) {
    throw new ClaudeCodeConfigError(
      "INVALID_INPUT",
      "Claude Code settings path must be absolute.",
    );
  }
}

/**
 * Writes only the gateway base URL, the bound model and the provenance marker
 * into the settings `env` block. Every other setting in the file — including
 * anything a user or an administrator put there — is left byte-for-byte alone.
 */
export function planClaudeCodeSettings(
  options: PlanClaudeCodeSettingsOptions,
): ChangePlan {
  assertAbsolutePath(options.settingsPath);
  if (!options.modelId || /\s/.test(options.modelId)) {
    throw new ClaudeCodeConfigError(
      "INVALID_INPUT",
      "Model IDs must be non-empty and contain no whitespace.",
    );
  }

  const source = options.existingContent ?? "{}\n";
  parseClaudeCodeSettings(source);

  const baseUrl = assertSafeBaseUrl(options.hubBaseUrl, {
    ...(options.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: options.allowInsecureLoopback }),
  });

  let content = setKey(source, ["env", BASE_URL_KEY], baseUrl);
  content = setKey(content, ["env", MODEL_KEY], options.modelId);
  content = setKey(content, ["env", MANAGED_MARKER_KEY], MANAGED_MARKER_VALUE);

  const applied = settingsEnvironment(parseClaudeCodeSettings(content));
  if (
    applied[BASE_URL_KEY] !== baseUrl ||
    applied[MODEL_KEY] !== options.modelId ||
    applied[MANAGED_MARKER_KEY] !== MANAGED_MARKER_VALUE
  ) {
    throw new ClaudeCodeConfigError(
      "INVALID_CONFIG",
      "Editing the Claude Code settings did not produce the expected gateway configuration; no change was planned.",
    );
  }

  const operations =
    options.existingContent !== null && content === options.existingContent
      ? []
      : [
          {
            type: "write-file" as const,
            path: options.settingsPath,
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
    integrationId: "claude-code",
    summary: "Point Claude Code at Apexnova AI Hub.",
    createdAt: options.createdAt,
    operations,
    requiresRestart: true,
    warnings: [
      "Claude Code reads its settings at startup; restart Claude Code after applying this plan.",
      "No credential is written to the settings file: the settings env block outranks a shell export, so the launcher supplies ANTHROPIC_AUTH_TOKEN instead.",
      "While this connection is applied, starting `claude` yourself sends requests to Apexnova AI Hub without that credential and they will be rejected. Start Claude Code with `apexnova run claude-code`, or restore this transaction to go back.",
      "Remote Control and voice dictation stay unavailable while Claude Code points at a non-Anthropic base URL.",
    ],
  };
}
