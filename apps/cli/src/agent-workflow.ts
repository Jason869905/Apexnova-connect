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
  type HubCatalogDeployment,
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
  bindingDeploymentIds,
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
    message: `The selected deployment does not expose a protocol ${integration.manifest.displayName} can use.`,
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
  deployment: HubCatalogDeployment,
  integration: AgentIntegration,
  requested?: string,
): HubCatalogProtocol {
  const usable = hubProtocolsFor(integration);
  const protocol = requested
    ? deployment.protocols.find((item) => item.protocol === requested)
    : deployment.protocols.find((item) => usable.has(item.protocol));
  if (!protocol || !usable.has(protocol.protocol)) throw protocolNotSupported(integration);
  return protocol;
}

/**
 * The one endpoint a whole model set can be served through.
 *
 * A configuration names a protocol and a base URL once and lists models under
 * it, so a set is only a set if every deployment in it answers on the same pair
 * -- the protocol alone is not enough, because the catalog gives each deployment
 * its own URL for it, and a set that agrees on `openai-responses` while
 * disagreeing on where it lives would send half the models to an address that
 * does not serve them. Refused by name rather than silently narrowed: dropping
 * the odd one out would leave the user with a model they picked and cannot use.
 */
export function selectSharedProtocol(
  deployments: readonly HubCatalogDeployment[],
  integration: AgentIntegration,
  requested?: string,
): HubCatalogProtocol {
  const [primary, ...rest] = deployments;
  if (!primary) throw protocolNotSupported(integration);
  if (rest.length === 0) return selectProtocol(primary, integration, requested);
  const usable = hubProtocolsFor(integration);
  const candidates = primary.protocols.filter((item) =>
    requested ? item.protocol === requested : usable.has(item.protocol),
  );
  for (const candidate of candidates) {
    if (!usable.has(candidate.protocol)) continue;
    const dissenting = rest.filter(
      (deployment) => !deployment.protocols.some(
        (item) => item.protocol === candidate.protocol && item.baseUrl === candidate.baseUrl,
      ),
    );
    if (dissenting.length === 0) return candidate;
  }
  throw new CliError({
    code: "PROTOCOL_NOT_SHARED",
    message: `${integration.manifest.displayName} configures one endpoint for all its models, and the selected deployments have none in common. Pick models that share a protocol, or configure them one at a time.`,
    exitCode: EXIT_CODES.unavailable,
    details: {
      supportedProtocols: integration.supportedProtocols,
      deployments: deployments.map((deployment) => ({
        id: deployment.id,
        protocols: deployment.protocols.map((item) => item.protocol),
      })),
    },
  });
}

/**
 * Accepts what the catalog shows a user. IDs are matched first and exactly, so a
 * deployment can never be shadowed by another one's alias; aliases resolve only
 * when they name exactly one deployment, because guessing which of several the
 * user meant is how a request ends up served by a model they did not pick.
 */
export function selectDeploymentByReference(
  catalog: HubCatalogSnapshot,
  reference: string,
): HubCatalogDeployment | undefined {
  const byId = catalog.deployments.find((item) => item.id === reference);
  if (byId) return byId;
  const byAlias = catalog.deployments.filter(
    (item) => item.inferenceAlias === reference || (item.aliases ?? []).includes(reference),
  );
  if (byAlias.length === 1) return byAlias[0];
  if (byAlias.length > 1) {
    throw new CliError({
      code: "DEPLOYMENT_AMBIGUOUS",
      message: `${reference} names ${byAlias.length} deployments; use one of their IDs instead.`,
      exitCode: EXIT_CODES.usage,
      details: { deploymentIds: byAlias.map((item) => item.id) },
    });
  }
  return undefined;
}

/** The deployment a `--deployment` reference names, refused if it cannot serve. */
function requireReferencedDeployment(
  catalog: HubCatalogSnapshot,
  reference: string,
): HubCatalogDeployment {
  const deployment = selectDeploymentByReference(catalog, reference);
  if (!deployment) {
    throw new CliError({ code: "DEPLOYMENT_NOT_FOUND", message: "The selected deployment is not present in the visible Hub catalog.", exitCode: EXIT_CODES.unavailable });
  }
  if (deployment.availability.status !== "available" && deployment.availability.status !== "degraded") {
    throw new CliError({ code: "DEPLOYMENT_UNAVAILABLE", message: `Deployment ${deployment.id} is ${deployment.availability.status}.`, exitCode: EXIT_CODES.unavailable });
  }
  return deployment;
}

function compatibleDeployments(
  integration: AgentIntegration,
  catalog: HubCatalogSnapshot,
): readonly HubCatalogDeployment[] {
  const usable = hubProtocolsFor(integration);
  return catalog.deployments.filter((deployment) =>
    deployment.availability.status === "available" &&
    deployment.protocols.some((protocol) => usable.has(protocol.protocol)),
  );
}

function deploymentLabel(
  deployment: HubCatalogDeployment,
  catalog: HubCatalogSnapshot,
): CliPickerItem<HubCatalogDeployment> {
  const model = catalog.models.find((item) => item.id === deployment.modelId);
  return {
    label: `${deployment.displayName} (${deployment.inferenceAlias})`,
    description: `${model?.name ?? deployment.modelId} · ${deployment.availability.status}`,
    value: deployment,
  };
}

export async function resolveDeployment(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  catalog: HubCatalogSnapshot,
  existingDeploymentId?: string,
): Promise<HubCatalogDeployment> {
  if (parsed.deployment) return requireReferencedDeployment(catalog, parsed.deployment);
  if (existingDeploymentId) {
    const existing = catalog.deployments.find((item) => item.id === existingDeploymentId);
    if (existing && (existing.availability.status === "available" || existing.availability.status === "degraded")) return existing;
  }
  const compatible = compatibleDeployments(integration, catalog);
  if (compatible.length === 0) {
    throw new CliError({ code: "DEPLOYMENT_NOT_FOUND", message: "No compatible deployments are available.", exitCode: EXIT_CODES.unavailable });
  }
  const io = dependencies.io ?? defaultIo();
  if (io.isInteractive && !parsed.nonInteractive && !parsed.json) {
    return resolvePicker(dependencies)(
      "Select a model:",
      compatible.map((deployment) => deploymentLabel(deployment, catalog)),
    );
  }
  throw new CliError({
    code: "DEPLOYMENT_REQUIRED",
    message: "No deployment is bound yet and the terminal is not interactive; pass --deployment <id>. Run `apexnova models --json` to list them.",
    exitCode: EXIT_CODES.usage,
    details: { compatibleDeploymentIds: compatible.map((deployment) => deployment.id) },
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
 * `--deployment` may be repeated; the first names the default. On a
 * non-interactive terminal it is the only way in, which is why an unbound
 * profile there is an error rather than a prompt.
 */
export async function resolveDeployments(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  catalog: HubCatalogSnapshot,
  options: { readonly alreadyBound?: readonly string[] } = {},
): Promise<readonly HubCatalogDeployment[]> {
  const references = parsed.deployments ?? (parsed.deployment ? [parsed.deployment] : []);
  if (references.length > 0) {
    const selected: HubCatalogDeployment[] = [];
    for (const reference of references) {
      const deployment = requireReferencedDeployment(catalog, reference);
      if (!selected.some((item) => item.id === deployment.id)) selected.push(deployment);
    }
    return selected;
  }

  const bound = options.alreadyBound ?? [];
  if (bound.length > 0) {
    const kept = bound
      .map((id) => catalog.deployments.find((item) => item.id === id))
      .filter((item): item is HubCatalogDeployment =>
        item !== undefined &&
        (item.availability.status === "available" || item.availability.status === "degraded"));
    if (kept.length > 0) return kept;
  }

  const compatible = compatibleDeployments(integration, catalog);
  if (compatible.length === 0) {
    throw new CliError({ code: "DEPLOYMENT_NOT_FOUND", message: "No compatible deployments are available.", exitCode: EXIT_CODES.unavailable });
  }
  const io = dependencies.io ?? defaultIo();
  if (!io.isInteractive || parsed.nonInteractive || parsed.json) {
    throw new CliError({
      code: "DEPLOYMENT_REQUIRED",
      message: "No deployment is bound yet and the terminal is not interactive; pass --deployment <id> (repeat it for more than one model). Run `apexnova models --json` to list them.",
      exitCode: EXIT_CODES.usage,
      details: { compatibleDeploymentIds: compatible.map((deployment) => deployment.id) },
    });
  }
  const items = compatible.map((deployment) => deploymentLabel(deployment, catalog));
  const chosen = await resolveMultiPicker(dependencies)(
    "Select the models to configure (space to tick, enter to confirm):",
    items,
  );
  if (chosen.length === 0) {
    throw new CliError({ code: "DEPLOYMENT_REQUIRED", message: "No model was selected.", exitCode: EXIT_CODES.usage });
  }
  if (chosen.length === 1) return chosen;
  // `resolvePicker` returns a single item without prompting, so this only ever
  // asks when there is a real choice to make.
  const preferred = await resolvePicker(dependencies)(
    "Which one should it start on?",
    chosen.map((deployment) => deploymentLabel(deployment, catalog)),
  );
  return [preferred, ...chosen.filter((deployment) => deployment.id !== preferred.id)];
}

/** Builds the product-neutral description of the connection to configure. */
export function connectionIntent(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  /** The model set, default first. A single deployment is the one-model case. */
  deployments: readonly HubCatalogDeployment[],
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
  const deployment = deployments[0];
  if (!deployment) {
    throw new CliError({ code: "DEPLOYMENT_REQUIRED", message: "A connection needs at least one deployment.", exitCode: EXIT_CODES.usage });
  }
  for (const item of deployments) {
    if (!item.inferenceAlias) {
      throw new CliError({ code: "INVALID_RESPONSE", message: `Deployment ${item.id} has no public inference model alias.`, exitCode: EXIT_CODES.runtime });
    }
  }
  const model = catalog.models.find((item) => item.id === deployment.modelId);
  const limits = deployment.limits;
  const environment = dependencies.environment ?? process.env;
  return {
    planId: `plan.${(dependencies.createRequestId ?? (() => randomUUID()))().replace(/^local_/, "")}`,
    createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
    deploymentId: deployment.id,
    inferenceAlias: deployment.inferenceAlias,
    modelName: deployment.displayName || model?.name || deployment.inferenceAlias,
    models: deployments.map((item) => {
      const itemModel = catalog.models.find((entry) => entry.id === item.modelId);
      return {
        deploymentId: item.id,
        inferenceAlias: item.inferenceAlias,
        modelName: item.displayName || itemModel?.name || item.inferenceAlias,
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
  deployments: readonly HubCatalogDeployment[],
  protocol: HubCatalogProtocol,
  mode: CredentialMode = "auto",
): Promise<RuntimeCredentialBinding> {
  const agentId = integration.manifest.id;
  const service = hubService(parsed, dependencies);
  const signal = operationSignal(parsed);
  const deployment = deployments[0]!;
  const deploymentIds = deployments.map((item) => item.id);
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
      deploymentId: deployment.id,
      deploymentIds,
      kind: "user",
    };
  }
  if (parsed.rotating || parsed.credentialTtlSeconds !== undefined || mode === "runtime") {
    const issuedAt = new Date(currentTime(dependencies)).toISOString();
    const created = await service.createRuntimeCredential(parsed.profile, {
      name: credentialName(integration, parsed.profile),
      protocols: [protocol.protocol],
      publicDeploymentIds: deploymentIds,
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
      deploymentId: deployment.id,
      deploymentIds,
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
    const covered = bindingDeploymentIds(existing);
    const missing = deploymentIds.filter((id) => !covered.includes(id));
    const union = [...deploymentIds, ...covered.filter((id) => !deploymentIds.includes(id))];
    if (missing.length === 0) {
      return { ...existing, deploymentId: deployment.id, deploymentIds: union };
    }
    try {
      const updated = await service.updateApiKey(parsed.profile, existing.credentialId, {
        protocols: [protocol.protocol],
        publicDeploymentIds: union,
      }, signal);
      // Hub is the authority on what the key may reach, so the widening is read
      // back rather than assumed: a key that silently kept its old set would
      // send the user to a model that fails closed on first use.
      const stillMissing = union.filter((id) => !updated.publicDeploymentIds.includes(id));
      if (stillMissing.length > 0) {
        throw new CliError({
          code: "VERIFICATION_FAILED",
          message: `Hub did not widen key ${existing.credentialId} to ${stillMissing.join(", ")}.`,
          exitCode: EXIT_CODES.verification,
          details: { credentialId: existing.credentialId, requested: union, granted: updated.publicDeploymentIds },
        });
      }
      return { ...existing, deploymentId: deployment.id, deploymentIds: union };
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
    publicDeploymentIds: deploymentIds,
    expiresIn: null,
  }, signal);
  return {
    credentialId: created.id,
    secret: created.secret,
    protocol: protocol.protocol,
    deploymentId: deployment.id,
    deploymentIds,
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
  selected: readonly HubCatalogDeployment[],
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
  const deployment = selected[0];
  if (!deployment) {
    throw new CliError({ code: "DEPLOYMENT_REQUIRED", message: "A connection needs at least one deployment.", exitCode: EXIT_CODES.usage });
  }
  const detection = requireAvailable(
    await detectForCommand(parsed, dependencies, integration),
    integration,
  );

  // Switching a model adds it to the set rather than replacing it, wherever the
  // credential survives the switch: the user was told the key does not change,
  // and a key that still covers the old models while the configuration has
  // dropped them would offer less than what was paid for. Where the credential
  // is replaced anyway -- `connect`, a rotating run, a gateway run that rolls
  // its own writes back -- the set is exactly what this command selected.
  const keeps = mode === "auto"
    && previous?.kind === "user"
    && previous.protocol === protocol.protocol
    && parsed.apiKeyId === undefined
    && !parsed.rotating
    && parsed.credentialTtlSeconds === undefined;
  const carried: HubCatalogDeployment[] = [];
  const dropped: string[] = [];
  if (keeps && previous) {
    for (const id of bindingDeploymentIds(previous)) {
      if (selected.some((item) => item.id === id)) continue;
      const kept = catalog.deployments.find((item) => item.id === id);
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
  const deployments = [...selected, ...carried];

  const intent = connectionIntent(parsed, dependencies, integration, deployments, protocol, catalog, viaLoopbackGateway);

  await mkdir(dirname(detection.configPath), { recursive: true, mode: 0o700 });
  const executor = new FileConfigExecutor({
    allowedRoots: [dirname(detection.configPath)],
    backupRoot: join(localStateRoot(dependencies), "backups"),
  });
  const binding = await ensureCredential(parsed, dependencies, integration, deployments, protocol, mode);
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
        deploymentId: previous.deploymentId,
        deploymentIds: bindingDeploymentIds(previous),
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
  const selection = await recordSelection(parsed, dependencies, integration, deployment, protocol, catalog, {
    grounds: chosenBy?.grounds ?? (parsed.deployment !== undefined
      ? "explicit"
      : previous?.deploymentId === deployment.id
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
  deployment: HubCatalogDeployment,
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
      deploymentId: deployment.id,
      providerId: deployment.providerId,
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
  deploymentId: string,
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
      entry.deploymentId === deploymentId
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
    const deployment = catalog.deployments.find((item) => item.id === current.deploymentId);
    const protocol = deployment?.protocols.find((item) => item.protocol === current.protocol);
    if (!deployment || !protocol || (deployment.availability.status !== "available" && deployment.availability.status !== "degraded")) {
      throw new CliError({ code: "BINDING_MISMATCH", message: "The stored runtime credential cannot be renewed because its deployment or protocol is no longer available.", exitCode: EXIT_CODES.verification });
    }
    // The replacement covers what the configuration offers, not just the model
    // in force: the Agent is running, and its own model picker can move to any
    // of them between one request and the next.
    const deploymentIds = bindingDeploymentIds(current);
    // The replacement keeps the lifetime the run was started with. Renewing a
    // ten-minute credential into a day-long one would quietly undo the choice.
    const lifetimeSeconds = bindingLifetimeSeconds(current);
    const issuedAt = new Date(currentTime(dependencies)).toISOString();
    const created = await service.createRuntimeCredential(parsed.profile, {
      name: credentialName(integration, parsed.profile),
      protocols: [current.protocol],
      publicDeploymentIds: deploymentIds,
      expiresIn: lifetimeSeconds,
    }, signal);
    const replacement = {
      credentialId: created.credentialId,
      secret: created.secret,
      expiresAt: created.expiresAt,
      issuedAt,
      protocol: current.protocol,
      deploymentId: current.deploymentId,
      deploymentIds,
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
      if (!active || !active.protocols.includes(current.protocol) || !deploymentIds.every((id) => active.publicDeploymentIds.includes(id))) {
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
