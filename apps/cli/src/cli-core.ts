import { createHash } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { select } from "@inquirer/prompts";

import {
  toPlatform,
  type IntegrationContext,
  type LaunchPlan,
  type Platform,
} from "@apexnova-connect/integration-sdk";
import {
  createIntegrationRegistry,
  IntegrationRegistryError,
  type IntegrationRegistry,
} from "@apexnova-connect/core";
import {
  HubClientError,
  type HubInferenceVerification,
  type VerifyHubInferenceOptions,
} from "@apexnova-connect/hub-client";
import {
  createDefaultCredentialStore,
  type CredentialStore,
} from "@apexnova-connect/credential-store";

import {
  createDefaultHubCommandService,
  type HubCommandService,
} from "./hub-command-service.js";
import { defaultAgentIntegrations } from "./integrations.js";
import { hubConfigPath, readHubConfigFile, resolveHubConfig, type HubConfigContext } from "./hub-config.js";

export const EXIT_CODES = {
  success: 0,
  runtime: 1,
  usage: 2,
  authentication: 3,
  permission: 4,
  unavailable: 5,
  conflict: 6,
  verification: 7,
  network: 8,
  billing: 9,
  recovery: 10,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly isInteractive: boolean;
}

export interface CliPickerItem<T> {
  readonly label: string;
  readonly description?: string;
  readonly value: T;
}

export interface CliDependencies {
  readonly io?: CliIo;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  /** Overrides the Agent integrations the CLI loads. */
  readonly registry?: IntegrationRegistry;
  readonly hubService?: HubCommandService;
  readonly credentialStore?: CredentialStore;
  readonly launchAgent?: (plan: LaunchPlan) => Promise<number>;
  readonly credentialHelperCommand?: (agentId: string, profile: string) => string;
  readonly verifyHubInference?: (options: VerifyHubInferenceOptions) => Promise<HubInferenceVerification>;
  readonly createRequestId?: () => string;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly pick?: <T>(message: string, items: readonly CliPickerItem<T>[]) => Promise<T>;
}

export interface CliRunResult {
  readonly exitCode: ExitCode;
  readonly requestId: string;
}

export interface ParsedArguments {
  readonly command?: string;
  readonly operands: readonly string[];
  readonly json: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly profile: string;
  readonly configPath?: string;
  readonly timeoutSeconds: number;
  readonly verbose: boolean;
  readonly nonInteractive: boolean;
  readonly yes: boolean;
  readonly agent?: string;
  readonly protocol?: string;
  readonly compatibleOnly: boolean;
  readonly deployment?: string;
  readonly dryRun: boolean;
  readonly list: boolean;
  readonly live: boolean;
  readonly apiKeyId?: string;
  readonly rotating: boolean;
  readonly apiKeyHelper: boolean;
  readonly from?: string;
  readonly to?: string;
  readonly granularity?: "hour" | "day" | "month";
  readonly hubUrl?: string;
  readonly clientId?: string;
  readonly pathPrefix?: string;
  readonly force: boolean;
}

export interface CliErrorShape {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly exitCode: ExitCode;
    readonly retryable?: boolean;
    readonly retryAfterSeconds?: number;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "CliError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.retryable = options.retryable ?? false;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.details) this.details = options.details;
  }
}

export function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

async function defaultPick<T>(message: string, items: readonly CliPickerItem<T>[]): Promise<T> {
  if (items.length === 0) throw new CliError({ code: "INVALID_ARGUMENT", message: "No items to pick from.", exitCode: EXIT_CODES.usage });
  if (items.length === 1) return items[0]!.value;
  return select({
    message,
    choices: items.map((item) => ({ name: item.label, value: item.value, ...(item.description ? { description: item.description } : {}) })),
    loop: false,
  });
}

export function resolvePicker(dependencies: CliDependencies): <T>(message: string, items: readonly CliPickerItem<T>[]) => Promise<T> {
  return dependencies.pick ?? defaultPick;
}

export function noOperands(parsed: ParsedArguments): void {
  if (parsed.operands.length !== 0) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: `${parsed.command ?? "This command"} does not accept positional arguments.`,
      exitCode: EXIT_CODES.usage,
    });
  }
}

export function hubConfigContext(dependencies: CliDependencies): HubConfigContext {
  return {
    ...(dependencies.environment ? { environment: dependencies.environment } : {}),
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
  };
}

export function hubService(parsed: ParsedArguments, dependencies: CliDependencies): HubCommandService {
  const base = dependencies.hubService ?? createDefaultHubCommandService({
    ...hubConfigContext(dependencies),
    requestTimeoutMs: parsed.timeoutSeconds * 1_000,
  });
  return withRetryableHub(base, dependencies.sleep ?? defaultSleep);
}


// One deadline per CLI invocation rather than per HTTP request: a command that
// makes six sequential Hub calls must still honour --timeout as a whole.
const operationSignals = new WeakMap<ParsedArguments, AbortSignal>();

export function operationSignal(parsed: ParsedArguments): AbortSignal {
  const existing = operationSignals.get(parsed);
  if (existing) return existing;
  const signal = AbortSignal.timeout(parsed.timeoutSeconds * 1_000);
  operationSignals.set(parsed, signal);
  return signal;
}

// Compensating work (revoking a credential after a failed apply) must not inherit
// an already-expired operation deadline, or a timeout would leak the credential.
export function compensationSignal(parsed: ParsedArguments): AbortSignal {
  return AbortSignal.timeout(Math.min(parsed.timeoutSeconds, 30) * 1_000);
}

export function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }
      else signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true });
    }
  });
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    readonly maxRetries?: number;
    readonly signal?: AbortSignal;
  },
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      if (!(error instanceof HubClientError) || error.code !== "RATE_LIMITED") throw error;
      const backoffMs = Math.min(Math.max(error.retryAfterSeconds ?? 1, 1), 30) * 1000;
      await options.sleep(backoffMs, options.signal);
    }
  }
}

function withRetryableHub(service: HubCommandService, sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>): HubCommandService {
  const retry = <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => withRetry(operation, { sleep, ...(signal ? { signal } : {}) });
  return {
    login: (profileId, onVerificationRequired, signal) => service.login(profileId, onVerificationRequired, signal),
    logout: (profileId) => service.logout(profileId),
    whoami: (profileId, signal) => retry(() => service.whoami(profileId, signal), signal),
    balance: (profileId, signal) => retry(() => service.balance(profileId, signal), signal),
    catalog: (profileId, signal) => retry(() => service.catalog(profileId, signal), signal),
    estimatePricing: (profileId, deploymentId, usage, signal) => retry(() => service.estimatePricing(profileId, deploymentId, usage, signal), signal),
    usage: (profileId, requestId, signal) => retry(() => service.usage(profileId, requestId, signal), signal),
    usageQuery: (profileId, query, signal) => retry(() => service.usageQuery(profileId, query, signal), signal),
    createRuntimeCredential: (profileId, input, signal) => retry(() => service.createRuntimeCredential(profileId, input, signal), signal),
    runtimeCredentials: (profileId, signal) => retry(() => service.runtimeCredentials(profileId, signal), signal),
    revokeRuntimeCredential: (profileId, credentialId, signal) => retry(() => service.revokeRuntimeCredential(profileId, credentialId, signal), signal),
    createApiKey: (profileId, input, signal) => retry(() => service.createApiKey(profileId, input, signal), signal),
    apiKeys: (profileId, signal) => retry(() => service.apiKeys(profileId, signal), signal),
    apiKey: (profileId, id, signal) => retry(() => service.apiKey(profileId, id, signal), signal),
    updateApiKey: (profileId, id, input, signal) => retry(() => service.updateApiKey(profileId, id, input, signal), signal),
    revokeApiKey: (profileId, id, signal) => retry(() => service.revokeApiKey(profileId, id, signal), signal),
  };
}

export function credentialStore(dependencies: CliDependencies): CredentialStore {
  return dependencies.credentialStore ?? createDefaultCredentialStore({
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
  });
}

export function localStateRoot(dependencies: CliDependencies): string {
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const home = dependencies.homeDirectory ?? environment.USERPROFILE ?? environment.HOME ?? process.cwd();
  if (platform === "win32") return resolve(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Apexnova", "connect");
  return resolve(environment.XDG_STATE_HOME ?? join(home, ".local", "state"), "apexnova-connect");
}

export function currentTime(dependencies: CliDependencies): number {
  return (dependencies.now?.() ?? new Date()).getTime();
}

export function filesystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

const RUNTIME_ROTATION_LOCK_STALE_MS = 5 * 60 * 1_000;

export async function withRuntimeRotationLock<T>(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  task: () => Promise<T>,
): Promise<T> {
  const lockRoot = join(localStateRoot(dependencies), "locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const profileHash = createHash("sha256").update(parsed.profile, "utf8").digest("hex").slice(0, 32);
  const lockPath = join(lockRoot, `runtime-${profileHash}.lock`);
  const signal = operationSignal(parsed);
  let handle;
  for (;;) {
    if (signal.aborted) {
      throw new CliError({ code: "CREDENTIAL_ROTATION_BUSY", message: "Timed out waiting for another credential rotation to finish.", exitCode: EXIT_CODES.conflict, retryable: true });
    }
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      break;
    } catch (error) {
      if (filesystemCode(error) !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > RUNTIME_ROTATION_LOCK_STALE_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch (staleError) {
        if (filesystemCode(staleError) === "ENOENT") continue;
        throw staleError;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  try {
    return await task();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}


/**
 * Everything an integration may know about this machine. Built once per command
 * so detection, planning, restore and launching all agree on the same paths.
 */
export function integrationContext(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
): IntegrationContext {
  const environment = dependencies.environment ?? process.env;
  const nodePlatform = dependencies.platform ?? process.platform;
  const platform = toPlatform(nodePlatform);
  if (!platform) {
    throw new CliError({
      code: "PLATFORM_NOT_SUPPORTED",
      message: `Apexnova-connect does not support ${nodePlatform}.`,
      exitCode: EXIT_CODES.unavailable,
    });
  }
  return {
    platform,
    workingDirectory: resolve(dependencies.cwd ?? process.cwd()),
    homeDirectory: resolve(
      dependencies.homeDirectory ?? environment.USERPROFILE ?? environment.HOME ?? process.cwd(),
    ),
    environment,
    ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
  };
}

export function currentPlatform(dependencies: CliDependencies): Platform | undefined {
  return toPlatform(dependencies.platform ?? process.platform);
}

export function integrationRegistry(dependencies: CliDependencies): IntegrationRegistry {
  return dependencies.registry ?? createIntegrationRegistry(defaultAgentIntegrations());
}

/**
 * Registry lookups surface as normalized CLI errors so an unknown or
 * unsupported agent never reaches an integration.
 */
export function resolveIntegration(
  agentId: string,
  dependencies: CliDependencies,
) {
  try {
    return integrationRegistry(dependencies).resolve(agentId, currentPlatform(dependencies));
  } catch (error) {
    if (error instanceof IntegrationRegistryError) {
      throw new CliError({
        code: error.code === "PLATFORM_NOT_SUPPORTED" ? error.code : "INTEGRATION_NOT_SUPPORTED",
        message: error.message,
        exitCode: EXIT_CODES.unavailable,
        details: error.details,
      });
    }
    throw error;
  }
}

/**
 * Reads the agent operand shared by detect, inspect, connect, verify, doctor and
 * run. `optional` covers the commands that default to every registered agent.
 */
export function agentOperand(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  options: { readonly optional: boolean; readonly command: string; readonly trailingArgs?: boolean },
): string | undefined {
  const operands = options.trailingArgs ? parsed.operands.slice(0, 1) : parsed.operands;
  if (
    (!options.trailingArgs && operands.length > 1) ||
    (!options.optional && operands.length !== 1)
  ) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: options.optional
        ? `${options.command} accepts at most one agent.`
        : `${options.command} requires exactly one agent.`,
      exitCode: EXIT_CODES.usage,
    });
  }
  const agentId = operands[0];
  if (agentId === undefined) return undefined;
  resolveIntegration(agentId, dependencies);
  return agentId;
}

export function hubConfigLocation(dependencies: CliDependencies): string {
  return hubConfigPath(hubConfigContext(dependencies));
}

export { hubConfigPath, readHubConfigFile, resolveHubConfig };
export type { HubConfigContext, IntegrationContext, IntegrationRegistry, LaunchPlan, Platform };


function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * The command a target product runs to fetch the current credential. It points
 * back at this executable rather than at a generated script, so there is no
 * extra file to keep in step, and `restore` removing the setting is enough to
 * undo it. It breaks if the Apexnova-connect executable moves, which the
 * product reports as a failing helper.
 */
export function defaultCredentialHelperCommand(agentId: string, profile: string): string {
  const script = process.argv[1];
  const base = script
    ? `${shellQuote(process.execPath)} ${shellQuote(script)}`
    : shellQuote(process.execPath);
  return `${base} credential print ${agentId} --profile ${profile}`;
}
