import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { password } from "@inquirer/prompts";

import {
  detectAgent,
  IntegrationChangeError,
  runIntegrationChange,
} from "@apexnova-connect/core";
import {
  RoutingAuditLog,
  createRoutingAuditEntry,
  routingAuditPath,
  type RoutingGrounds,
} from "@apexnova-connect/routing";
import { FileConfigExecutor } from "@apexnova-connect/config-engine";
import { SecretValue } from "@apexnova-connect/credential-store";
import {
  AgentIntegrationError,
  isDetectionAvailable,
  type AgentIntegration,
  type AvailableDetection,
  type ChangePlan,
  type ConnectionIntent,
  type DetectionResult,
  type LaunchPlan,
  type ProtocolId,
} from "@apexnova-connect/integration-sdk";
import {
  HubClientError,
  type HubCatalogModel,
  type HubCatalogProtocol,
  type HubCatalogSnapshot,
} from "@apexnova-connect/hub-client";

import {
  compensationSignal,
  credentialStore,
  defaultCredentialHelperCommand,
  currentTime,
  defaultIo,
  hubService,
  integrationContext,
  localStateRoot,
  operationSignal,
  resolvePicker,
  resolveMultiPicker,
  withRuntimeRotationLock,
  CliError,
  EXIT_CODES,
  type CliDependencies,
  type CliPickerItem,
  type ParsedArguments,
  inFlightSignal,
} from "./cli-core.js";
import {
  RuntimeBindingStore,
  bindingModelIds,
  type RuntimeCredentialBinding,
} from "./runtime-binding-store.js";

const RUNTIME_ROTATION_WINDOW_MS = 60 * 60 * 1_000;
export const RUNTIME_CREDENTIAL_TTL_SECONDS = 86_400;

/**
 * How long before expiry a credential should be replaced.
 *
 * The last hour, or the last half of its life, whichever is shorter. A fixed
 * hour was right while every credential lived a day, and became nonsense once
 * the lifetime was configurable (ADR 0030): a ten-minute credential would be
 * due the moment it was issued, and every request would mint another.
 *
 * Bindings written before `issuedAt` existed keep the fixed hour, which for a
 * 24-hour credential is what the halving rule gives anyway.
 */
function rotationWindowMs(binding: RuntimeCredentialBinding): number {
  if (binding.issuedAt === undefined || binding.expiresAt === undefined) return RUNTIME_ROTATION_WINDOW_MS;
  const lifetime = Date.parse(binding.expiresAt) - Date.parse(binding.issuedAt);
  if (!Number.isFinite(lifetime) || lifetime <= 0) return RUNTIME_ROTATION_WINDOW_MS;
  return Math.min(RUNTIME_ROTATION_WINDOW_MS, Math.floor(lifetime / 2));
}

/** The lifetime a renewal should reproduce: the one this binding was issued with. */
function bindingLifetimeSeconds(binding: RuntimeCredentialBinding): number {
  if (binding.issuedAt === undefined || binding.expiresAt === undefined) return RUNTIME_CREDENTIAL_TTL_SECONDS;
  const lifetime = Date.parse(binding.expiresAt) - Date.parse(binding.issuedAt);
  if (!Number.isFinite(lifetime) || lifetime <= 0) return RUNTIME_CREDENTIAL_TTL_SECONDS;
  return Math.max(1, Math.round(lifetime / 1_000));
}

/**
 * Whether a binding is close enough to expiry that a run should replace it
 * rather than start on it.
 *
 * One definition, because there are now three callers -- the pre-launch check,
 * the re-check under the rotation lock, and the gateway's per-request read --
 * and a run that disagrees with itself about what "due" means would renew on
 * one path and not another.
 */
export function runtimeCredentialIsDue(binding: RuntimeCredentialBinding, now: number): boolean {
  if (binding.kind === "user" || binding.expiresAt === undefined) return false;
  return Date.parse(binding.expiresAt) - now <= rotationWindowMs(binding);
}

export interface LaunchOutcome {
  readonly binding: RuntimeCredentialBinding;
  readonly rotated: boolean;
  readonly warnings: readonly string[];
}

function credentialName(integration: AgentIntegration, profile: string): string {
  return `${integration.manifest.displayName} (${profile})`;
}

/**
 * The Hub catalog publishes `openai-chat`, while manifests and integrations use
 * the schema vocabulary `openai-chat-completions`. Bindings and Hub calls keep
 * the Hub spelling; everything handed to an integration uses the schema one.
 */
export function toProtocolId(hubProtocol: string): ProtocolId | undefined {
  if (hubProtocol === "openai-responses") return "openai-responses";
  if (hubProtocol === "openai-chat") return "openai-chat-completions";
  if (hubProtocol === "openai-chat-completions") return "openai-chat-completions";
  if (hubProtocol === "anthropic-messages") return "anthropic-messages";
  return undefined;
}

export function hubProtocolsFor(integration: AgentIntegration): ReadonlySet<string> {
  const hubIds = new Set<string>();
  for (const protocol of integration.supportedProtocols) {
    if (protocol === "openai-chat-completions") {
      hubIds.add("openai-chat");
      hubIds.add("openai-chat-completions");
    } else {
      hubIds.add(protocol);
    }
  }
  return hubIds;
}

function protocolNotSupported(integration: AgentIntegration): CliError {
  return new CliError({
    code: "PROTOCOL_NOT_SUPPORTED",
    message: `The selected model does not expose a protocol ${integration.manifest.displayName} can use.`,
    exitCode: EXIT_CODES.unavailable,
    details: { supportedProtocols: integration.supportedProtocols },
  });
}

/** Detects the product and refuses anything the manifest does not cover. */
export async function detectForCommand(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
): Promise<DetectionResult> {
  return detectAgent(integration, integrationContext(parsed, dependencies));
}

export function requireAvailable(
  detection: DetectionResult,
  integration: AgentIntegration,
): AvailableDetection {
  if (isDetectionAvailable(detection)) return detection;
  if (detection.status === "unsupported") {
    throw new CliError({
      code: "PRODUCT_VERSION_UNSUPPORTED",
      message: detection.unsupportedReason,
      exitCode: EXIT_CODES.conflict,
      details: { agentId: detection.agentId, productVersion: detection.productVersion },
    });
  }
  throw new CliError({
    code: "AGENT_NOT_FOUND",
    message: `${integration.manifest.displayName} was not found in the current environment.`,
    exitCode: EXIT_CODES.unavailable,
    details: { agentId: detection.agentId, configPath: detection.configPath },
  });
}

export function selectProtocol(
  model: HubCatalogModel,
  integration: AgentIntegration,
  requested?: string,
): HubCatalogProtocol {
  const usable = hubProtocolsFor(integration);
  const protocol = requested
    ? model.protocols.find((item) => item.protocol === requested)
    : model.protocols.find((item) => usable.has(item.protocol));
  if (!protocol || !usable.has(protocol.protocol)) throw protocolNotSupported(integration);
  return protocol;
}

/**
 * The one endpoint a whole model set can be served through.
 *
 * A configuration names a protocol and a base URL once and lists models under
 * it, so a set is only a set if every model in it answers on the same pair
 * -- the protocol alone is not enough, because the catalog gives each model
 * its own URL for it, and a set that agrees on `openai-responses` while
 * disagreeing on where it lives would send half the models to an address that
 * does not serve them. Refused by name rather than silently narrowed: dropping
 * the odd one out would leave the user with a model they picked and cannot use.
 */
export function selectSharedProtocol(
  models: readonly HubCatalogModel[],
  integration: AgentIntegration,
  requested?: string,
): HubCatalogProtocol {
  const [primary, ...rest] = models;
  if (!primary) throw protocolNotSupported(integration);
  if (rest.length === 0) return selectProtocol(primary, integration, requested);
  const usable = hubProtocolsFor(integration);
  const candidates = primary.protocols.filter((item) =>
    requested ? item.protocol === requested : usable.has(item.protocol),
  );
  for (const candidate of candidates) {
    if (!usable.has(candidate.protocol)) continue;
    const dissenting = rest.filter(
      (model) => !model.protocols.some(
        (item) => item.protocol === candidate.protocol && item.baseUrl === candidate.baseUrl,
      ),
    );
    if (dissenting.length === 0) return candidate;
  }
  throw new CliError({
    code: "PROTOCOL_NOT_SHARED",
    message: `${integration.manifest.displayName} configures one endpoint for all its models, and the selected models have none in common. Pick models that share a protocol, or configure them one at a time.`,
    exitCode: EXIT_CODES.unavailable,
    details: {
      supportedProtocols: integration.supportedProtocols,
      models: models.map((model) => ({
        id: model.id,
        protocols: model.protocols.map((item) => item.protocol),
      })),
    },
  });
}

/**
 * Accepts what the catalog shows a user. IDs are matched first and exactly, so a
 * model can never be shadowed by another one's alias; aliases resolve only
 * when they name exactly one model, because guessing which of several the
 * user meant is how a request ends up served by a model they did not pick.
 */
export function selectModelByReference(
  catalog: HubCatalogSnapshot,
  reference: string,
): HubCatalogModel | undefined {
  const byId = catalog.models.find((item) => item.id === reference);
  if (byId) return byId;
  const byAlias = catalog.models.filter(
    (item) => item.inferenceAlias === reference || (item.aliases ?? []).includes(reference),
  );
  if (byAlias.length === 1) return byAlias[0];
  if (byAlias.length > 1) {
    throw new CliError({
      code: "MODEL_AMBIGUOUS",
      message: `${reference} names ${byAlias.length} models; use one of their IDs instead.`,
      exitCode: EXIT_CODES.usage,
      details: { modelIds: byAlias.map((item) => item.id) },
    });
  }
  return undefined;
}

/** The model a `--model` reference names, refused if it cannot serve. */
export function requireReferencedModel(
  catalog: HubCatalogSnapshot,
  reference: string,
): HubCatalogModel {
  const model = selectModelByReference(catalog, reference);
  if (!model) {
    throw new CliError({ code: "MODEL_NOT_FOUND", message: "The selected model is not present in the visible Hub catalog.", exitCode: EXIT_CODES.unavailable });
  }
  if (model.availability.status !== "available" && model.availability.status !== "degraded") {
    throw new CliError({ code: "MODEL_UNAVAILABLE", message: `Model ${model.id} is ${model.availability.status}.`, exitCode: EXIT_CODES.unavailable });
  }
  return model;
}

export function compatibleModels(
  integration: AgentIntegration,
  catalog: HubCatalogSnapshot,
): readonly HubCatalogModel[] {
  const usable = hubProtocolsFor(integration);
  // No sort here: the catalog arrives in the order Hub lists its models, which
  // is the order the model plaza shows. `joinCatalog` preserves it.
  return catalog.models.filter((model) =>
    model.availability.status === "available" &&
    model.protocols.some((protocol) => usable.has(protocol.protocol)),
  );
}

function modelLabel(model: HubCatalogModel): CliPickerItem<HubCatalogModel> {
  return {
    label: `${model.displayName} (${model.inferenceAlias})`,
    description: `${model.publisherName ?? model.publisher ?? model.modelType ?? "model"} · ${model.availability.status}`,
    value: model,
  };
}

export async function resolveModel(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  catalog: HubCatalogSnapshot,
  existingModelId?: string,
): Promise<HubCatalogModel> {
  if (parsed.model) return requireReferencedModel(catalog, parsed.model);
  if (existingModelId) {
    const existing = catalog.models.find((item) => item.id === existingModelId);
    if (existing && (existing.availability.status === "available" || existing.availability.status === "degraded")) return existing;
  }
  const compatible = compatibleModels(integration, catalog);
  if (compatible.length === 0) {
    throw new CliError({ code: "MODEL_NOT_FOUND", message: "No compatible models are available.", exitCode: EXIT_CODES.unavailable });
  }
  const io = dependencies.io ?? defaultIo();
  if (io.isInteractive && !parsed.nonInteractive && !parsed.json) {
    return resolvePicker(dependencies)(
      "Select a model:",
      compatible.map((model) => modelLabel(model)),
    );
  }
  throw new CliError({
    code: "MODEL_REQUIRED",
    message: "No model is bound yet and the terminal is not interactive; pass --model <id>. Run `apexnova models --json` to list them.",
    exitCode: EXIT_CODES.usage,
    details: { compatibleModelIds: compatible.map((model) => model.id) },
  });
}

/**
 * Every model this connection should offer, default first.
 *
 * One credential covers the whole set, so choosing several here is what lets the
 * Agent's own model picker work afterwards without Connect issuing anything new.
 * The default is asked for separately once more than one is chosen: it is the
 * model the Agent opens on, and inferring it from the order a checkbox happened
 * to list things in would be a decision nobody made.
 *
 * `--model` may be repeated; the first names the default. On a
 * non-interactive terminal it is the only way in, which is why an unbound
 * profile there is an error rather than a prompt.
 */
export async function resolveModels(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  catalog: HubCatalogSnapshot,
  options: { readonly alreadyBound?: readonly string[] } = {},
): Promise<readonly HubCatalogModel[]> {
  const references = parsed.models ?? (parsed.model ? [parsed.model] : []);
  if (references.length > 0) {
    const selected: HubCatalogModel[] = [];
    for (const reference of references) {
      const model = requireReferencedModel(catalog, reference);
      if (!selected.some((item) => item.id === model.id)) selected.push(model);
    }
    return selected;
  }

  const bound = options.alreadyBound ?? [];
  if (bound.length > 0) {
    const kept = bound
      .map((id) => catalog.models.find((item) => item.id === id))
      .filter((item): item is HubCatalogModel =>
        item !== undefined &&
        (item.availability.status === "available" || item.availability.status === "degraded"));
    if (kept.length > 0) return kept;
  }

  const compatible = compatibleModels(integration, catalog);
  if (compatible.length === 0) {
    throw new CliError({ code: "MODEL_NOT_FOUND", message: "No compatible models are available.", exitCode: EXIT_CODES.unavailable });
  }
  const io = dependencies.io ?? defaultIo();
  if (!io.isInteractive || parsed.nonInteractive || parsed.json) {
    throw new CliError({
      code: "MODEL_REQUIRED",
      message: "No model is bound yet and the terminal is not interactive; pass --model <id> (repeat it for more than one model). Run `apexnova models --json` to list them.",
      exitCode: EXIT_CODES.usage,
      details: { compatibleModelIds: compatible.map((model) => model.id) },
    });
  }
  const items = compatible.map((model) => modelLabel(model));
  const chosen = await resolveMultiPicker(dependencies)(
    "Select the models to configure (space to tick, enter to confirm):",
    items,
  );
  if (chosen.length === 0) {
    throw new CliError({ code: "MODEL_REQUIRED", message: "No model was selected.", exitCode: EXIT_CODES.usage });
  }
  if (chosen.length === 1) return chosen;
  // `resolvePicker` returns a single item without prompting, so this only ever
  // asks when there is a real choice to make.
  const preferred = await resolvePicker(dependencies)(
    "Which one should it start on?",
    chosen.map((model) => modelLabel(model)),
  );
  return [preferred, ...chosen.filter((model) => model.id !== preferred.id)];
}

/** Builds the product-neutral description of the connection to configure. */
export function connectionIntent(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  /** The model set, default first. A single model is the one-model case. */
  models: readonly HubCatalogModel[],
  protocol: HubCatalogProtocol,
  catalog: HubCatalogSnapshot,
  // A gateway run points the Agent at loopback on purpose, so the plain-HTTP
  // allowance is stated by the caller that knows it rather than inferred from an
  // environment variable meant for local Hub testing.
  viaLoopbackGateway = false,
): ConnectionIntent {
  const protocolId = toProtocolId(protocol.protocol);
  if (!protocolId || !integration.supportedProtocols.includes(protocolId)) {
    throw protocolNotSupported(integration);
  }
  const model = models[0];
  if (!model) {
    throw new CliError({ code: "MODEL_REQUIRED", message: "A connection needs at least one model.", exitCode: EXIT_CODES.usage });
  }
  for (const item of models) {
    if (!item.inferenceAlias) {
      throw new CliError({ code: "INVALID_RESPONSE", message: `Model ${item.id} has no public inference model alias.`, exitCode: EXIT_CODES.runtime });
    }
  }
  const limits = model.limits;
  const environment = dependencies.environment ?? process.env;
  return {
    planId: `plan.${(dependencies.createRequestId ?? (() => randomUUID()))().replace(/^local_/, "")}`,
    createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
    modelId: model.id,
    inferenceAlias: model.inferenceAlias,
    modelName: model.displayName || model.inferenceAlias,
    models: models.map((item) => {
      return {
        modelId: item.id,
        inferenceAlias: item.inferenceAlias,
        modelName: item.displayName || item.inferenceAlias,
        ...(item.limits?.contextWindow && item.limits.maxOutputTokens
          ? { limits: { context: item.limits.contextWindow, output: item.limits.maxOutputTokens } }
          : {}),
      };
    }),
    protocol: protocolId,
    baseUrl: protocol.baseUrl,
    apiKeyEnvironmentVariable: integration.credentialEnvironmentVariable,
    ...(limits?.contextWindow && limits.maxOutputTokens
      ? { limits: { context: limits.contextWindow, output: limits.maxOutputTokens } }
      : {}),
    allowInsecureLoopback: viaLoopbackGateway || environment.APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK === "1",
    ...(parsed.apiKeyHelper
      ? {
          credentialHelperCommand: (
            dependencies.credentialHelperCommand ?? defaultCredentialHelperCommand
          )(integration.manifest.id, parsed.profile),
        }
      : {}),
  };
}

/**
 * `connect` always issues a short-lived runtime credential; the one-command
 * `run` path defaults to a permanent key unless the user asked otherwise.
 */
export type CredentialMode = "auto" | "runtime";

export async function ensureCredential(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  /** The model set this credential must cover, default first. */
  models: readonly HubCatalogModel[],
  protocol: HubCatalogProtocol,
  mode: CredentialMode = "auto",
): Promise<RuntimeCredentialBinding> {
  const agentId = integration.manifest.id;
  const service = hubService(parsed, dependencies);
  const signal = operationSignal(parsed);
  const model = models[0]!;
  const modelIds = models.map((item) => item.id);
  if (parsed.apiKeyId && mode === "auto") {
    const keyInfo = await service.apiKey(parsed.profile, parsed.apiKeyId, signal);
    const bindings = new RuntimeBindingStore(credentialStore(dependencies));
    const existing = await bindings.load(agentId, parsed.profile);
    if (existing && existing.credentialId === parsed.apiKeyId) return existing;
    const io = dependencies.io ?? defaultIo();
    let secret: string;
    if (io.isInteractive && !parsed.nonInteractive) {
      secret = await password({ message: `Paste the secret for key ${keyInfo.prefix}:`, mask: "*" });
    } else {
      const envKey = (dependencies.environment ?? process.env)[integration.credentialEnvironmentVariable];
      if (!envKey) {
        throw new CliError({
          code: "APPROVAL_REQUIRED",
          message: `--key ${parsed.apiKeyId} requires the key secret; set ${integration.credentialEnvironmentVariable} env var or run in interactive mode.`,
          exitCode: EXIT_CODES.permission,
        });
      }
      secret = envKey;
    }
    if (!secret) throw new CliError({ code: "INVALID_ARGUMENT", message: "An empty key secret was provided.", exitCode: EXIT_CODES.usage });
    return {
      credentialId: keyInfo.id,
      secret: SecretValue.from(secret),
      protocol: protocol.protocol,
      modelId: model.id,
      modelIds,
      kind: "user",
    };
  }
  if (parsed.rotating || parsed.credentialTtlSeconds !== undefined || mode === "runtime") {
    const issuedAt = new Date(currentTime(dependencies)).toISOString();
    const created = await service.createRuntimeCredential(parsed.profile, {
      name: credentialName(integration, parsed.profile),
      protocols: [protocol.protocol],
      modelIds: modelIds,
      expiresIn: parsed.credentialTtlSeconds ?? RUNTIME_CREDENTIAL_TTL_SECONDS,
    }, signal);
    return {
      credentialId: created.credentialId,
      secret: created.secret,
      expiresAt: created.expiresAt,
      // Hub's own expiry is authoritative; `issuedAt` is ours, and the pair is
      // what makes the renewal window a fraction of the life rather than a
      // fixed hour.
      issuedAt,
      protocol: protocol.protocol,
      modelId: model.id,
      modelIds,
      kind: "runtime",
    };
  }

  // The permanent key is the one the user is told does not change until logout,
  // so adding a model widens the key that exists rather than issuing a second
  // one. Hub's PATCH replaces the allowed set, so it is sent the union: the
  // models already configured stay usable, and the new one becomes usable, on
  // the same secret the Agent's configuration already refers to.
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  const existing = await bindings.load(agentId, parsed.profile).catch(() => null);
  if (existing?.kind === "user" && existing.protocol === protocol.protocol) {
    const covered = bindingModelIds(existing);
    const missing = modelIds.filter((id) => !covered.includes(id));
    const union = [...modelIds, ...covered.filter((id) => !modelIds.includes(id))];
    if (missing.length === 0) {
      return { ...existing, modelId: model.id, modelIds: union };
    }
    try {
      const updated = await service.updateApiKey(parsed.profile, existing.credentialId, {
        protocols: [protocol.protocol],
        modelIds: union,
      }, signal);
      // Hub is the authority on what the key may reach, so the widening is read
      // back rather than assumed: a key that silently kept its old set would
      // send the user to a model that fails closed on first use.
      const stillMissing = union.filter((id) => !updated.modelIds.includes(id));
      if (stillMissing.length > 0) {
        throw new CliError({
          code: "VERIFICATION_FAILED",
          message: `Hub did not widen key ${existing.credentialId} to ${stillMissing.join(", ")}.`,
          exitCode: EXIT_CODES.verification,
          details: { credentialId: existing.credentialId, requested: union, granted: updated.modelIds },
        });
      }
      return { ...existing, modelId: model.id, modelIds: union };
    } catch (cause) {
      // A key Hub no longer has cannot be widened. Issuing its replacement is
      // the one case where the stable key legitimately changes, and the caller
      // revokes nothing because there is nothing left to revoke.
      if (!(cause instanceof HubClientError) || cause.code !== "NOT_FOUND") throw cause;
    }
  }

  const created = await service.createApiKey(parsed.profile, {
    name: credentialName(integration, parsed.profile),
    protocols: [protocol.protocol],
    modelIds: modelIds,
    expiresIn: null,
  }, signal);
  return {
    credentialId: created.id,
    secret: created.secret,
    protocol: protocol.protocol,
    modelId: model.id,
    modelIds,
    kind: "user",
  };
}

async function revokeBinding(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  binding: RuntimeCredentialBinding,
): Promise<void> {
  const service = hubService(parsed, dependencies);
  const signal = compensationSignal(parsed);
  if (binding.kind === "runtime") await service.revokeRuntimeCredential(parsed.profile, binding.credentialId, signal);
  else await service.revokeApiKey(parsed.profile, binding.credentialId, signal);
}

export interface ConfigureResult {
  readonly binding: RuntimeCredentialBinding;
  readonly plan: ChangePlan;
  readonly transactionId?: string;
  /** The `selected` audit entry this route was written as, when it could be written. */
  readonly auditEntryId?: string;
  readonly warnings: readonly string[];
}

/**
 * The binding a switch accumulates onto, or null when this one replaces it.
 *
 * A permanent key on the same protocol is the case the "key does not change"
 * promise is about; a runtime credential, or a different protocol, is replaced
 * either way and carries nothing forward.
 */
export function bindingThatSurvives(
  previous: RuntimeCredentialBinding | null | undefined,
  protocol: HubCatalogProtocol,
): RuntimeCredentialBinding | null {
  return previous && previous.kind === "user" && previous.protocol === protocol.protocol ? previous : null;
}

export interface SwitchedModels {
  /** Everything to write, default first: the selection, then what it kept. */
  readonly models: readonly HubCatalogModel[];
  /** Previously configured models nothing can describe any more. */
  readonly dropped: readonly string[];
}

/**
 * The model set a switch leaves behind (ADR 0037 §5).
 *
 * Switching a model adds it to the set rather than replacing it, wherever the
 * credential survives the switch: the user was told the key does not change,
 * and a key that still covers the old models while the configuration has
 * dropped them would offer less than what was paid for. Where the credential is
 * replaced anyway -- `connect`, a rotating run, a gateway run that rolls its own
 * writes back -- `carriesFrom` is null and the set is exactly what was selected.
 *
 * `switch --dry-run` and the write itself both go through here, because a plan
 * that listed a different model set from the one the write produces would be the
 * specific failure this command exists to avoid.
 */
export function modelsAfterSwitch(
  carriesFrom: RuntimeCredentialBinding | null,
  selected: readonly HubCatalogModel[],
  protocol: HubCatalogProtocol,
  catalog: HubCatalogSnapshot,
): SwitchedModels {
  const carried: HubCatalogModel[] = [];
  const dropped: string[] = [];
  if (carriesFrom) {
    for (const id of bindingModelIds(carriesFrom)) {
      if (selected.some((item) => item.id === id)) continue;
      const kept = catalog.models.find((item) => item.id === id);
      // A model that left the catalog, stopped serving this endpoint or went
      // unavailable cannot be written into the configuration: there is nothing
      // left to describe it with. It is named rather than dropped in silence.
      if (kept
        && (kept.availability.status === "available" || kept.availability.status === "degraded")
        && kept.protocols.some((item) => item.protocol === protocol.protocol && item.baseUrl === protocol.baseUrl)
        && kept.inferenceAlias) {
        carried.push(kept);
      } else {
        dropped.push(id);
      }
    }
  }
  return { models: [...selected, ...carried], dropped };
}

/**
 * Mints the credential, then runs the shared change lifecycle from
 * `packages/core`. A failed apply or verify rolls the configuration back and
 * revokes the credential that was just issued, so a half-connected profile
 * cannot survive the command.
 */
export async function configureAgent(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  /** The models this command selected, default first. */
  selected: readonly HubCatalogModel[],
  protocol: HubCatalogProtocol,
  catalog: HubCatalogSnapshot,
  mode: CredentialMode = "auto",
  chosenBy?: { readonly grounds: RoutingGrounds; readonly recommendationId?: string },
  viaLoopbackGateway = false,
): Promise<ConfigureResult> {
  const agentId = integration.manifest.id;
  const context = integrationContext(parsed, dependencies);
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  const previous = await bindings.load(agentId, parsed.profile);
  const model = selected[0];
  if (!model) {
    throw new CliError({ code: "MODEL_REQUIRED", message: "A connection needs at least one model.", exitCode: EXIT_CODES.usage });
  }
  const detection = requireAvailable(
    await detectForCommand(parsed, dependencies, integration),
    integration,
  );

  const keeps = mode === "auto"
    && parsed.apiKeyId === undefined
    && !parsed.rotating
    && parsed.credentialTtlSeconds === undefined;
  const { models, dropped } = modelsAfterSwitch(
    keeps ? bindingThatSurvives(previous, protocol) : null,
    selected,
    protocol,
    catalog,
  );

  const intent = connectionIntent(parsed, dependencies, integration, models, protocol, catalog, viaLoopbackGateway);

  await mkdir(dirname(detection.configPath), { recursive: true, mode: 0o700 });
  const executor = new FileConfigExecutor({
    allowedRoots: [dirname(detection.configPath)],
    backupRoot: join(localStateRoot(dependencies), "backups"),
  });
  const binding = await ensureCredential(parsed, dependencies, integration, models, protocol, mode);
  // Only a credential this call issued may be revoked when something below
  // fails. Reusing the profile's permanent key and then revoking it on a failed
  // write would take away the key every other configured model runs on.
  const issued = binding.credentialId !== previous?.credentialId;
  const revokeIfIssued = async () => {
    if (issued) await revokeBinding(parsed, dependencies, binding).catch(() => {});
  };

  let outcome;
  try {
    outcome = await runIntegrationChange({
      adapter: integration,
      executor,
      context,
      detection,
      intent,
      approve: async () => true,
    });
  } catch (cause) {
    await revokeIfIssued();
    if (cause instanceof IntegrationChangeError) throw cause.cause ?? cause;
    throw cause;
  }

  if (outcome.status === "rolled-back") {
    await revokeIfIssued();
    throw new CliError({
      code: "VERIFICATION_FAILED",
      message: outcome.verification.reason,
      exitCode: EXIT_CODES.verification,
      details: { agentId, planId: outcome.plan.id },
    });
  }
  if (outcome.status === "unavailable" || outcome.status === "declined") {
    await revokeIfIssued();
    throw new CliError({
      code: outcome.status === "declined" ? "APPROVAL_REQUIRED" : "AGENT_NOT_FOUND",
      message: `The ${integration.manifest.displayName} change was not applied.`,
      exitCode: outcome.status === "declined" ? EXIT_CODES.permission : EXIT_CODES.unavailable,
    });
  }

  const receipt = outcome.status === "applied" ? outcome.receipt : undefined;
  const transactionId =
    receipt && typeof receipt.rollbackToken === "object" && receipt.rollbackToken !== null &&
    "transactionId" in receipt.rollbackToken && typeof receipt.rollbackToken.transactionId === "string"
      ? receipt.rollbackToken.transactionId
      : undefined;

  const warnings: string[] = [...outcome.plan.warnings];
  try {
    await bindings.save(agentId, parsed.profile, {
      ...binding,
      ...(transactionId ? { transactionId } : {}),
      ...(previous ? { restoreTarget: {
        protocol: previous.protocol,
        modelId: previous.modelId,
        modelIds: bindingModelIds(previous),
        ...(previous.transactionId ? { transactionId: previous.transactionId } : {}),
        ...(previous.restoreTarget ? { restoreTarget: previous.restoreTarget } : {}),
      } } : {}),
    });
  } catch (cause) {
    const failures: unknown[] = [cause];
    if (receipt) await executor.rollback(receipt).catch((error: unknown) => failures.push(error));
    if (issued) await revokeBinding(parsed, dependencies, binding).catch((error: unknown) => failures.push(error));
    if (failures.length > 1) {
      throw new CliError({ code: "CONNECT_ROLLBACK_INCOMPLETE", message: "Connection failed and cleanup did not fully complete.", exitCode: EXIT_CODES.recovery, cause: new AggregateError(failures) });
    }
    throw cause;
  }

  if (previous && previous.credentialId !== binding.credentialId) {
    try {
      await revokeBinding(parsed, dependencies, previous);
    } catch {
      warnings.push(`Previous credential ${previous.credentialId} could not be revoked automatically.`);
    }
  }

  // The audit entry goes last, once the change is applied and the binding saved:
  // it records a route that happened, not one that was attempted. A route that
  // cannot be explained afterwards is what M5's exit condition is about, so the
  // grounds are recorded beside the outcome -- "switched to X" alone answers
  // which, never why.
  const selection = await recordSelection(parsed, dependencies, integration, model, protocol, catalog, {
    grounds: chosenBy?.grounds ?? (parsed.model !== undefined
      ? "explicit"
      : previous?.modelId === model.id
        ? "existing"
        : "interactive"),
    ...(chosenBy?.recommendationId === undefined ? {} : { recommendationId: chosenBy.recommendationId }),
    planId: outcome.plan.id,
    credentialId: binding.credentialId,
    ...(transactionId ? { transactionId } : {}),
  });
  if (selection.warning !== undefined) warnings.push(selection.warning);
  if (dropped.length > 0) {
    warnings.push(`${dropped.join(", ")} ${dropped.length === 1 ? "is" : "are"} no longer available on this endpoint and ${dropped.length === 1 ? "was" : "were"} removed from the configuration.`);
  }

  return {
    binding,
    plan: outcome.plan,
    ...(transactionId ? { transactionId } : {}),
    ...(selection.entryId === undefined ? {} : { auditEntryId: selection.entryId }),
    warnings,
  };
}

/**
 * Writing the audit must not undo a connection that already happened: the
 * change is applied and the credential is live by this point, so a failure here
 * is reported and the route stands. An unrecorded route is a gap in the log, and
 * the warning says so rather than letting it pass in silence.
 */
async function recordSelection(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  model: HubCatalogModel,
  protocol: HubCatalogProtocol,
  catalog: HubCatalogSnapshot,
  details: {
    readonly grounds: RoutingGrounds;
    readonly recommendationId?: string;
    readonly planId: string;
    readonly credentialId: string;
    readonly transactionId?: string;
  },
): Promise<{ readonly entryId?: string; readonly warning?: string }> {
  try {
    const entry = createRoutingAuditEntry({
      event: "selected",
      agentId: integration.manifest.id,
      integrationId: integration.manifest.id,
      profile: parsed.profile,
      ...(parsed.command ? { command: parsed.command } : {}),
      modelId: model.id,
      providerId: model.providerId,
      protocol: protocol.protocol,
      grounds: details.grounds,
      ...(details.recommendationId === undefined ? {} : { recommendationId: details.recommendationId }),
      catalogVersion: catalog.catalogVersion,
      changePlanId: details.planId,
      credentialId: details.credentialId,
      ...(details.transactionId ? { transactionId: details.transactionId } : {}),
      recordedAt: new Date(currentTime(dependencies)).toISOString(),
    });
    await routingAuditLog(dependencies).append(entry);
    return { entryId: entry.id };
  } catch (cause) {
    return {
      warning: `The route was applied but not written to the audit log: ${
        cause instanceof Error ? cause.message : "unknown error"
      }`,
    };
  }
}

export function routingAuditLog(dependencies: CliDependencies): RoutingAuditLog {
  return new RoutingAuditLog({ path: routingAuditPath(localStateRoot(dependencies)) });
}

/**
 * The `selected` entry a later event belongs to. A run or a verification that
 * made no selection of its own still happened under one, and without the link
 * the log would hold two sequences that never meet -- an attribution nobody can
 * trace back to the decision it priced.
 */
export async function selectionInForce(
  dependencies: CliDependencies,
  agentId: string,
  profile: string,
  modelId: string,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await routingAuditLog(dependencies).list();
  } catch {
    // An unreadable log leaves the later entry unlinked rather than unwritten.
    return undefined;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (
      entry.event === "selected" &&
      entry.agentId === agentId &&
      entry.profile === profile &&
      entry.modelId === modelId
    ) {
      return entry.id;
    }
  }
  return undefined;
}

function defaultLaunch(plan: LaunchPlan): Promise<number> {
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(plan.executable, [...plan.args], {
      env: plan.environment as NodeJS.ProcessEnv,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`The agent exited after signal ${signal}.`));
      else resolveLaunch(code ?? 1);
    });
  });
}

/**
 * Injects the bound secret into the child environment only, then waits for the
 * Agent to exit. The secret never reaches argv, a config file, or a log.
 */
export async function launchAgent(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  binding: RuntimeCredentialBinding,
  agentArgs: readonly string[],
): Promise<void> {
  let plan: LaunchPlan;
  try {
    plan = await integration.planLaunch({
      context: integrationContext(parsed, dependencies),
      credentialEnvironment: {
        [integration.credentialEnvironmentVariable]: binding.secret.reveal(),
      },
      args: agentArgs,
    });
  } catch (error) {
    if (error instanceof AgentIntegrationError) {
      throw new CliError({ code: error.code, message: error.message, exitCode: EXIT_CODES.unavailable, details: error.details, cause: error });
    }
    throw error;
  }
  const exitCode = await (dependencies.launchAgent ?? defaultLaunch)(plan);
  if (exitCode !== 0) {
    throw new CliError({
      code: "AGENT_EXITED",
      message: `${integration.manifest.displayName} exited with code ${exitCode}.`,
      exitCode: EXIT_CODES.runtime,
      details: { agentExitCode: exitCode },
    });
  }
}

export async function runtimeCredentialForLaunch(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  /**
   * Deadline for this renewal. Callers renewing *during* a launched Agent's run
   * must pass `inFlightSignal`: the command's own `operationSignal` has long
   * expired by then, and inheriting it made every renewal past the timeout fail
   * instantly -- on exactly the long runs that are the only ones needing one.
   */
  options: { readonly signal?: AbortSignal } = {},
): Promise<LaunchOutcome> {
  const agentId = integration.manifest.id;
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  const initial = await bindings.load(agentId, parsed.profile);
  if (!initial) throw new CliError({ code: "RUNTIME_CREDENTIAL_NOT_FOUND", message: "No runtime credential is stored for this profile; run connect first.", exitCode: EXIT_CODES.authentication });
  if (!runtimeCredentialIsDue(initial, currentTime(dependencies))) {
    return { binding: initial, rotated: false, warnings: [] as string[] };
  }

  return withRuntimeRotationLock(parsed, dependencies, async () => {
    const current = await bindings.load(agentId, parsed.profile);
    if (!current) throw new CliError({ code: "RUNTIME_CREDENTIAL_NOT_FOUND", message: "No runtime credential is stored for this profile; run connect first.", exitCode: EXIT_CODES.authentication });
    if (!runtimeCredentialIsDue(current, currentTime(dependencies))) {
      return { binding: current, rotated: false, warnings: [] as string[] };
    }
    const service = hubService(parsed, dependencies);
    const signal = options.signal ?? operationSignal(parsed);
    const catalog = await service.catalog(parsed.profile, signal);
    const model = catalog.models.find((item) => item.id === current.modelId);
    const protocol = model?.protocols.find((item) => item.protocol === current.protocol);
    if (!model || !protocol || (model.availability.status !== "available" && model.availability.status !== "degraded")) {
      throw new CliError({ code: "BINDING_MISMATCH", message: "The stored runtime credential cannot be renewed because its model or protocol is no longer available.", exitCode: EXIT_CODES.verification });
    }
    // The replacement covers what the configuration offers, not just the model
    // in force: the Agent is running, and its own model picker can move to any
    // of them between one request and the next.
    const modelIds = bindingModelIds(current);
    // The replacement keeps the lifetime the run was started with. Renewing a
    // ten-minute credential into a day-long one would quietly undo the choice.
    const lifetimeSeconds = bindingLifetimeSeconds(current);
    const issuedAt = new Date(currentTime(dependencies)).toISOString();
    const created = await service.createRuntimeCredential(parsed.profile, {
      name: credentialName(integration, parsed.profile),
      protocols: [current.protocol],
      modelIds: modelIds,
      expiresIn: lifetimeSeconds,
    }, signal);
    const replacement = {
      credentialId: created.credentialId,
      secret: created.secret,
      expiresAt: created.expiresAt,
      issuedAt,
      protocol: current.protocol,
      modelId: current.modelId,
      modelIds,
      ...(current.transactionId ? { transactionId: current.transactionId } : {}),
      ...(current.restoreTarget ? { restoreTarget: current.restoreTarget } : {}),
    };
    try {
      // Measured against this credential's own window, not a fixed hour: with a
      // short lifetime the fixed comparison rejected every replacement Hub sent.
      if (Date.parse(created.expiresAt) - currentTime(dependencies) <= rotationWindowMs(replacement)) {
        throw new CliError({ code: "INVALID_RESPONSE", message: "Hub issued a runtime credential with an insufficient lifetime.", exitCode: EXIT_CODES.runtime });
      }
      const active = (await service.runtimeCredentials(parsed.profile, signal)).find((item) => item.credentialId === created.credentialId);
      if (!active || !active.protocols.includes(current.protocol) || !modelIds.every((id) => active.modelIds.includes(id))) {
        throw new CliError({ code: "VERIFICATION_FAILED", message: "The renewed runtime credential did not pass control-plane verification.", exitCode: EXIT_CODES.verification });
      }
      await bindings.save(agentId, parsed.profile, replacement);
    } catch (cause) {
      await service.revokeRuntimeCredential(parsed.profile, created.credentialId, compensationSignal(parsed)).catch(() => {});
      throw cause;
    }
    const warnings: string[] = [];
    if (current.credentialId !== created.credentialId) {
      try {
        await service.revokeRuntimeCredential(parsed.profile, current.credentialId, compensationSignal(parsed));
      } catch {
        warnings.push(`Previous runtime credential ${current.credentialId} could not be revoked automatically.`);
      }
    }
    return { binding: replacement, rotated: true, warnings };
  }, options.signal === undefined ? {} : { signal: options.signal });
}
