import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { spawn } from "node:child_process";
import { input, select, password } from "@inquirer/prompts";

import {
  detectOpenCode,
  inspectOpenCode,
  OpenCodeInspectionError,
  OpenCodeConfigError,
  planOpenCodeV2Config,
  type OpenCodeDetection,
  type OpenCodeDetectionOptions,
  type OpenCodeInspection,
} from "@apexnova-connect/integration-opencode";
import {
  HubClientError,
  verifyHubInference,
  type HubCatalogDeployment,
  type HubCatalogProtocol,
  type HubCatalogSnapshot,
  type HubInferenceVerification,
  type HubUsageRecord,
  type UsageQuery,
  type VerifyHubInferenceOptions,
} from "@apexnova-connect/hub-client";
import { ConfigExecutionError, FileConfigExecutor } from "@apexnova-connect/config-engine";
import {
  createDefaultCredentialStore,
  SecretValue,
  type CredentialStore,
} from "@apexnova-connect/credential-store";

import {
  createDefaultHubCommandService,
  type HubCommandService,
} from "./hub-command-service.js";
import { RuntimeBindingStore, type RuntimeCredentialBinding } from "./runtime-binding-store.js";
import {
  hubConfigDefaults,
  hubConfigPath,
  readHubConfigFile,
  resolveHubConfig,
  writeHubConfigFile,
  type HubConfigContext,
} from "./hub-config.js";
import { CLI_VERSION } from "./version.js";

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

type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

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
  readonly detectOpenCode?: (options?: OpenCodeDetectionOptions) => Promise<OpenCodeDetection>;
  readonly inspectOpenCode?: (detection: OpenCodeDetection) => Promise<OpenCodeInspection>;
  readonly hubService?: HubCommandService;
  readonly credentialStore?: CredentialStore;
  readonly launchOpenCode?: (args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<number>;
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

interface ParsedArguments {
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
  readonly from?: string;
  readonly to?: string;
  readonly granularity?: "hour" | "day" | "month";
  readonly hubUrl?: string;
  readonly clientId?: string;
  readonly pathPrefix?: string;
  readonly force: boolean;
}

interface CliErrorShape {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

class CliError extends Error {
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

const HELP = `Apexnova-connect CLI

Usage:
  apexnova opencode [--deployment <id>] [--key <id>] [--rotating] [-- <agent args>]
  apexnova init [--hub-url <url>] [--client-id <id>] [--path-prefix <p>]
  apexnova login | logout | whoami | balance
  apexnova models [--agent opencode] [--protocol <id>] [--compatible-only]
  apexnova usage [--key <id>] [--from <iso>] [--to <iso>] [--granularity hour|day|month]
  apexnova connect opencode --deployment <id> (--dry-run | --yes)
  apexnova switch opencode --deployment <id> (--dry-run | --yes)
  apexnova verify opencode [--live] [--yes] | doctor [opencode]
  apexnova restore [transaction-id] [--list] [--dry-run] [--yes]
  apexnova detect [opencode] [--config <path>]
  apexnova inspect opencode [--config <path>]
  apexnova run opencode [-- <agent args>]
  apexnova --version

Global options:
  --profile <name>       Local profile (default: default)
  --json                 Emit a versioned JSON envelope
  --non-interactive      Disable prompts
  --yes                  Approve an already generated plan
  --timeout <seconds>    Whole-operation timeout (default: 120)
  --verbose              Emit sanitized diagnostics
  --agent <id>           Filter a catalog for an Agent
  --protocol <id>        Select or filter a protocol
  --compatible-only      Hide unavailable or unsupported deployments
  --deployment <id>      Select a public model deployment
  --key <id>             Use an existing API key instead of creating one
  --rotating             Use a short-lived rotating credential (24h) instead of a permanent key
  --from <iso>           Usage query start time (RFC 3339)
  --to <iso>             Usage query end time (RFC 3339)
  --granularity <g>      Usage aggregation: hour, day, or month
  --hub-url <url>        Apexnova AI Hub base URL (init)
  --client-id <id>       OAuth client ID (init)
  --path-prefix <p>      Hub API path prefix (init)
  --force                Overwrite an existing stored value (init)
  --dry-run              Plan without changing local or remote state
  --list                 List restorable transactions
  --live                 Perform a minimal, potentially billable inference check
  --no-color             Disable colors
  --help                 Show help
  --version              Show version

apexnova init stores the Hub endpoint so the other commands work without
exporting APEXNOVA_HUB_BASE_URL and APEXNOVA_OAUTH_CLIENT_ID in every shell.

apexnova opencode is the one-command path: it auto-configures a permanent key,
writes the OpenCode provider config, and launches OpenCode. Use --rotating for
short-lived credentials or --key <id> to bind an existing key for per-tool usage tracking.
`;

function defaultIo(): CliIo {
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

function resolvePicker(dependencies: CliDependencies): <T>(message: string, items: readonly CliPickerItem<T>[]) => Promise<T> {
  return dependencies.pick ?? defaultPick;
}

function valueAfter(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: `${option} requires a value.`,
      exitCode: EXIT_CODES.usage,
    });
  }
  return value;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const operands: string[] = [];
  let json = false;
  let help = false;
  let version = false;
  let profile = "default";
  let configPath: string | undefined;
  let timeoutSeconds = 120;
  let verbose = false;
  let nonInteractive = false;
  let yes = false;
  let agent: string | undefined;
  let protocol: string | undefined;
  let compatibleOnly = false;
  let deployment: string | undefined;
  let dryRun = false;
  let list = false;
  let live = false;
  let apiKeyId: string | undefined;
  let rotating = false;
  let from: string | undefined;
  let to: string | undefined;
  let granularity: "hour" | "day" | "month" | undefined;
  let hubUrl: string | undefined;
  let clientId: string | undefined;
  let pathPrefix: string | undefined;
  let force = false;
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (optionsEnded || !arg.startsWith("--")) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--help":
        help = true;
        break;
      case "--version":
        version = true;
        break;
      case "--no-color":
        break;
      case "--verbose":
        verbose = true;
        break;
      case "--non-interactive":
        nonInteractive = true;
        break;
      case "--yes":
        yes = true;
        break;
      case "--compatible-only":
        compatibleOnly = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--list":
        list = true;
        break;
      case "--live":
        live = true;
        break;
      case "--rotating":
        rotating = true;
        break;
      case "--force":
        force = true;
        break;
      case "--hub-url":
        hubUrl = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--client-id":
        clientId = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--path-prefix":
        pathPrefix = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--key":
        apiKeyId = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--from":
        from = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--to":
        to = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--granularity": {
        const value = valueAfter(args, index, arg);
        if (value !== "hour" && value !== "day" && value !== "month") {
          throw new CliError({ code: "INVALID_ARGUMENT", message: "--granularity must be hour, day, or month.", exitCode: EXIT_CODES.usage });
        }
        granularity = value;
        index += 1;
        break;
      }
      case "--deployment":
        deployment = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--agent":
        agent = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--protocol":
        protocol = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--profile":
        profile = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--config":
        configPath = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--timeout": {
        const value = valueAfter(args, index, arg);
        timeoutSeconds = Number(value);
        if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 3_600) {
          throw new CliError({
            code: "INVALID_ARGUMENT",
            message: "--timeout must be an integer between 1 and 3600 seconds.",
            exitCode: EXIT_CODES.usage,
          });
        }
        index += 1;
        break;
      }
      default:
        throw new CliError({
          code: "UNKNOWN_OPTION",
          message: `Unknown option: ${arg}.`,
          exitCode: EXIT_CODES.usage,
        });
    }
  }

  const [command, ...commandOperands] = operands;
  return {
    ...(command ? { command } : {}),
    operands: commandOperands,
    json,
    help,
    version,
    profile,
    ...(configPath ? { configPath } : {}),
    timeoutSeconds,
    verbose,
    nonInteractive,
    yes,
    ...(agent ? { agent } : {}),
    ...(protocol ? { protocol } : {}),
    compatibleOnly,
    ...(deployment ? { deployment } : {}),
    dryRun,
    list,
    live,
    ...(apiKeyId ? { apiKeyId } : {}),
    rotating,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(granularity ? { granularity } : {}),
    ...(hubUrl ? { hubUrl } : {}),
    ...(clientId ? { clientId } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    force,
  };
}

function writeJsonSuccess(
  io: CliIo,
  command: string,
  requestId: string,
  data: unknown,
  warnings: readonly string[],
): void {
  io.stdout(`${JSON.stringify({
    schemaVersion: "1",
    command,
    requestId,
    ok: true,
    data,
    warnings,
  }, null, 2)}\n`);
}

function writeJsonFailure(
  io: CliIo,
  command: string,
  requestId: string,
  error: CliErrorShape,
): void {
  io.stdout(`${JSON.stringify({
    schemaVersion: "1",
    command,
    requestId,
    ok: false,
    error,
  }, null, 2)}\n`);
}

function detectionOptions(parsed: ParsedArguments, dependencies: CliDependencies): OpenCodeDetectionOptions {
  return {
    ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    ...(dependencies.environment ? { environment: dependencies.environment } : {}),
    ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
    ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
  };
}

function requireAgent(operands: readonly string[], optional: boolean): "opencode" | undefined {
  if (operands.length > 1 || (!optional && operands.length !== 1)) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: optional ? "detect accepts at most one agent." : "inspect requires exactly one agent.",
      exitCode: EXIT_CODES.usage,
    });
  }
  const agent = operands[0];
  if (agent === undefined) return undefined;
  if (agent !== "opencode") {
    throw new CliError({
      code: "INTEGRATION_NOT_SUPPORTED",
      message: `Unsupported agent: ${agent}.`,
      exitCode: EXIT_CODES.unavailable,
      details: { supportedAgents: ["opencode"] },
    });
  }
  return agent;
}

async function executeDetect(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
): Promise<{ readonly data: unknown; readonly warnings: readonly string[]; readonly human: string }> {
  const requestedAgent = requireAgent(parsed.operands, true);
  const detection = await (dependencies.detectOpenCode ?? detectOpenCode)(
    detectionOptions(parsed, dependencies),
  );

  if (requestedAgent && detection.status === "not-found") {
    throw new CliError({
      code: "AGENT_NOT_FOUND",
      message: "OpenCode was not found in the current environment.",
      exitCode: EXIT_CODES.unavailable,
      details: {
        agentId: detection.agentId,
        configPath: detection.configPath,
      },
    });
  }

  const data = requestedAgent ? detection : { agents: [detection] };
  const version = detection.productVersion ? ` ${detection.productVersion}` : "";
  const human = [
    `OpenCode: ${detection.status}${version}`,
    `Config: ${detection.configPath}${detection.configExists ? "" : " (not created)"}`,
    ...detection.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
  return { data, warnings: detection.warnings, human };
}

async function executeInspect(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
): Promise<{ readonly data: unknown; readonly warnings: readonly string[]; readonly human: string }> {
  requireAgent(parsed.operands, false);
  const detection = await (dependencies.detectOpenCode ?? detectOpenCode)(
    detectionOptions(parsed, dependencies),
  );
  if (detection.status === "not-found") {
    throw new CliError({
      code: "AGENT_NOT_FOUND",
      message: "OpenCode was not found in the current environment.",
      exitCode: EXIT_CODES.unavailable,
    });
  }
  const inspection = await (dependencies.inspectOpenCode ?? inspectOpenCode)(detection);
  if (inspection.status === "legacy" || inspection.status === "invalid") {
    throw new CliError({
      code: inspection.status === "legacy" ? "LEGACY_CONFIG" : "INVALID_CONFIG",
      message: inspection.warnings[0] ?? "OpenCode configuration is not supported.",
      exitCode: EXIT_CODES.conflict,
      details: {
        agentId: inspection.agentId,
        configPath: inspection.configPath,
        status: inspection.status,
      },
    });
  }

  const provider = inspection.provider;
  const lines = [
    `OpenCode configuration: ${inspection.status}`,
    `Config: ${inspection.configPath}`,
    `Managed by Apexnova-connect: ${inspection.managed ? "yes" : "no"}`,
  ];
  if (provider) {
    lines.push(
      `Protocol: ${provider.protocol ?? "unknown"}`,
      `Base URL: ${provider.baseUrl ?? "not set"}`,
      `Models: ${provider.modelIds.length > 0 ? provider.modelIds.join(", ") : "none"}`,
    );
  }
  return { data: inspection, warnings: inspection.warnings, human: lines.join("\n") };
}

function noOperands(parsed: ParsedArguments): void {
  if (parsed.operands.length !== 0) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: `${parsed.command ?? "This command"} does not accept positional arguments.`,
      exitCode: EXIT_CODES.usage,
    });
  }
}

function hubConfigContext(dependencies: CliDependencies): HubConfigContext {
  return {
    ...(dependencies.environment ? { environment: dependencies.environment } : {}),
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
    ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
  };
}

function hubService(parsed: ParsedArguments, dependencies: CliDependencies): HubCommandService {
  const base = dependencies.hubService ?? createDefaultHubCommandService({
    ...hubConfigContext(dependencies),
    requestTimeoutMs: parsed.timeoutSeconds * 1_000,
  });
  return withRetryableHub(base, dependencies.sleep ?? defaultSleep);
}

// One deadline per CLI invocation rather than per HTTP request: a command that
// makes six sequential Hub calls must still honour --timeout as a whole.
const operationSignals = new WeakMap<ParsedArguments, AbortSignal>();

function operationSignal(parsed: ParsedArguments): AbortSignal {
  const existing = operationSignals.get(parsed);
  if (existing) return existing;
  const signal = AbortSignal.timeout(parsed.timeoutSeconds * 1_000);
  operationSignals.set(parsed, signal);
  return signal;
}

// Compensating work (revoking a credential after a failed apply) must not inherit
// an already-expired operation deadline, or a timeout would leak the credential.
function compensationSignal(parsed: ParsedArguments): AbortSignal {
  return AbortSignal.timeout(Math.min(parsed.timeoutSeconds, 30) * 1_000);
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }
      else signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true });
    }
  });
}

async function withRetry<T>(
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

function credentialStore(dependencies: CliDependencies): CredentialStore {
  return dependencies.credentialStore ?? createDefaultCredentialStore({
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
  });
}

export function resolveOpenCodeExecutable(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  pathExists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return "opencode";

  const pathValue = environment.PATH ?? environment.Path ?? "";
  for (const directory of pathValue.split(";").filter(Boolean)) {
    const standalone = win32.join(directory, "opencode.exe");
    if (pathExists(standalone)) return standalone;

    // npm's Windows shim cannot be spawned with shell=false. Resolve its fixed,
    // argument-safe native target instead of interpolating user arguments into cmd.exe.
    const npmBinary = win32.join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (pathExists(npmBinary)) return npmBinary;
  }

  throw new CliError({
    code: "AGENT_NOT_FOUND",
    message: "OpenCode was detected, but no native opencode.exe target was found on PATH.",
    exitCode: EXIT_CODES.unavailable,
  });
}

function defaultLaunchOpenCode(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveLaunch, reject) => {
    let executable: string;
    try {
      executable = resolveOpenCodeExecutable(process.platform, environment);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(executable, args, { env: environment, stdio: "inherit", windowsHide: true, shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`OpenCode exited after signal ${signal}.`));
      else resolveLaunch(code ?? 1);
    });
  });
}

function validateHubBaseUrl(value: string, allowInsecureLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError({ code: "INVALID_ARGUMENT", message: `${value} is not a valid URL.`, exitCode: EXIT_CODES.usage });
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol === "http:" && !(loopback && allowInsecureLoopback)) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "The Hub base URL must use https, or be a loopback address with APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK=1.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError({ code: "INVALID_ARGUMENT", message: `Unsupported Hub URL scheme: ${url.protocol}`, exitCode: EXIT_CODES.usage });
  }
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, ""));
}

function validatePathPrefix(value: string): string {
  if (!value.startsWith("/") || value.endsWith("/")) {
    throw new CliError({ code: "INVALID_ARGUMENT", message: "--path-prefix must start with / and must not end with /.", exitCode: EXIT_CODES.usage });
  }
  return value;
}

async function executeInit(parsed: ParsedArguments, dependencies: CliDependencies) {
  noOperands(parsed);
  const io = dependencies.io ?? defaultIo();
  const context = hubConfigContext(dependencies);
  const configPath = hubConfigPath(context);
  const stored = readHubConfigFile(context);
  const defaults = hubConfigDefaults();
  const overriding = parsed.hubUrl !== undefined || parsed.clientId !== undefined || parsed.pathPrefix !== undefined;
  const interactive = io.isInteractive && !parsed.nonInteractive && !parsed.json;

  if (stored && !parsed.force && !overriding && !interactive) {
    throw new CliError({
      code: "CONFIG_EXISTS",
      message: `${configPath} already configures a Hub endpoint. Pass --force to overwrite, or --hub-url/--client-id to change a single value.`,
      exitCode: EXIT_CODES.conflict,
      details: { configPath },
    });
  }

  const ask = async (message: string, fallback: string | undefined, flag: string): Promise<string> => {
    if (!interactive) {
      if (!fallback) {
        throw new CliError({
          code: "INVALID_ARGUMENT",
          message: `${flag} is required because this build has no default and the terminal is not interactive.`,
          exitCode: EXIT_CODES.usage,
        });
      }
      return fallback;
    }
    const answer = await input({ message, ...(fallback ? { default: fallback } : {}), required: true });
    return answer.trim();
  };

  const environment = dependencies.environment ?? process.env;
  const allowInsecureLoopback = environment.APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK === "1";
  const hubBaseUrl = validateHubBaseUrl(
    parsed.hubUrl ?? await ask("Apexnova AI Hub base URL:", stored?.hubBaseUrl ?? defaults.baseUrl, "--hub-url"),
    allowInsecureLoopback,
  );
  const oauthClientId = parsed.clientId ?? await ask("OAuth client ID:", stored?.oauthClientId ?? defaults.clientId, "--client-id");
  const rawPathPrefix = parsed.pathPrefix ?? stored?.pathPrefix;
  const pathPrefix = rawPathPrefix ? validatePathPrefix(rawPathPrefix) : undefined;

  writeHubConfigFile(context, {
    hubBaseUrl,
    oauthClientId,
    ...(pathPrefix ? { pathPrefix } : {}),
  });

  const warnings: string[] = [];
  if (environment.APEXNOVA_HUB_BASE_URL || environment.APEXNOVA_OAUTH_CLIENT_ID) {
    warnings.push("APEXNOVA_HUB_BASE_URL / APEXNOVA_OAUTH_CLIENT_ID are set in this environment and take precedence over the stored file.");
  }
  return {
    data: { configPath, hubBaseUrl, oauthClientId, ...(pathPrefix ? { pathPrefix } : {}) },
    warnings: warnings as readonly string[],
    human: [
      `Wrote ${configPath}`,
      `Hub: ${hubBaseUrl}`,
      `Client: ${oauthClientId}`,
      ...(pathPrefix ? [`Path prefix: ${pathPrefix}`] : []),
      'Next: run "apexnova login".',
    ].join("\n"),
  };
}

async function executeLogin(parsed: ParsedArguments, dependencies: CliDependencies) {
  noOperands(parsed);
  const io = dependencies.io ?? defaultIo();
  let promptShown = false;
  const tokens = await hubService(parsed, dependencies).login(
    parsed.profile,
    (prompt) => {
      promptShown = true;
      io.stderr([
        `Open ${prompt.verificationUri}`,
        `Enter code: ${prompt.userCode}`,
        `Expires: ${prompt.expiresAt}`,
      ].join("\n") + "\n");
    },
  );
  if (!promptShown) throw new CliError({ code: "INVALID_RESPONSE", message: "Hub login completed without a verification prompt.", exitCode: EXIT_CODES.runtime });
  return {
    data: { profile: parsed.profile, authenticated: true, tokenType: tokens.tokenType, expiresAt: tokens.expiresAt, scope: tokens.scope, accountId: tokens.accountId },
    warnings: [] as readonly string[],
    human: `Authenticated profile ${parsed.profile}${tokens.accountId ? ` as ${tokens.accountId}` : ""}.`,
  };
}

async function executeLogout(parsed: ParsedArguments, dependencies: CliDependencies) {
  noOperands(parsed);
  const result = await hubService(parsed, dependencies).logout(parsed.profile);
  const warnings = result.serverRevoked ? [] : ["The local session was deleted, but server-side token revocation did not complete."];
  return { data: { profile: parsed.profile, localSessionDeleted: true, serverRevoked: result.serverRevoked }, warnings, human: `Logged out profile ${parsed.profile} locally.${result.serverRevoked ? "" : " Server revocation was not performed."}` };
}

async function executeWhoami(parsed: ParsedArguments, dependencies: CliDependencies) {
  noOperands(parsed);
  const account = await hubService(parsed, dependencies).whoami(parsed.profile, operationSignal(parsed));
  return { data: { profile: parsed.profile, account }, warnings: [] as readonly string[], human: [`Profile: ${parsed.profile}`, `Account: ${account.displayName} (${account.accountId ?? account.userId})`, ...(account.email ? [`Email: ${account.email}`] : []), ...(account.plan ? [`Plan: ${account.plan.name}`] : []), ...(account.context.organizationId ? [`Organization: ${account.context.organizationId}`] : [])].join("\n") };
}

async function executeBalance(parsed: ParsedArguments, dependencies: CliDependencies) {
  noOperands(parsed);
  const balance = await hubService(parsed, dependencies).balance(parsed.profile, operationSignal(parsed));
  return { data: balance, warnings: balance.promoCredits.length > 0 ? ["Promotional credits may be restricted to specific models."] : [], human: [`Available: ${balance.normalAvailable} ${balance.currency}`, `Held: ${balance.held} ${balance.currency}`, `Promotions: ${balance.promoCredits.length}`, `As of: ${balance.asOf}`].join("\n") };
}

async function executeModels(parsed: ParsedArguments, dependencies: CliDependencies) {
  noOperands(parsed);
  if (parsed.agent !== undefined && parsed.agent !== "opencode") {
    throw new CliError({ code: "INTEGRATION_NOT_SUPPORTED", message: `Unsupported agent: ${parsed.agent}.`, exitCode: EXIT_CODES.unavailable, details: { supportedAgents: ["opencode"] } });
  }
  const catalog = await hubService(parsed, dependencies).catalog(parsed.profile, operationSignal(parsed));
  const supported = new Set(["openai-responses", "openai-chat"]);
  const modelsById = new Map(catalog.models.map((model) => [model.id, model]));
  const deployments = catalog.deployments
    .filter((deployment) => !parsed.protocol || deployment.protocols.some((protocol) => protocol.protocol === parsed.protocol))
    .filter((deployment) => !parsed.agent || deployment.protocols.some((protocol) => supported.has(protocol.protocol)))
    .filter((deployment) => !parsed.compatibleOnly || (deployment.availability.status === "available" && deployment.protocols.some((protocol) => supported.has(protocol.protocol))))
    .map((deployment) => ({
      ...deployment,
      model: modelsById.get(deployment.modelId),
      compatibility: parsed.agent ? (deployment.protocols.some((protocol) => supported.has(protocol.protocol)) ? "adapter-supported-unverified" : "unsupported") : "not-evaluated",
    }));
  const warnings = parsed.agent ? ["Adapter protocol support is not Agent compatibility evidence; H1 deployments remain unverified until compatibility testing is available."] : [];
  const human = deployments.length === 0 ? "No matching deployments." : deployments.map((deployment) => `${deployment.id}  ${deployment.model?.name ?? deployment.modelId}  ${deployment.availability.status}  ${deployment.protocols.map((protocol) => protocol.protocol).join(",")}`).join("\n");
  const io = dependencies.io ?? defaultIo();
  if (io.isInteractive && !parsed.nonInteractive && !parsed.json && deployments.length > 0) {
    const picker = resolvePicker(dependencies);
    const items: CliPickerItem<HubCatalogDeployment>[] = deployments.map((deployment) => ({
      label: `${deployment.displayName} (${deployment.inferenceAlias})`,
      description: `${deployment.model?.name ?? deployment.modelId} · ${deployment.availability.status}`,
      value: deployment,
    }));
    const selected = await picker("Select a model to switch to (Esc to cancel):", items);
    const protocol = selected.protocols.find((item) => supported.has(item.protocol));
    if (!protocol) throw new CliError({ code: "PROTOCOL_NOT_SUPPORTED", message: "The selected deployment does not expose a supported OpenCode protocol.", exitCode: EXIT_CODES.unavailable });
    const result = await configureOpenCode(parsed, dependencies, selected, protocol, catalog);
    return {
      data: { schemaVersion: catalog.schemaVersion, catalogVersion: catalog.catalogVersion, generatedAt: catalog.generatedAt, expiresAt: catalog.expiresAt, deployments, switchedTo: selected.id, credentialKind: result.binding.kind ?? "runtime" },
      warnings: [...warnings, ...result.warnings],
      human: `Switched to ${selected.displayName} (${selected.inferenceAlias}). Run "apexnova opencode" to use it.`,
    };
  }
  return { data: { schemaVersion: catalog.schemaVersion, catalogVersion: catalog.catalogVersion, generatedAt: catalog.generatedAt, expiresAt: catalog.expiresAt, deployments }, warnings, human };
}

function openCodeProtocol(protocol: string): "openai-responses" | "openai-chat-completions" | undefined {
  if (protocol === "openai-responses") return "openai-responses";
  if (protocol === "openai-chat") return "openai-chat-completions";
  return undefined;
}

function openCodeBaseUrl(endpoint: string, protocol: string): string {
  const url = new URL(endpoint);
  const suffix = protocol === "openai-responses" ? "/responses" : protocol === "openai-chat" ? "/chat/completions" : "";
  if (suffix && url.pathname.endsWith(suffix)) url.pathname = url.pathname.slice(0, -suffix.length);
  return url.toString().replace(/\/$/, "");
}

function localStateRoot(dependencies: CliDependencies): string {
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const home = dependencies.homeDirectory ?? environment.USERPROFILE ?? environment.HOME ?? process.cwd();
  if (platform === "win32") return resolve(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Apexnova", "connect");
  return resolve(environment.XDG_STATE_HOME ?? join(home, ".local", "state"), "apexnova-connect");
}

const RUNTIME_ROTATION_WINDOW_MS = 60 * 60 * 1_000;
const RUNTIME_ROTATION_LOCK_STALE_MS = 5 * 60 * 1_000;
const LIVE_VERIFY_ESTIMATE_USAGE = { inputTokens: 64, outputTokens: 256 } as const;

function currentTime(dependencies: CliDependencies): number {
  return (dependencies.now?.() ?? new Date()).getTime();
}

function filesystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function withRuntimeRotationLock<T>(
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

async function runtimeCredentialForLaunch(parsed: ParsedArguments, dependencies: CliDependencies) {
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  const initial = await bindings.load(parsed.profile);
  if (!initial) throw new CliError({ code: "RUNTIME_CREDENTIAL_NOT_FOUND", message: "No runtime credential is stored for this profile; run connect first.", exitCode: EXIT_CODES.authentication });
  if (initial.kind === "user" || initial.expiresAt === undefined) {
    return { binding: initial, rotated: false, warnings: [] as string[] };
  }
  if (Date.parse(initial.expiresAt) - currentTime(dependencies) > RUNTIME_ROTATION_WINDOW_MS) {
    return { binding: initial, rotated: false, warnings: [] as string[] };
  }

  return withRuntimeRotationLock(parsed, dependencies, async () => {
    const current = await bindings.load(parsed.profile);
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
      name: `OpenCode (${parsed.profile})`,
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
      await bindings.save(parsed.profile, replacement);
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

interface OpenCodePlanInput {
  readonly dependencies: CliDependencies;
  readonly configPath: string;
  readonly existingContent: string | null;
  readonly deployment: HubCatalogDeployment;
  readonly protocol: HubCatalogProtocol;
  readonly mappedProtocol: "openai-responses" | "openai-chat-completions";
  readonly modelName?: string;
}

function buildOpenCodePlan(input: OpenCodePlanInput): ReturnType<typeof planOpenCodeV2Config> {
  const serviceModelId = input.deployment.inferenceAlias;
  if (!serviceModelId) {
    throw new CliError({ code: "INVALID_RESPONSE", message: "The selected deployment has no public inference model alias.", exitCode: EXIT_CODES.runtime });
  }
  const limits = input.deployment.limits;
  return planOpenCodeV2Config({
    planId: `plan.${randomUUID()}`,
    createdAt: new Date().toISOString(),
    configPath: input.configPath,
    existingContent: input.existingContent,
    hubBaseUrl: openCodeBaseUrl(input.protocol.baseUrl, input.protocol.protocol),
    allowInsecureLoopback: (input.dependencies.environment ?? process.env).APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK === "1",
    models: [{
      id: serviceModelId,
      name: input.deployment.displayName || input.modelName || serviceModelId,
      protocol: input.mappedProtocol,
      upstreamId: serviceModelId,
      ...(limits?.contextWindow && limits.maxOutputTokens
        ? { limits: { context: limits.contextWindow, output: limits.maxOutputTokens } }
        : {}),
    }],
    defaultModelId: serviceModelId,
  });
}

function safePlan(plan: ReturnType<typeof planOpenCodeV2Config>) {
  return {
    id: plan.id,
    integrationId: plan.integrationId,
    summary: plan.summary,
    createdAt: plan.createdAt,
    operations: plan.operations.map((operation) => ({
      type: operation.type,
      path: operation.path,
      mode: operation.mode,
      expectedContentHash: operation.expectedContentHash,
      containsSecrets: operation.containsSecrets,
      contentBytes: Buffer.byteLength(operation.content, "utf8"),
    })),
    requiresRestart: plan.requiresRestart,
    warnings: plan.warnings,
  };
}

async function createOpenCodePlan(parsed: ParsedArguments, dependencies: CliDependencies) {
  requireAgent(parsed.operands, false);
  if (!parsed.deployment) throw new CliError({ code: "INVALID_ARGUMENT", message: "connect requires --deployment <id>.", exitCode: EXIT_CODES.usage });
  const detection = await (dependencies.detectOpenCode ?? detectOpenCode)(detectionOptions(parsed, dependencies));
  if (detection.status === "not-found") throw new CliError({ code: "AGENT_NOT_FOUND", message: "OpenCode was not found in the current environment.", exitCode: EXIT_CODES.unavailable });
  const inspection = await (dependencies.inspectOpenCode ?? inspectOpenCode)(detection);
  if (inspection.status === "legacy" || inspection.status === "invalid") throw new CliError({ code: inspection.status === "legacy" ? "LEGACY_CONFIG" : "INVALID_CONFIG", message: inspection.warnings[0] ?? "OpenCode configuration is unsupported.", exitCode: EXIT_CODES.conflict });
  const catalog = await hubService(parsed, dependencies).catalog(parsed.profile, operationSignal(parsed));
  const deployment = catalog.deployments.find((item) => item.id === parsed.deployment);
  if (!deployment) throw new CliError({ code: "DEPLOYMENT_NOT_FOUND", message: "The selected deployment is not present in the visible Hub catalog.", exitCode: EXIT_CODES.unavailable });
  if (deployment.availability.status !== "available" && deployment.availability.status !== "degraded") throw new CliError({ code: "DEPLOYMENT_UNAVAILABLE", message: `Deployment ${deployment.id} is ${deployment.availability.status}.`, exitCode: EXIT_CODES.unavailable });
  const protocol = deployment.protocols.find((item) => item.protocol === parsed.protocol) ?? (parsed.protocol ? undefined : deployment.protocols.find((item) => openCodeProtocol(item.protocol)));
  const mappedProtocol = protocol ? openCodeProtocol(protocol.protocol) : undefined;
  if (!protocol || !mappedProtocol) throw new CliError({ code: "PROTOCOL_NOT_SUPPORTED", message: "The selected deployment does not expose a supported OpenCode protocol.", exitCode: EXIT_CODES.unavailable });
  const model = catalog.models.find((item) => item.id === deployment.modelId);
  let existingContent: string | null = null;
  if (detection.configExists) {
    try {
      existingContent = await readFile(detection.configPath, { encoding: "utf8", signal: operationSignal(parsed) });
    } catch (cause) {
      throw new CliError({ code: "CONFIG_READ_FAILED", message: "OpenCode configuration could not be read.", exitCode: EXIT_CODES.permission, cause });
    }
    if (Buffer.byteLength(existingContent, "utf8") > 2 * 1024 * 1024) throw new CliError({ code: "CONFIG_TOO_LARGE", message: "OpenCode configuration exceeds the 2 MiB planning limit.", exitCode: EXIT_CODES.conflict });
  }
  const plan = buildOpenCodePlan({
    dependencies,
    configPath: detection.configPath,
    existingContent,
    deployment,
    protocol,
    mappedProtocol,
    ...(model?.name ? { modelName: model.name } : {}),
  });
  return { plan, deployment, protocol, catalogVersion: catalog.catalogVersion, detection };
}

async function executeConnect(parsed: ParsedArguments, dependencies: CliDependencies) {
  const result = await createOpenCodePlan(parsed, dependencies);
  const plan = safePlan(result.plan);
  if (parsed.dryRun) {
    const warnings = [...result.plan.warnings, "Dry-run performed no local writes and created no runtime credential."];
    return { data: { dryRun: true, catalogVersion: result.catalogVersion, deploymentId: result.deployment.id, protocol: result.protocol.protocol, plan }, warnings, human: [`Plan: ${plan.id}`, `Deployment: ${result.deployment.id}`, `Protocol: ${result.protocol.protocol}`, `Operations: ${plan.operations.length}`, ...plan.operations.map((operation) => `${operation.mode} ${operation.path} (${operation.contentBytes} bytes)`), "No changes were applied."].join("\n") };
  }
  if (!parsed.yes) {
    throw new CliError({ code: "APPROVAL_REQUIRED", message: "connect requires --yes after reviewing connect --dry-run.", exitCode: EXIT_CODES.permission, details: { plan } });
  }

  const service = hubService(parsed, dependencies);
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  const previous = await bindings.load(parsed.profile);
  await mkdir(dirname(result.detection.configPath), { recursive: true, mode: 0o700 });
  const created = await service.createRuntimeCredential(parsed.profile, {
    name: `OpenCode (${parsed.profile})`,
    protocols: [result.protocol.protocol],
    publicDeploymentIds: [result.deployment.id],
    expiresIn: 86_400,
  }, operationSignal(parsed));
  const stateRoot = localStateRoot(dependencies);
  const backupRoot = join(stateRoot, "backups");
  const executor = new FileConfigExecutor({ allowedRoots: [dirname(result.detection.configPath)], backupRoot });
  let receipt: Awaited<ReturnType<FileConfigExecutor["apply"]>> | undefined;
  try {
    if (result.plan.operations.length > 0) receipt = await executor.apply(result.plan);
    const updatedDetection: OpenCodeDetection = { ...result.detection, configExists: true, status: result.detection.status === "not-found" ? "config-only" : result.detection.status };
    const inspection = await (dependencies.inspectOpenCode ?? inspectOpenCode)(updatedDetection);
    if (inspection.status !== "configured" || !inspection.managed || !inspection.provider?.modelIds.includes(result.deployment.inferenceAlias)) {
      throw new CliError({ code: "VERIFICATION_FAILED", message: "Applied OpenCode configuration did not pass configuration verification.", exitCode: EXIT_CODES.verification });
    }
    const transactionId = receipt && typeof receipt.rollbackToken === "object" && receipt.rollbackToken !== null && "transactionId" in receipt.rollbackToken && typeof receipt.rollbackToken.transactionId === "string" ? receipt.rollbackToken.transactionId : undefined;
    await bindings.save(parsed.profile, {
      credentialId: created.credentialId,
      secret: created.secret,
      expiresAt: created.expiresAt,
      protocol: result.protocol.protocol,
      deploymentId: result.deployment.id,
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
    await service.revokeRuntimeCredential(parsed.profile, created.credentialId, compensationSignal(parsed)).catch((error: unknown) => failures.push(error));
    if (failures.length > 1) throw new CliError({ code: "CONNECT_ROLLBACK_INCOMPLETE", message: "Connection failed and cleanup did not fully complete.", exitCode: EXIT_CODES.recovery, cause: new AggregateError(failures) });
    throw cause;
  }

  const warnings = [...result.plan.warnings];
  if (previous && previous.credentialId !== created.credentialId) {
    try {
      await service.revokeRuntimeCredential(parsed.profile, previous.credentialId, compensationSignal(parsed));
    } catch {
      warnings.push(`Previous runtime credential ${previous.credentialId} could not be revoked automatically.`);
    }
  }
  const transactionId = receipt && typeof receipt.rollbackToken === "object" && receipt.rollbackToken !== null && "transactionId" in receipt.rollbackToken && typeof receipt.rollbackToken.transactionId === "string" ? receipt.rollbackToken.transactionId : undefined;
  return {
    data: { connected: true, profile: parsed.profile, deploymentId: result.deployment.id, protocol: result.protocol.protocol, credentialId: created.credentialId, credentialExpiresAt: created.expiresAt, transactionId, plan },
    warnings,
    human: [`Connected OpenCode to ${result.deployment.displayName}.`, `Runtime credential expires: ${created.expiresAt}`, ...(transactionId ? [`Restore transaction: ${transactionId}`] : []), "Launch with: apexnova run opencode"].join("\n"),
  };
}

interface OpenCodeLaunchOutcome {
  readonly binding: RuntimeCredentialBinding;
  readonly rotated: boolean;
  readonly warnings: readonly string[];
}

/**
 * Injects the bound secret into the child environment only, then waits for
 * OpenCode to exit. The secret never reaches argv, the config file, or a log.
 */
async function launchOpenCodeWithBinding(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  binding: RuntimeCredentialBinding,
  agentArgs: readonly string[],
): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...(dependencies.environment ?? process.env),
    APEXNOVA_API_KEY: binding.secret.reveal(),
  };
  const exitCode = await (dependencies.launchOpenCode ?? defaultLaunchOpenCode)(agentArgs, environment);
  if (exitCode !== 0) {
    throw new CliError({
      code: "AGENT_EXITED",
      message: `OpenCode exited with code ${exitCode}.`,
      exitCode: EXIT_CODES.runtime,
      details: { agentExitCode: exitCode },
    });
  }
}

async function executeRun(parsed: ParsedArguments, dependencies: CliDependencies) {
  const [agent, ...agentArgs] = parsed.operands;
  if (agent !== "opencode") throw new CliError({ code: "INVALID_ARGUMENT", message: "run requires opencode as its first argument.", exitCode: EXIT_CODES.usage });
  const detection = await (dependencies.detectOpenCode ?? detectOpenCode)(detectionOptions(parsed, dependencies));
  if (detection.status !== "installed") {
    throw new CliError({ code: "AGENT_NOT_FOUND", message: "OpenCode executable was not found; install OpenCode before using the launcher.", exitCode: EXIT_CODES.unavailable });
  }
  const runtime = await runtimeCredentialForLaunch(parsed, dependencies);
  const binding = runtime.binding;
  await launchOpenCodeWithBinding(parsed, dependencies, binding, agentArgs);
  return {
    data: { agentId: "opencode", profile: parsed.profile, deploymentId: binding.deploymentId, credentialExpiresAt: binding.expiresAt, credentialRotated: runtime.rotated, exited: true, agentExitCode: 0 },
    warnings: runtime.warnings,
    human: `${runtime.rotated ? "Runtime credential renewed.\n" : ""}OpenCode exited successfully.`,
  };
}

async function resolveDeploymentForOpenCode(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  catalog: HubCatalogSnapshot,
  existingDeploymentId?: string,
): Promise<HubCatalogDeployment> {
  const supported = new Set(["openai-responses", "openai-chat"]);
  const compatible = catalog.deployments.filter((deployment) =>
    deployment.availability.status === "available" &&
    deployment.protocols.some((protocol) => supported.has(protocol.protocol)),
  );
  if (parsed.deployment) {
    const deployment = catalog.deployments.find((item) => item.id === parsed.deployment);
    if (!deployment) throw new CliError({ code: "DEPLOYMENT_NOT_FOUND", message: "The selected deployment is not present in the visible Hub catalog.", exitCode: EXIT_CODES.unavailable });
    if (deployment.availability.status !== "available" && deployment.availability.status !== "degraded") throw new CliError({ code: "DEPLOYMENT_UNAVAILABLE", message: `Deployment ${deployment.id} is ${deployment.availability.status}.`, exitCode: EXIT_CODES.unavailable });
    return deployment;
  }
  if (existingDeploymentId) {
    const existing = catalog.deployments.find((item) => item.id === existingDeploymentId);
    if (existing && (existing.availability.status === "available" || existing.availability.status === "degraded")) return existing;
  }
  if (compatible.length === 0) throw new CliError({ code: "DEPLOYMENT_NOT_FOUND", message: "No compatible deployments are available.", exitCode: EXIT_CODES.unavailable });
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

async function ensureCredentialForOpenCode(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  deployment: HubCatalogDeployment,
  protocol: HubCatalogProtocol,
): Promise<RuntimeCredentialBinding> {
  const service = hubService(parsed, dependencies);
  const signal = operationSignal(parsed);
  if (parsed.apiKeyId) {
    const keyInfo = await service.apiKey(parsed.profile, parsed.apiKeyId, signal);
    const bindings = new RuntimeBindingStore(credentialStore(dependencies));
    const existing = await bindings.load(parsed.profile);
    if (existing && existing.credentialId === parsed.apiKeyId) {
      return existing;
    }
    const io = dependencies.io ?? defaultIo();
    let secret: string;
    if (io.isInteractive && !parsed.nonInteractive) {
      secret = await password({ message: `Paste the secret for key ${keyInfo.prefix}:`, mask: "*" });
    } else {
      const envKey = (dependencies.environment ?? process.env).APEXNOVA_API_KEY;
      if (!envKey) throw new CliError({ code: "APPROVAL_REQUIRED", message: `--key ${parsed.apiKeyId} requires the key secret; set APEXNOVA_API_KEY env var or run in interactive mode.`, exitCode: EXIT_CODES.permission });
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
  if (parsed.rotating) {
    const created = await service.createRuntimeCredential(parsed.profile, {
      name: `OpenCode (${parsed.profile})`,
      protocols: [protocol.protocol],
      publicDeploymentIds: [deployment.id],
      expiresIn: 86_400,
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
    name: `OpenCode (${parsed.profile})`,
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

async function configureOpenCode(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  deployment: HubCatalogDeployment,
  protocol: HubCatalogProtocol,
  catalog: HubCatalogSnapshot,
): Promise<{ readonly binding: RuntimeCredentialBinding; readonly transactionId?: string; readonly warnings: readonly string[] }> {
  const service = hubService(parsed, dependencies);
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  const previous = await bindings.load(parsed.profile);
  const detection = await (dependencies.detectOpenCode ?? detectOpenCode)(detectionOptions(parsed, dependencies));
  if (detection.status === "not-found") throw new CliError({ code: "AGENT_NOT_FOUND", message: "OpenCode was not found in the current environment.", exitCode: EXIT_CODES.unavailable });
  const model = catalog.models.find((item) => item.id === deployment.modelId);
  const mappedProtocol = openCodeProtocol(protocol.protocol);
  if (!mappedProtocol) throw new CliError({ code: "PROTOCOL_NOT_SUPPORTED", message: "The selected deployment does not expose a supported OpenCode protocol.", exitCode: EXIT_CODES.unavailable });
  let existingContent: string | null = null;
  if (detection.configExists) {
    try {
      existingContent = await readFile(detection.configPath, { encoding: "utf8", signal: operationSignal(parsed) });
    } catch (cause) {
      throw new CliError({ code: "CONFIG_READ_FAILED", message: "OpenCode configuration could not be read.", exitCode: EXIT_CODES.permission, cause });
    }
  }
  const plan = buildOpenCodePlan({
    dependencies,
    configPath: detection.configPath,
    existingContent,
    deployment,
    protocol,
    mappedProtocol,
    ...(model?.name ? { modelName: model.name } : {}),
  });
  await mkdir(dirname(detection.configPath), { recursive: true, mode: 0o700 });
  const binding = await ensureCredentialForOpenCode(parsed, dependencies, deployment, protocol);
  const stateRoot = localStateRoot(dependencies);
  const backupRoot = join(stateRoot, "backups");
  const executor = new FileConfigExecutor({ allowedRoots: [dirname(detection.configPath)], backupRoot });
  let receipt: Awaited<ReturnType<FileConfigExecutor["apply"]>> | undefined;
  const warnings: string[] = [...plan.warnings];
  try {
    if (plan.operations.length > 0) receipt = await executor.apply(plan);
    await bindings.save(parsed.profile, {
      ...binding,
      ...(receipt && typeof receipt.rollbackToken === "object" && receipt.rollbackToken !== null && "transactionId" in receipt.rollbackToken && typeof receipt.rollbackToken.transactionId === "string" ? { transactionId: receipt.rollbackToken.transactionId } : {}),
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
    if (binding.kind === "runtime") await service.revokeRuntimeCredential(parsed.profile, binding.credentialId, compensationSignal(parsed)).catch((error: unknown) => failures.push(error));
    else await service.revokeApiKey(parsed.profile, binding.credentialId, compensationSignal(parsed)).catch((error: unknown) => failures.push(error));
    if (failures.length > 1) throw new CliError({ code: "CONNECT_ROLLBACK_INCOMPLETE", message: "Connection failed and cleanup did not fully complete.", exitCode: EXIT_CODES.recovery, cause: new AggregateError(failures) });
    throw cause;
  }
  if (previous && previous.credentialId !== binding.credentialId) {
    try {
      if (previous.kind === "runtime") await service.revokeRuntimeCredential(parsed.profile, previous.credentialId, compensationSignal(parsed));
      else await service.revokeApiKey(parsed.profile, previous.credentialId, compensationSignal(parsed));
    } catch {
      warnings.push(`Previous credential ${previous.credentialId} could not be revoked automatically.`);
    }
  }
  const transactionId = receipt && typeof receipt.rollbackToken === "object" && receipt.rollbackToken !== null && "transactionId" in receipt.rollbackToken && typeof receipt.rollbackToken.transactionId === "string" ? receipt.rollbackToken.transactionId : undefined;
  return { binding, ...(transactionId ? { transactionId } : {}), warnings };
}

async function executeOpenCode(parsed: ParsedArguments, dependencies: CliDependencies) {
  const io = dependencies.io ?? defaultIo();
  const service = hubService(parsed, dependencies);
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  const detection = await (dependencies.detectOpenCode ?? detectOpenCode)(detectionOptions(parsed, dependencies));
  if (detection.status !== "installed" && detection.status !== "config-only") {
    throw new CliError({ code: "AGENT_NOT_FOUND", message: "OpenCode was not found; install OpenCode first.", exitCode: EXIT_CODES.unavailable });
  }
  const existing = await bindings.load(parsed.profile);
  const needConfig = !existing || parsed.deployment !== undefined;
  let binding = existing;
  const configureWarnings: string[] = [];
  if (needConfig) {
    const catalog = await service.catalog(parsed.profile, operationSignal(parsed));
    const deployment = await resolveDeploymentForOpenCode(parsed, dependencies, catalog, existing?.deploymentId);
    const supported = new Set(["openai-responses", "openai-chat"]);
    const protocol = deployment.protocols.find((item) => supported.has(item.protocol));
    if (!protocol) throw new CliError({ code: "PROTOCOL_NOT_SUPPORTED", message: "The selected deployment does not expose a supported OpenCode protocol.", exitCode: EXIT_CODES.unavailable });
    const result = await configureOpenCode(parsed, dependencies, deployment, protocol, catalog);
    binding = result.binding;
    configureWarnings.push(...result.warnings);
    if (!parsed.json) io.stderr(`Configured OpenCode with ${deployment.displayName} (${deployment.inferenceAlias}).\n`);
  }
  if (!binding) throw new CliError({ code: "RUNTIME_CREDENTIAL_NOT_FOUND", message: "No credential is stored for this profile.", exitCode: EXIT_CODES.authentication });
  // A credential we just minted cannot be near expiry, so skip the rotation
  // check and its extra credential-store round trip on the configure path.
  const runtime: OpenCodeLaunchOutcome = needConfig
    ? { binding, rotated: false, warnings: [] }
    : await runtimeCredentialForLaunch(parsed, dependencies);
  binding = runtime.binding;
  await launchOpenCodeWithBinding(parsed, dependencies, binding, parsed.operands);
  return {
    data: { agentId: "opencode", profile: parsed.profile, deploymentId: binding.deploymentId, credentialKind: binding.kind ?? "runtime", credentialExpiresAt: binding.expiresAt, credentialRotated: runtime.rotated, exited: true, agentExitCode: 0 },
    warnings: [...configureWarnings, ...runtime.warnings],
    human: `${runtime.rotated ? "Credential renewed.\n" : ""}OpenCode exited successfully.`,
  };
}

async function executeUsage(parsed: ParsedArguments, dependencies: CliDependencies) {
  noOperands(parsed);
  const service = hubService(parsed, dependencies);
  const query: UsageQuery = {
    ...(parsed.apiKeyId ? { apiKeyId: parsed.apiKeyId } : {}),
    ...(parsed.from ? { from: parsed.from } : {}),
    ...(parsed.to ? { to: parsed.to } : {}),
    ...(parsed.granularity ? { granularity: parsed.granularity } : {}),
  };
  const result = await service.usageQuery(parsed.profile, query, operationSignal(parsed));
  if ("granularity" in result) {
    const rows = result.items.map((item) =>
      `${item.bucketStart}  ${item.apiKeyName ?? item.apiKeyId ?? "-"}  ${item.resolvedModel ?? "-"}  ${item.requestCount} req  ${item.normalCost} ${item.currency}`,
    );
    return {
      data: result,
      warnings: [] as readonly string[],
      human: rows.length === 0 ? "No usage records in the selected range." : [`Granularity: ${result.granularity}`, ...rows].join("\n"),
    };
  }
  const rows = result.items.map((item) =>
    `${item.at}  ${item.apiKeyId ?? "-"}  ${item.resolvedModel}  ${item.amount} ${item.currency}`,
  );
  return {
    data: result,
    warnings: [] as readonly string[],
    human: rows.length === 0 ? "No usage records." : rows.join("\n"),
  };
}

async function executeVerify(parsed: ParsedArguments, dependencies: CliDependencies) {
  requireAgent(parsed.operands, false);
  const detection = await (dependencies.detectOpenCode ?? detectOpenCode)(detectionOptions(parsed, dependencies));
  if (detection.status === "not-found") throw new CliError({ code: "AGENT_NOT_FOUND", message: "OpenCode was not found in the current environment.", exitCode: EXIT_CODES.unavailable });
  const inspection = await (dependencies.inspectOpenCode ?? inspectOpenCode)(detection);
  const valid = inspection.status === "configured" && inspection.managed && inspection.provider?.modelIds.length;
  if (!valid) throw new CliError({ code: "VERIFICATION_FAILED", message: inspection.warnings[0] ?? "OpenCode is not configured with a usable Apexnova provider.", exitCode: EXIT_CODES.verification, details: { status: inspection.status, managed: inspection.managed } });
  const configuration = { agentId: "opencode", configPath: inspection.configPath, protocol: inspection.provider?.protocol, models: inspection.provider?.modelIds };
  if (!parsed.live) {
    const warnings = ["Configuration verification passed; use --live to perform a minimal inference check."];
    return { data: { valid: true, level: "configuration", ...configuration }, warnings, human: `OpenCode configuration is valid for ${inspection.provider?.modelIds.join(", ")}. Live inference was not tested.` };
  }

  const binding = await new RuntimeBindingStore(credentialStore(dependencies)).load(parsed.profile);
  if (!binding) throw new CliError({ code: "RUNTIME_CREDENTIAL_NOT_FOUND", message: "No runtime credential is stored for this profile; run connect first.", exitCode: EXIT_CODES.authentication });
  if (binding.expiresAt !== undefined && Date.parse(binding.expiresAt) <= Date.now()) throw new CliError({ code: "RUNTIME_CREDENTIAL_EXPIRED", message: "The stored runtime credential has expired; reconnect before live verification.", exitCode: EXIT_CODES.authentication });
  if (binding.protocol !== "openai-responses" && binding.protocol !== "openai-chat") {
    throw new CliError({ code: "PROTOCOL_NOT_SUPPORTED", message: `Live verification does not support ${binding.protocol}.`, exitCode: EXIT_CODES.unavailable });
  }
  const bindingProtocol = binding.protocol;
  const service = hubService(parsed, dependencies);
  const catalog = await service.catalog(parsed.profile, operationSignal(parsed));
  const deployment = catalog.deployments.find((item) => item.id === binding.deploymentId);
  const protocol = deployment?.protocols.find((item) => item.protocol === binding.protocol);
  if (!deployment || !protocol || !inspection.provider?.modelIds.includes(deployment.inferenceAlias)) {
    throw new CliError({ code: "BINDING_MISMATCH", message: "The stored runtime credential no longer matches the visible catalog and OpenCode configuration.", exitCode: EXIT_CODES.verification });
  }
  const estimate = await service.estimatePricing(parsed.profile, deployment.id, LIVE_VERIFY_ESTIMATE_USAGE, operationSignal(parsed));
  if (!parsed.yes) {
    throw new CliError({
      code: "APPROVAL_REQUIRED",
      message: `Hub estimates ${estimate.amount} ${estimate.currency} for the verification assumption; this is not a spending cap. Re-run with --yes to approve the request.`,
      exitCode: EXIT_CODES.permission,
      details: { estimate, estimateAssumptions: LIVE_VERIFY_ESTIMATE_USAGE },
    });
  }
  const environment = dependencies.environment ?? process.env;
  const inference = await withRetry(() => (dependencies.verifyHubInference ?? verifyHubInference)({
    endpoint: protocol.baseUrl,
    protocol: bindingProtocol,
    model: deployment.inferenceAlias,
    deploymentId: deployment.id,
    runtimeCredential: binding.secret,
    requestTimeoutMs: parsed.timeoutSeconds * 1_000,
    allowInsecureLoopback: environment.APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK === "1",
    ...(environment.APEXNOVA_HUB_LOOPBACK_HOST_ALIAS ? { loopbackHostAlias: environment.APEXNOVA_HUB_LOOPBACK_HOST_ALIAS } : {}),
    signal: operationSignal(parsed),
  }), { sleep: dependencies.sleep ?? defaultSleep, signal: operationSignal(parsed) });
  let usage: HubUsageRecord | undefined;
  let usageWarning: string | undefined;
  try {
    usage = await service.usage(parsed.profile, inference.requestId, operationSignal(parsed));
    if (!usage) usageWarning = "The Hub has not settled this request yet; reconcile the billed cost later with the requestId below.";
  } catch (error) {
    usageWarning = `Billing reconciliation skipped: ${normalizeError(error).code}. The requestId below is the source of truth for the real cost.`;
  }
  const billedLine = usage
    ? `Billed: ${usage.amount} ${usage.currency} (${usage.usage.inputTokens ?? 0} input + ${usage.usage.outputTokens ?? 0} output tokens)`
    : `Billed: not yet available`;
  return {
    data: { valid: true, level: "live", ...configuration, estimate, estimateAssumptions: LIVE_VERIFY_ESTIMATE_USAGE, inference, ...(usage ? { usage } : {}) },
    warnings: usageWarning ? [usageWarning] : [] as readonly string[],
    human: [`OpenCode live verification passed for ${inference.requestedModel}.`, `Deployment: ${inference.deploymentId}`, `Resolved model: ${inference.resolvedModel}`, `Request: ${inference.requestId}`, billedLine, `Non-binding estimate: ${estimate.amount} ${estimate.currency} (${LIVE_VERIFY_ESTIMATE_USAGE.inputTokens} input + ${LIVE_VERIFY_ESTIMATE_USAGE.outputTokens} output tokens assumed)`].join("\n"),
  };
}

async function executeDoctor(parsed: ParsedArguments, dependencies: CliDependencies) {
  requireAgent(parsed.operands, true);
  const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }> = [];
  const detection = await (dependencies.detectOpenCode ?? detectOpenCode)(detectionOptions(parsed, dependencies));
  checks.push({ name: "opencode-discovery", status: detection.status === "not-found" ? "fail" : "pass", message: detection.status });
  if (detection.status !== "not-found") {
    try {
      const inspection = await (dependencies.inspectOpenCode ?? inspectOpenCode)(detection);
      checks.push({ name: "opencode-config", status: inspection.status === "invalid" || inspection.status === "legacy" ? "fail" : inspection.managed ? "pass" : "warn", message: inspection.status });
    } catch {
      checks.push({ name: "opencode-config", status: "fail", message: "unreadable" });
    }
  }
  const platform = dependencies.platform ?? process.platform;
  checks.push({ name: "credential-backend", status: platform === "win32" || platform === "linux" ? "pass" : "fail", message: platform === "win32" ? "Windows Credential Manager" : platform === "linux" ? "Secret Service" : `unsupported on ${platform}` });
  checks.push({ name: "state-root", status: "pass", message: localStateRoot(dependencies) });
  const hubConfig = resolveHubConfig(hubConfigContext(dependencies));
  checks.push({
    name: "hub-endpoint",
    status: hubConfig ? "pass" : "fail",
    message: hubConfig ? `${hubConfig.baseUrl} (${hubConfig.source})` : "not configured; run `apexnova init`",
  });
  try {
    const account = await hubService(parsed, dependencies).whoami(parsed.profile, operationSignal(parsed));
    checks.push({ name: "hub-session", status: "pass", message: account.accountId ?? account.userId });
  } catch (error) {
    const normalized = normalizeError(error);
    checks.push({ name: "hub-session", status: "warn", message: normalized.code });
  }
  const failed = checks.some((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status !== "pass").map((check) => `${check.name}: ${check.message}`);
  return { data: { healthy: !failed, checks }, warnings, human: checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.message}`).join("\n") };
}

async function executeRestore(parsed: ParsedArguments, dependencies: CliDependencies) {
  if (parsed.operands.length > 1) throw new CliError({ code: "INVALID_ARGUMENT", message: "restore accepts at most one transaction ID.", exitCode: EXIT_CODES.usage });
  const backupRoot = join(localStateRoot(dependencies), "backups");
  const environment = dependencies.environment ?? process.env;
  const home = dependencies.homeDirectory ?? environment.USERPROFILE ?? environment.HOME ?? process.cwd();
  const candidates = [
    resolve(dependencies.cwd ?? process.cwd()),
    join(home, ".config", "opencode"),
    ...(environment.XDG_CONFIG_HOME ? [join(environment.XDG_CONFIG_HOME, "opencode")] : []),
    ...(environment.APPDATA ? [join(environment.APPDATA, "opencode")] : []),
    ...(parsed.configPath ? [dirname(resolve(parsed.configPath))] : []),
    localStateRoot(dependencies),
  ];
  const allowedRoots: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate);
      allowedRoots.push(candidate);
    } catch {
      // An absent known root is not trusted merely because of its name.
    }
  }
  const executor = new FileConfigExecutor({ allowedRoots, backupRoot });
  const transactionId = parsed.operands[0];
  if (parsed.list || transactionId === undefined) {
    const backups = await executor.listBackups();
    return { data: { backups }, warnings: [] as readonly string[], human: backups.length === 0 ? "No restorable transactions." : backups.map((item) => `${item.transactionId}  ${item.integrationId}  ${item.state}  ${item.appliedAt}`).join("\n") };
  }
  const summary = (await executor.listBackups()).find((item) => item.transactionId === transactionId);
  const receipt = await executor.getReceipt(transactionId);
  if (parsed.dryRun) return { data: { dryRun: true, transactionId, planId: receipt.planId }, warnings: ["Dry-run did not restore files."], human: `Transaction ${transactionId} can be restored. No files were changed.` };
  if (!parsed.yes) throw new CliError({ code: "APPROVAL_REQUIRED", message: "restore requires --yes after reviewing the transaction or --dry-run.", exitCode: EXIT_CODES.permission });
  const warnings: string[] = [];
  let runtimeCredentialRevoked: boolean | undefined;
  let runtimeCredentialRestored = false;
  const bindings = summary?.integrationId === "opencode" ? new RuntimeBindingStore(credentialStore(dependencies)) : undefined;
  const binding = bindings ? await bindings.load(parsed.profile) : null;
  if (binding?.transactionId && binding.transactionId !== transactionId) {
    throw new CliError({ code: "RESTORE_ORDER_CONFLICT", message: `Restore ${binding.transactionId} before restoring ${transactionId}.`, exitCode: EXIT_CODES.conflict });
  }

  let replacement: typeof binding = null;
  if (binding?.restoreTarget) {
    const service = hubService(parsed, dependencies);
    const target = binding.restoreTarget;
    const catalog = await service.catalog(parsed.profile, operationSignal(parsed));
    const deployment = catalog.deployments.find((item) => item.id === target.deploymentId);
    const protocol = deployment?.protocols.find((item) => item.protocol === target.protocol);
    if (!deployment || !protocol || (deployment.availability.status !== "available" && deployment.availability.status !== "degraded")) {
      throw new CliError({ code: "BINDING_MISMATCH", message: "The previous runtime target is no longer available; configuration was not restored.", exitCode: EXIT_CODES.verification });
    }
    const created = await service.createRuntimeCredential(parsed.profile, {
      name: `OpenCode (${parsed.profile})`,
      protocols: [target.protocol],
      publicDeploymentIds: [target.deploymentId],
      expiresIn: 86_400,
    }, operationSignal(parsed));
    try {
      const active = (await service.runtimeCredentials(parsed.profile, operationSignal(parsed))).find((item) => item.credentialId === created.credentialId);
      if (!active || !active.protocols.includes(target.protocol) || !active.publicDeploymentIds.includes(target.deploymentId)) {
        throw new CliError({ code: "VERIFICATION_FAILED", message: "The restored runtime credential did not pass control-plane verification.", exitCode: EXIT_CODES.verification });
      }
      replacement = {
        credentialId: created.credentialId,
        secret: created.secret,
        expiresAt: created.expiresAt,
        protocol: target.protocol,
        deploymentId: target.deploymentId,
        ...(target.transactionId ? { transactionId: target.transactionId } : {}),
        ...(target.restoreTarget ? { restoreTarget: target.restoreTarget } : {}),
      };
    } catch (cause) {
      await service.revokeRuntimeCredential(parsed.profile, created.credentialId, compensationSignal(parsed)).catch(() => {});
      throw cause;
    }
  }

  try {
    await executor.rollback(receipt);
  } catch (cause) {
    if (replacement) await hubService(parsed, dependencies).revokeRuntimeCredential(parsed.profile, replacement.credentialId, compensationSignal(parsed)).catch(() => {});
    throw cause;
  }
  if (summary?.integrationId === "opencode") {
    if (binding) {
      if (replacement && bindings) {
        try {
          await bindings.save(parsed.profile, replacement);
          runtimeCredentialRestored = true;
        } catch (cause) {
          await hubService(parsed, dependencies).revokeRuntimeCredential(parsed.profile, replacement.credentialId, compensationSignal(parsed)).catch(() => {});
          await hubService(parsed, dependencies).revokeRuntimeCredential(parsed.profile, binding.credentialId, compensationSignal(parsed)).catch(() => {});
          await bindings.delete(parsed.profile).catch(() => {});
          throw new CliError({ code: "RESTORE_BINDING_INCOMPLETE", message: "Configuration was restored, but the replacement runtime credential could not be saved; the profile was disconnected.", exitCode: EXIT_CODES.recovery, cause });
        }
      }
      try {
        await hubService(parsed, dependencies).revokeRuntimeCredential(parsed.profile, binding.credentialId, compensationSignal(parsed));
        runtimeCredentialRevoked = true;
      } catch {
        runtimeCredentialRevoked = false;
        warnings.push(`Runtime credential ${binding.credentialId} could not be revoked from Hub; revoke the device or credential manually.`);
      }
      if (!replacement) await bindings?.delete(parsed.profile);
    }
  }
  return {
    data: { restored: true, transactionId, planId: receipt.planId, runtimeCredentialRestored, ...(runtimeCredentialRevoked === undefined ? {} : { runtimeCredentialRevoked }) },
    warnings,
    human: `Restored transaction ${transactionId}.${runtimeCredentialRestored ? " Previous runtime connection was reissued." : ""}${runtimeCredentialRevoked === false ? " Runtime credential requires manual revocation." : ""}`,
  };
}

function normalizeError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof OpenCodeInspectionError) {
    return new CliError({
      code: error.code,
      message: error.message,
      exitCode: EXIT_CODES.conflict,
      cause: error,
    });
  }
  if (error instanceof OpenCodeConfigError) {
    return new CliError({
      code: error.code,
      message: error.message,
      exitCode: error.code === "INVALID_CONFIG" || error.code === "LEGACY_CONFIG" ? EXIT_CODES.conflict : EXIT_CODES.usage,
      cause: error,
    });
  }
  if (error instanceof HubClientError) {
    const exitCode = error.code === "HUB_NOT_CONFIGURED"
      ? EXIT_CODES.usage
      : error.code === "SESSION_NOT_FOUND" || error.code === "UNAUTHENTICATED" || error.code === "INSUFFICIENT_SCOPE" || error.code === "SESSION_CORRUPT" || error.code === "REFRESH_TOKEN_MISSING" || error.code === "OAUTH_ERROR" || error.code === "DEVICE_CODE_EXPIRED"
      ? EXIT_CODES.authentication
      : error.code === "ACCESS_DENIED" || error.code === "FORBIDDEN" || error.code === "KEY_TTL_POLICY"
        ? EXIT_CODES.permission
        : error.code === "NETWORK_ERROR" || error.code === "API_ERROR" || error.code === "RATE_LIMITED"
          ? EXIT_CODES.network
          : error.code === "BILLING_BLOCKED"
            ? EXIT_CODES.billing
            : EXIT_CODES.runtime;
    const message = error.code === "INSUFFICIENT_SCOPE"
      ? "Your session lacks the required scopes (api-keys:*). Run `apexnova login` to re-authorize with the new permissions."
      : error.code === "KEY_TTL_POLICY"
        ? "Your organization requires keys to have a maximum TTL. Use --rotating for short-lived credentials or specify a shorter expiry."
        : error.message;
    return new CliError({ code: error.code, message, exitCode, retryable: error.retryable, ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}), ...(error.requestId ? { details: { requestId: error.requestId } } : {}), cause: error });
  }
  if (error instanceof ConfigExecutionError) {
    return new CliError({ code: error.code, message: error.message, exitCode: error.code === "ROLLBACK_FAILED" || error.code === "INVALID_RECEIPT" ? EXIT_CODES.recovery : error.code === "CONFLICT" ? EXIT_CODES.conflict : EXIT_CODES.runtime, cause: error });
  }
  return new CliError({
    code: "UNEXPECTED_ERROR",
    message: "The command failed unexpectedly.",
    exitCode: EXIT_CODES.runtime,
    cause: error,
  });
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<CliRunResult> {
  const io = dependencies.io ?? defaultIo();
  const requestId = (dependencies.createRequestId ?? (() => `local_${randomUUID()}`))();
  let parsed: ParsedArguments | undefined;

  try {
    parsed = parseArguments(args);
    if (parsed.help || (!parsed.command && !parsed.version)) {
      io.stdout(HELP);
      return { exitCode: EXIT_CODES.success, requestId };
    }
    if (parsed.version) {
      io.stdout(parsed.json
        ? `${JSON.stringify({ schemaVersion: "1", command: "version", requestId, ok: true, data: { version: CLI_VERSION }, warnings: [] }, null, 2)}\n`
        : `apexnova ${CLI_VERSION}\n`);
      return { exitCode: EXIT_CODES.success, requestId };
    }

    let result;
    switch (parsed.command) {
      case "detect":
        result = await executeDetect(parsed, dependencies);
        break;
      case "inspect":
        result = await executeInspect(parsed, dependencies);
        break;
      case "init":
        result = await executeInit(parsed, dependencies);
        break;
      case "login":
        result = await executeLogin(parsed, dependencies);
        break;
      case "logout":
        result = await executeLogout(parsed, dependencies);
        break;
      case "whoami":
        result = await executeWhoami(parsed, dependencies);
        break;
      case "balance":
        result = await executeBalance(parsed, dependencies);
        break;
      case "models":
        result = await executeModels(parsed, dependencies);
        break;
      case "opencode":
        result = await executeOpenCode(parsed, dependencies);
        break;
      case "usage":
        result = await executeUsage(parsed, dependencies);
        break;
      case "connect":
        result = await executeConnect(parsed, dependencies);
        break;
      case "switch":
        result = await executeConnect(parsed, dependencies);
        break;
      case "verify":
        result = await executeVerify(parsed, dependencies);
        break;
      case "doctor":
        result = await executeDoctor(parsed, dependencies);
        break;
      case "restore":
        result = await executeRestore(parsed, dependencies);
        break;
      case "run":
        result = await executeRun(parsed, dependencies);
        break;
      default:
        throw new CliError({
          code: "UNKNOWN_COMMAND",
          message: `Unknown command: ${parsed.command ?? ""}.`,
          exitCode: EXIT_CODES.usage,
        });
    }

    if (parsed.json) writeJsonSuccess(io, parsed.command, requestId, result.data, result.warnings);
    else io.stdout(`${result.human}\n`);
    return { exitCode: EXIT_CODES.success, requestId };
  } catch (error) {
    const normalized = normalizeError(error);
    const command = parsed?.command ?? "unknown";
    const shape: CliErrorShape = {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.retryAfterSeconds !== undefined ? { retryAfterSeconds: normalized.retryAfterSeconds } : {}),
      ...(normalized.details ? { details: normalized.details } : {}),
    };
    if (parsed?.json ?? args.includes("--json")) writeJsonFailure(io, command, requestId, shape);
    else io.stderr(`Error [${shape.code}]: ${shape.message}\n`);
    return { exitCode: normalized.exitCode, requestId };
  }
}
