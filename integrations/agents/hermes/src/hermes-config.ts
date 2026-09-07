import { createHash } from "node:crypto";

import {
  AgentIntegrationError,
  assertSafeBaseUrl,
  type ChangePlan,
  type ProtocolId,
} from "@apexnova-connect/integration-sdk";
import { parseDocument, YAMLMap, type Document } from "yaml";

/**
 * Hermes routes any URL-bearing endpoint as the `custom` provider, verified in
 * `model_switch.py:direct_alias_runtime_request` on v0.21.0.
 */
export const HERMES_PROVIDER_ID = "custom" as const;

/**
 * `api_mode` values Hermes accepts, from `main_provider_setup.py`. An empty
 * value means auto-detect; this integration always states the mode instead, so
 * a Responses deployment cannot silently fall back to chat completions.
 */
export type HermesApiMode =
  | "chat_completions"
  | "codex_responses"
  | "anthropic_messages";

export function hermesApiMode(protocol: ProtocolId): HermesApiMode {
  if (protocol === "openai-responses") return "codex_responses";
  if (protocol === "openai-chat-completions") return "chat_completions";
  if (protocol === "anthropic-messages") return "anthropic_messages";
  throw new HermesConfigError(
    "INVALID_INPUT",
    `Hermes has no API mode for ${protocol}.`,
  );
}

export type HermesConfigErrorCode = "INVALID_CONFIG" | "INVALID_INPUT";

export class HermesConfigError extends AgentIntegrationError {
  declare readonly code: HermesConfigErrorCode;

  constructor(code: HermesConfigErrorCode, message: string) {
    super(code, message);
    this.name = "HermesConfigError";
  }
}

export interface PlanHermesConfigOptions {
  readonly planId: string;
  readonly createdAt: string;
  readonly configPath: string;
  readonly existingContent: string | null;
  readonly hubBaseUrl: string;
  readonly modelId: string;
  readonly apiMode: HermesApiMode;
  readonly apiKeyEnvironmentVariable?: string;
  readonly allowInsecureLoopback?: boolean;
}

export function parseHermesConfig(content: string): Document.Parsed {
  const document = parseDocument(content, { keepSourceTokens: false });
  if (document.errors.length > 0) {
    // Report where the file breaks, never what it contains.
    const first = document.errors[0]!;
    const at = first.linePos?.[0]
      ? ` at line ${first.linePos[0].line}, column ${first.linePos[0].col}`
      : "";
    throw new HermesConfigError(
      "INVALID_CONFIG",
      `Hermes configuration is not valid YAML${at}.`,
    );
  }
  const root = document.contents;
  if (root !== null && !(root instanceof YAMLMap)) {
    throw new HermesConfigError(
      "INVALID_CONFIG",
      "Hermes configuration root must be a mapping.",
    );
  }
  const model = document.get("model");
  if (model !== undefined && model !== null && !(document.getIn(["model"], true) instanceof YAMLMap)) {
    throw new HermesConfigError(
      "INVALID_CONFIG",
      "Hermes configuration model must be a mapping.",
    );
  }
  return document;
}

export function environmentReference(variable: string): string {
  return `\${${variable}}`;
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function assertAbsolutePath(configPath: string): void {
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(configPath)) {
    throw new HermesConfigError(
      "INVALID_INPUT",
      "Hermes configuration path must be absolute.",
    );
  }
}

/**
 * Rewrites only the five keys of the top-level `model` block that select an
 * endpoint. The YAML document is edited in place, so comments, ordering and
 * every unrelated section survive untouched.
 */
export function planHermesConfig(options: PlanHermesConfigOptions): ChangePlan {
  assertAbsolutePath(options.configPath);

  const apiKeyEnvironmentVariable =
    options.apiKeyEnvironmentVariable ?? "APEXNOVA_API_KEY";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnvironmentVariable)) {
    throw new HermesConfigError(
      "INVALID_INPUT",
      "API key environment variable must use uppercase shell variable syntax.",
    );
  }
  if (!options.modelId || /\s/.test(options.modelId)) {
    throw new HermesConfigError(
      "INVALID_INPUT",
      "Model IDs must be non-empty and contain no whitespace.",
    );
  }

  const source = options.existingContent ?? "";
  const document = parseHermesConfig(source);
  const baseUrl = assertSafeBaseUrl(options.hubBaseUrl, {
    ...(options.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: options.allowInsecureLoopback }),
  });

  document.setIn(["model", "default"], options.modelId);
  document.setIn(["model", "provider"], HERMES_PROVIDER_ID);
  document.setIn(["model", "base_url"], baseUrl);
  document.setIn(["model", "api_key"], environmentReference(apiKeyEnvironmentVariable));
  document.setIn(["model", "api_mode"], options.apiMode);

  const content = document.toString({ lineWidth: 0 });

  // The edit goes through a YAML document rather than text, but reading it back
  // the way Hermes will is what proves the result says what it should.
  const applied = parseHermesConfig(content);
  if (
    applied.getIn(["model", "default"]) !== options.modelId ||
    applied.getIn(["model", "provider"]) !== HERMES_PROVIDER_ID ||
    applied.getIn(["model", "base_url"]) !== baseUrl ||
    applied.getIn(["model", "api_key"]) !==
      environmentReference(apiKeyEnvironmentVariable) ||
    applied.getIn(["model", "api_mode"]) !== options.apiMode
  ) {
    throw new HermesConfigError(
      "INVALID_CONFIG",
      "Editing the Hermes configuration did not produce the expected endpoint; no change was planned.",
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
    integrationId: "hermes",
    summary: "Configure Hermes Agent to use Apexnova AI Hub.",
    createdAt: options.createdAt,
    operations,
    requiresRestart: true,
    warnings: [
      "Hermes reads its configuration at startup; restart Hermes after applying this plan.",
      `The launcher must provide ${apiKeyEnvironmentVariable} from the credential store; no API key is written to the config file or to ~/.hermes/.env.`,
      `Hermes loads ~/.hermes/.env over the process environment, so a ${apiKeyEnvironmentVariable} defined there would override the injected credential; remove it if present.`,
    ],
  };
}
