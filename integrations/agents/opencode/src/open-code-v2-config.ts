import { createHash } from "node:crypto";

import type { ChangePlan } from "@apexnova-connect/integration-sdk";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";

export const OPENCODE_PROVIDER_ID = "apexnova" as const;
export const OPENCODE_PROVIDER_NAME = "Apexnova AI Hub" as const;

export type OpenCodeProtocol = "openai-responses" | "openai-chat-completions";

export interface OpenCodeModelInput {
  readonly id: string;
  readonly name: string;
  readonly protocol: OpenCodeProtocol;
  readonly upstreamId?: string;
  readonly limits?: {
    readonly context: number;
    readonly output: number;
  };
}

export interface PlanOpenCodeV2ConfigOptions {
  readonly planId: string;
  readonly createdAt: string;
  readonly configPath: string;
  readonly existingContent: string | null;
  readonly hubBaseUrl: string;
  readonly apiKeyEnvironmentVariable?: string;
  readonly models: readonly OpenCodeModelInput[];
  readonly defaultModelId?: string;
}

export class OpenCodeConfigError extends Error {
  readonly code:
    | "INVALID_CONFIG"
    | "LEGACY_CONFIG"
    | "INVALID_INPUT"
    | "MIXED_PROTOCOLS";

  constructor(code: OpenCodeConfigError["code"], message: string) {
    super(message);
    this.name = "OpenCodeConfigError";
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(content: string): JsonObject {
  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new OpenCodeConfigError(
      "INVALID_CONFIG",
      `OpenCode configuration is not valid JSONC: ${details}.`,
    );
  }

  if (!isJsonObject(value)) {
    throw new OpenCodeConfigError(
      "INVALID_CONFIG",
      "OpenCode configuration root must be an object.",
    );
  }

  if ("provider" in value && !("providers" in value)) {
    throw new OpenCodeConfigError(
      "LEGACY_CONFIG",
      "Legacy OpenCode provider configuration was detected; migrate to OpenCode v2 before applying this integration.",
    );
  }

  if ("providers" in value && !isJsonObject(value.providers)) {
    throw new OpenCodeConfigError(
      "INVALID_CONFIG",
      "OpenCode v2 providers must be an object.",
    );
  }

  return value;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenCodeConfigError(
      "INVALID_INPUT",
      "Apexnova AI Hub base URL must be a valid HTTPS URL.",
    );
  }

  if (url.protocol !== "https:") {
    throw new OpenCodeConfigError(
      "INVALID_INPUT",
      "Apexnova AI Hub base URL must use HTTPS.",
    );
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function validateModels(models: readonly OpenCodeModelInput[]): OpenCodeProtocol {
  if (models.length === 0) {
    throw new OpenCodeConfigError(
      "INVALID_INPUT",
      "At least one Apexnova AI Hub model is required.",
    );
  }

  const ids = new Set<string>();
  for (const model of models) {
    if (!model.id || /\s/.test(model.id) || !model.name.trim()) {
      throw new OpenCodeConfigError(
        "INVALID_INPUT",
        "Model IDs must be non-empty without whitespace and model names must be non-empty.",
      );
    }
    if (ids.has(model.id)) {
      throw new OpenCodeConfigError(
        "INVALID_INPUT",
        `Duplicate model ID ${model.id}.`,
      );
    }
    ids.add(model.id);

    if (
      model.limits &&
      (!Number.isSafeInteger(model.limits.context) ||
        model.limits.context <= 0 ||
        !Number.isSafeInteger(model.limits.output) ||
        model.limits.output <= 0)
    ) {
      throw new OpenCodeConfigError(
        "INVALID_INPUT",
        `Model ${model.id} has invalid token limits.`,
      );
    }
  }

  const protocols = new Set(models.map((model) => model.protocol));
  if (protocols.size !== 1) {
    throw new OpenCodeConfigError(
      "MIXED_PROTOCOLS",
      "One OpenCode provider cannot mix Responses and Chat Completions models; create separate provider plans.",
    );
  }

  return models[0]!.protocol;
}

function providerPackage(protocol: OpenCodeProtocol): string {
  return protocol === "openai-responses"
    ? "@opencode-ai/ai/providers/openai-compatible/responses"
    : "@opencode-ai/ai/providers/openai-compatible";
}

function createProvider(
  models: readonly OpenCodeModelInput[],
  hubBaseUrl: string,
  apiKeyEnvironmentVariable: string,
): JsonObject {
  const protocol = validateModels(models);
  const modelEntries = models.map((model) => {
    const definition: JsonObject = {
      name: model.name,
      modelID: model.upstreamId ?? model.id,
    };

    if (model.limits) {
      definition.limit = {
        context: model.limits.context,
        output: model.limits.output,
      };
    }

    return [model.id, definition] as const;
  });

  return {
    name: OPENCODE_PROVIDER_NAME,
    env: [apiKeyEnvironmentVariable],
    package: providerPackage(protocol),
    settings: {
      baseURL: normalizeBaseUrl(hubBaseUrl),
    },
    models: Object.fromEntries(modelEntries),
  };
}

function formattingOptions(content: string) {
  return {
    insertSpaces: true,
    tabSize: 2,
    eol: content.includes("\r\n") ? "\r\n" : "\n",
  } as const;
}

function updateConfig(
  content: string,
  path: (string | number)[],
  value: unknown,
): string {
  return applyEdits(
    content,
    modify(content, path, value, {
      formattingOptions: formattingOptions(content),
    }),
  );
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function assertAbsolutePath(configPath: string): void {
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(configPath)) {
    throw new OpenCodeConfigError(
      "INVALID_INPUT",
      "OpenCode configuration path must be absolute.",
    );
  }
}

export function planOpenCodeV2Config(
  options: PlanOpenCodeV2ConfigOptions,
): ChangePlan {
  assertAbsolutePath(options.configPath);

  const apiKeyEnvironmentVariable =
    options.apiKeyEnvironmentVariable ?? "APEXNOVA_API_KEY";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnvironmentVariable)) {
    throw new OpenCodeConfigError(
      "INVALID_INPUT",
      "API key environment variable must use uppercase shell variable syntax.",
    );
  }

  const source = options.existingContent ?? "{}\n";
  parseConfig(source);

  const provider = createProvider(
    options.models,
    options.hubBaseUrl,
    apiKeyEnvironmentVariable,
  );
  let content = updateConfig(
    source,
    ["providers", OPENCODE_PROVIDER_ID],
    provider,
  );

  if (options.defaultModelId) {
    if (!options.models.some((model) => model.id === options.defaultModelId)) {
      throw new OpenCodeConfigError(
        "INVALID_INPUT",
        `Default model ${options.defaultModelId} is not present in the model catalog.`,
      );
    }
    content = updateConfig(
      content,
      ["model"],
      `${OPENCODE_PROVIDER_ID}/${options.defaultModelId}`,
    );
  }

  parseConfig(content);

  const operations =
    options.existingContent !== null && content === options.existingContent
      ? []
      : [
          {
            type: "write-file" as const,
            path: options.configPath,
            mode:
              options.existingContent === null
                ? ("create" as const)
                : ("update" as const),
            expectedContentHash:
              options.existingContent === null
                ? null
                : contentHash(options.existingContent),
            content,
            containsSecrets: false as const,
          },
        ];

  return {
    id: options.planId,
    integrationId: "opencode",
    summary: "Configure OpenCode v2 to use Apexnova AI Hub.",
    createdAt: options.createdAt,
    operations,
    requiresRestart: true,
    warnings: [
      "OpenCode v2 loads provider configuration at startup; restart OpenCode after applying this plan.",
      `The launcher must provide ${apiKeyEnvironmentVariable} from the credential store; no API key is written to the config file.`,
    ],
  };
}
