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
import type {
  HubCatalogDeployment,
  HubCatalogProtocol,
  HubCatalogSnapshot,
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
  withRuntimeRotationLock,
  CliError,
  EXIT_CODES,
  type CliDependencies,
  type CliPickerItem,
  type ParsedArguments,
} from "./cli-core.js";
import { RuntimeBindingStore, type RuntimeCredentialBinding } from "./runtime-binding-store.js";

const RUNTIME_ROTATION_WINDOW_MS = 60 * 60 * 1_000;
const RUNTIME_CREDENTIAL_TTL_SECONDS = 86_400;

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

export async function resolveDeployment(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  catalog: HubCatalogSnapshot,
  existingDeploymentId?: string,
): Promise<HubCatalogDeployment> {
  const usable = hubProtocolsFor(integration);
  const compatible = catalog.deployments.filter((deployment) =>
    deployment.availability.status === "available" &&
    deployment.protocols.some((protocol) => usable.has(protocol.protocol)),
  );
  if (parsed.deployment) {
    const deployment = catalog.deployments.find((item) => item.id === parsed.deployment);
    if (!deployment) {
      throw new CliError({ code: "DEPLOYMENT_NOT_FOUND", message: "The selected deployment is not present in the visible Hub catalog.", exitCode: EXIT_CODES.unavailable });
    }
    if (deployment.availability.status !== "available" && deployment.availability.status !== "degraded") {
      throw new CliError({ code: "DEPLOYMENT_UNAVAILABLE", message: `Deployment ${deployment.id} is ${deployment.availability.status}.`, exitCode: EXIT_CODES.unavailable });
    }
    return deployment;
  }
  if (existingDeploymentId) {
    const existing = catalog.deployments.find((item) => item.id === existingDeploymentId);
    if (existing && (existing.availability.status === "available" || existing.availability.status === "degraded")) return existing;
  }
  if (compatible.length === 0) {
    throw new CliError({ code: "DEPLOYMENT_NOT_FOUND", message: "No compatible deployments are available.", exitCode: EXIT_CODES.unavailable });
  }
  const io = dependencies.io ?? defaultIo();
  if (io.isInteractive && !parsed.nonInteractive && !parsed.json) {
    const picker = resolvePicker(dependencies);
    const modelsById = new Map(catalog.models.map((model) => [model.id, model]));
    const items: CliPickerItem<HubCatalogDeployment>[] = compatible.map((deployment) => ({
      label: `${deployment.displayName} (${deployment.inferenceAlias})`,
      description: `${modelsById.get(deployment.modelId)?.name ?? deployment.modelId} · ${deployment.availability.status}`,
      value: deployment,
    }));
    return picker("Select a model:", items);
  }
  throw new CliError({
    code: "DEPLOYMENT_REQUIRED",
    message: "No deployment is bound yet and the terminal is not interactive; pass --deployment <id>. Run `apexnova models --json` to list them.",
    exitCode: EXIT_CODES.usage,
    details: { compatibleDeploymentIds: compatible.map((deployment) => deployment.id) },
  });
}

/** Builds the product-neutral description of the connection to configure. */
export function connectionIntent(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  deployment: HubCatalogDeployment,
  protocol: HubCatalogProtocol,
  catalog: HubCatalogSnapshot,
): ConnectionIntent {
  const protocolId = toProtocolId(protocol.protocol);
  if (!protocolId || !integration.supportedProtocols.includes(protocolId)) {
    throw protocolNotSupported(integration);
  }
  if (!deployment.inferenceAlias) {
    throw new CliError({ code: "INVALID_RESPONSE", message: "The selected deployment has no public inference model alias.", exitCode: EXIT_CODES.runtime });
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
    protocol: protocolId,
    baseUrl: protocol.baseUrl,
    apiKeyEnvironmentVariable: integration.credentialEnvironmentVariable,
    ...(limits?.contextWindow && limits.maxOutputTokens
      ? { limits: { context: limits.contextWindow, output: limits.maxOutputTokens } }
      : {}),
    allowInsecureLoopback: environment.APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK === "1",
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
  deployment: HubCatalogDeployment,
  protocol: HubCatalogProtocol,
  mode: CredentialMode = "auto",
): Promise<RuntimeCredentialBinding> {
  const agentId = integration.manifest.id;
  const service = hubService(parsed, dependencies);
  const signal = operationSignal(parsed);
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
      kind: "user",
    };
  }
  if (parsed.rotating || mode === "runtime") {
    const created = await service.createRuntimeCredential(parsed.profile, {
      name: credentialName(integration, parsed.profile),
      protocols: [protocol.protocol],
      publicDeploymentIds: [deployment.id],
      expiresIn: RUNTIME_CREDENTIAL_TTL_SECONDS,
    }, signal);
    return {
      credentialId: created.credentialId,
      secret: created.secret,
      expiresAt: created.expiresAt,
      protocol: protocol.protocol,
      deploymentId: deployment.id,
      kind: "runtime",
    };
  }
  const created = await service.createApiKey(parsed.profile, {
    name: credentialName(integration, parsed.profile),
    protocols: [protocol.protocol],
    publicDeploymentIds: [deployment.id],
    expiresIn: null,
  }, signal);
  return {
    credentialId: created.id,
    secret: created.secret,
    protocol: protocol.protocol,
    deploymentId: deployment.id,
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
  deployment: HubCatalogDeployment,
  protocol: HubCatalogProtocol,
  catalog: HubCatalogSnapshot,
  mode: CredentialMode = "auto",
): Promise<ConfigureResult> {
  const agentId = integration.manifest.id;
  const context = integrationContext(parsed, dependencies);
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  const previous = await bindings.load(agentId, parsed.profile);
  const detection = requireAvailable(
    await detectForCommand(parsed, dependencies, integration),
    integration,
  );
  const intent = connectionIntent(parsed, dependencies, integration, deployment, protocol, catalog);

  await mkdir(dirname(detection.configPath), { recursive: true, mode: 0o700 });
  const executor = new FileConfigExecutor({
    allowedRoots: [dirname(detection.configPath)],
    backupRoot: join(localStateRoot(dependencies), "backups"),
  });
  const binding = await ensureCredential(parsed, dependencies, integration, deployment, protocol, mode);

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
    await revokeBinding(parsed, dependencies, binding).catch(() => {});
    if (cause instanceof IntegrationChangeError) throw cause.cause ?? cause;
    throw cause;
  }

  if (outcome.status === "rolled-back") {
    await revokeBinding(parsed, dependencies, binding).catch(() => {});
    throw new CliError({
      code: "VERIFICATION_FAILED",
      message: outcome.verification.reason,
      exitCode: EXIT_CODES.verification,
      details: { agentId, planId: outcome.plan.id },
    });
  }
  if (outcome.status === "unavailable" || outcome.status === "declined") {
    await revokeBinding(parsed, dependencies, binding).catch(() => {});
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
        ...(previous.transactionId ? { transactionId: previous.transactionId } : {}),
        ...(previous.restoreTarget ? { restoreTarget: previous.restoreTarget } : {}),
      } } : {}),
    });
  } catch (cause) {
    const failures: unknown[] = [cause];
    if (receipt) await executor.rollback(receipt).catch((error: unknown) => failures.push(error));
    await revokeBinding(parsed, dependencies, binding).catch((error: unknown) => failures.push(error));
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

  return { binding, plan: outcome.plan, ...(transactionId ? { transactionId } : {}), warnings };
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
): Promise<LaunchOutcome> {
  const agentId = integration.manifest.id;
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  const initial = await bindings.load(agentId, parsed.profile);
  if (!initial) throw new CliError({ code: "RUNTIME_CREDENTIAL_NOT_FOUND", message: "No runtime credential is stored for this profile; run connect first.", exitCode: EXIT_CODES.authentication });
  if (initial.kind === "user" || initial.expiresAt === undefined) {
    return { binding: initial, rotated: false, warnings: [] as string[] };
  }
  if (Date.parse(initial.expiresAt) - currentTime(dependencies) > RUNTIME_ROTATION_WINDOW_MS) {
    return { binding: initial, rotated: false, warnings: [] as string[] };
  }

  return withRuntimeRotationLock(parsed, dependencies, async () => {
    const current = await bindings.load(agentId, parsed.profile);
    if (!current) throw new CliError({ code: "RUNTIME_CREDENTIAL_NOT_FOUND", message: "No runtime credential is stored for this profile; run connect first.", exitCode: EXIT_CODES.authentication });
    if (current.kind === "user" || current.expiresAt === undefined) {
      return { binding: current, rotated: false, warnings: [] as string[] };
    }
    if (Date.parse(current.expiresAt) - currentTime(dependencies) > RUNTIME_ROTATION_WINDOW_MS) {
      return { binding: current, rotated: false, warnings: [] as string[] };
    }
    const service = hubService(parsed, dependencies);
    const signal = operationSignal(parsed);
    const catalog = await service.catalog(parsed.profile, signal);
    const deployment = catalog.deployments.find((item) => item.id === current.deploymentId);
    const protocol = deployment?.protocols.find((item) => item.protocol === current.protocol);
    if (!deployment || !protocol || (deployment.availability.status !== "available" && deployment.availability.status !== "degraded")) {
      throw new CliError({ code: "BINDING_MISMATCH", message: "The stored runtime credential cannot be renewed because its deployment or protocol is no longer available.", exitCode: EXIT_CODES.verification });
    }
    const created = await service.createRuntimeCredential(parsed.profile, {
      name: credentialName(integration, parsed.profile),
      protocols: [current.protocol],
      publicDeploymentIds: [current.deploymentId],
      expiresIn: 86_400,
    }, signal);
    const replacement = {
      credentialId: created.credentialId,
      secret: created.secret,
      expiresAt: created.expiresAt,
      protocol: current.protocol,
      deploymentId: current.deploymentId,
      ...(current.transactionId ? { transactionId: current.transactionId } : {}),
      ...(current.restoreTarget ? { restoreTarget: current.restoreTarget } : {}),
    };
    try {
      if (Date.parse(created.expiresAt) - currentTime(dependencies) <= RUNTIME_ROTATION_WINDOW_MS) {
        throw new CliError({ code: "INVALID_RESPONSE", message: "Hub issued a runtime credential with an insufficient lifetime.", exitCode: EXIT_CODES.runtime });
      }
      const active = (await service.runtimeCredentials(parsed.profile, signal)).find((item) => item.credentialId === created.credentialId);
      if (!active || !active.protocols.includes(current.protocol) || !active.publicDeploymentIds.includes(current.deploymentId)) {
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
  });
}
