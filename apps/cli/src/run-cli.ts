import { access, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { input } from "@inquirer/prompts";

import {
  AgentIntegrationError,
  isDetectionAvailable,
  toDetectionDocument,
  toInspectionDocument,
  type AgentInspection,
  type AgentIntegration,
  type ChangePlan,
  type DetectionResult,
  type DiagnosticCheck,
} from "@apexnova-connect/integration-sdk";
import { IntegrationChangeError } from "@apexnova-connect/core";
import {
  HubClientError,
  verifyHubInference,
  type HubCatalogDeployment,
  type HubCatalogSnapshot,
  type HubCatalogProtocol,
  type HubUsageRecord,
  type UsageQuery,
} from "@apexnova-connect/hub-client";
import {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_DEFINITIONS_DIGEST,
  CAPABILITY_SUITE_ID,
  CAPABILITY_SUITE_VERSION,
  FileEvidenceStore,
  REPLAY_CREDENTIAL,
  buildCompatibilityMatrix,
  buildRecording,
  computeVerdict,
  createEvidence,
  createRecordingFetch,
  createReplayFetch,
  isLegacyEvidenceId,
  parseRecording,
  renderCompatibilityMatrix,
  runCapabilitySuite,
  subjectIdentity,
  type CapabilityOutcomeDetail,
  type EvidenceSubject,
  type SubjectVerdict,
  type SuiteProtocol,
} from "@apexnova-connect/capabilities";
import { createRoutingAuditEntry, type RoutingAuditEntry } from "@apexnova-connect/routing";
import { startGateway, type ForwardedRequest, type GatewayCredential, type RunningGateway } from "@apexnova-connect/gateway";
import {
  CODING_GENERAL,
  recommend,
  recommendationRecord,
  scenario as scenarioProfile,
  type RecommendationCandidate,
  type RecommendationConstraints,
} from "@apexnova-connect/recommendation";
import { ConfigExecutionError, FileConfigExecutor } from "@apexnova-connect/config-engine";
import { CredentialStoreError, SecretValue } from "@apexnova-connect/credential-store";

import {
  agentOperand,
  compensationSignal,
  credentialStore,
  defaultIo,
  defaultSleep,
  hubConfigContext,
  currentPlatform,
  currentTime,
  hubService,
  integrationContext,
  integrationRegistry,
  localStateRoot,
  noOperands,
  operationSignal,
  resolveIntegration,
  resolvePicker,
  withRetry,
  CliError,
  EXIT_CODES,
  type CliDependencies,
  type CliErrorShape,
  type CliIo,
  type CliPickerItem,
  type CliRunResult,
  type ParsedArguments,
  inFlightSignal,
} from "./cli-core.js";
import {
  configureAgent,
  connectionIntent,
  detectForCommand,
  routingAuditLog,
  selectionInForce,
  selectDeploymentByReference,
  hubProtocolsFor,
  launchAgent,
  requireAvailable,
  resolveDeployment,
  runtimeCredentialForLaunch,
  runtimeCredentialIsDue,
  selectProtocol,
  toProtocolId,
} from "./agent-workflow.js";
import { RuntimeBindingStore, type RuntimeCredentialBinding } from "./runtime-binding-store.js";
import {
  hubConfigDefaults,
  hubConfigPath,
  readHubConfigFile,
  resolveHubConfig,
  writeHubConfigFile,
} from "./hub-config.js";
import { CLI_VERSION } from "./version.js";

const LIVE_VERIFY_ESTIMATE_USAGE = { inputTokens: 64, outputTokens: 256 } as const;

/**
 * How long to leave a failed mid-run renewal alone before trying again. Without
 * it a Hub that is down would be asked once per forwarded request, turning one
 * outage into a second one of our own making.
 */
const RENEWAL_RETRY_COOLDOWN_MS = 60_000;

// Five billable requests, sized from the probe bodies. Non-binding, like every
// estimate: the requestIds the run reports are what the real cost is read from.
const CAPABILITY_SUITE_ESTIMATE_USAGE = { inputTokens: 480, outputTokens: 800 } as const;

/** A local ceiling, because Hub has no per-request spending cap yet (M1-HUB-01). */
const CAPABILITY_SUITE_BUDGET = 0.05;

const HELP = `Apexnova-connect CLI

Usage:
  apexnova run <agent> [--deployment <id>] [--gateway] [--key <id>] [--rotating] [-- <agent args>]
  apexnova init [--hub-url <url>] [--client-id <id>] [--path-prefix <p>]
  apexnova login | logout | whoami | balance
  apexnova agents
  apexnova audit [agent] [--limit <n>]   Read the routing audit log
  apexnova models [--agent <id>] [--protocol <id>] [--compatible-only]
  apexnova usage [--request-id <id>] [--key <id>] [--from <iso>] [--to <iso>] [--granularity hour|day|month]
  apexnova connect <agent> (--deployment <id> | --best) (--dry-run | --yes)
  apexnova switch <agent> --deployment <id> (--dry-run | --yes)
  apexnova verify <agent> [--live] [--yes] | doctor [agent]
  apexnova restore [transaction-id] [--list] [--dry-run] [--yes] [--discard-local-changes]
  apexnova compatibility run <agent> --deployment <id> [--budget <amount>] [--yes]
  apexnova compatibility refresh [--within <days>] [--budget <amount>] [--yes]
  apexnova compatibility sync [--agent <id>] [--deployment <id>] [--yes]
  apexnova compatibility revoke <evidence-id> --reason <why> [--yes]
  apexnova compatibility replay <recording.json>
  apexnova compatibility explain [agent] [--deployment <id>] [--protocol <id>]
  apexnova compatibility matrix [--agent <id>] [--deployment <id>] [--protocol <id>]
  apexnova recommend <agent> [--scenario <id>] [--deployment <id>] [--max-price <per-1M>]
                             [--model-allowlist <ref,...>] [--exclude-publisher <name,...>]
  apexnova credential print <agent>
  apexnova detect [agent] [--config <path>]
  apexnova inspect <agent> [--config <path>]
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
  --best                 Connect to the top of the ranking, and record why
  --gateway              Route this run through a local gateway (default off)
  --budget <amount>      Local ceiling for a billable suite run (default 0.05)
  --record <path>        Write a replayable recording of a suite run
  --within <days>        Refresh evidence expiring within this many days (default 7)
  --credential-ttl <s>   Runtime credential lifetime, 120-86400 seconds (default 86400).
                         Implies a runtime credential; renewal fires in the last half
                         of its life, capped at an hour
  --reason <why>         Why an evidence record is being revoked (required)
  --scenario <id>        Scenario to rank for (default coding-general)
  --max-price <amount>   Blended price ceiling per million tokens for recommend
  --model-allowlist <refs>  Consider only these deployments (id, alias; comma-separated)
  --exclude-publisher <names>  Never recommend models from these publishers
  --request-id <id>      Reconcile one request by its Hub request ID
  --key <id>             Use an existing API key instead of creating one
  --rotating             Use a short-lived rotating credential (24h) instead of a permanent key
  --api-key-helper       Let the Agent fetch the credential itself, where it supports one
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

apexnova run <agent> is the one-command path: it auto-configures a permanent key,
writes that Agent's provider configuration, and launches it. Use --rotating for
short-lived credentials or --key <id> to bind an existing key for per-tool usage
tracking. Run "apexnova agents" to list the Agents this build supports.
`;

/**
 * Which options each command reads.
 *
 * A flag a command does not read is a flag that did nothing, and three times in
 * this milestone a switch was set, ignored, and reported success: `--max-price`
 * excluded nobody, `restore --yes` without an id printed a table, and
 * `run --gateway` went direct whenever a binding already existed. None was
 * caught by a test; each was found by someone running it and looking closely.
 *
 * Listing what a command reads turns that class into a usage error instead of a
 * silence. The cost is that adding an option means adding it here -- which is
 * the point: an option nobody wired up now fails loudly on its first use.
 */
const GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  "--profile", "--json", "--non-interactive", "--timeout", "--verbose", "--no-color", "--help", "--version",
]);

const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  init: ["--hub-url", "--client-id", "--path-prefix"],
  login: [],
  logout: ["--yes"],
  whoami: [],
  balance: [],
  agents: [],
  audit: ["--limit"],
  models: ["--agent", "--protocol", "--compatible-only"],
  usage: ["--request-id", "--key", "--from", "--to", "--granularity"],
  detect: ["--config"],
  inspect: ["--config"],
  doctor: ["--config"],
  connect: ["--deployment", "--protocol", "--best", "--scenario", "--max-price", "--model-allowlist", "--exclude-publisher", "--config", "--credential-ttl", "--dry-run", "--yes"],
  switch: ["--deployment", "--protocol", "--best", "--scenario", "--max-price", "--model-allowlist", "--exclude-publisher", "--config", "--credential-ttl", "--dry-run", "--yes"],
  verify: ["--live", "--config", "--yes"],
  restore: ["--list", "--dry-run", "--yes", "--discard-local-changes", "--config"],
  run: ["--deployment", "--gateway", "--key", "--rotating", "--credential-ttl", "--config"],
  opencode: ["--deployment", "--gateway", "--key", "--rotating", "--credential-ttl", "--config"],
  credential: ["--key", "--rotating", "--api-key-helper"],
  recommend: ["--scenario", "--deployment", "--max-price", "--model-allowlist", "--exclude-publisher"],
  compatibility: [
    "--agent", "--deployment", "--protocol", "--budget", "--record", "--within",
    "--reason", "--yes", "--force", "--config",
  ],
};

function assertOptionsAreRead(command: string, used: readonly string[]): void {
  const accepted = COMMAND_OPTIONS[command];
  if (accepted === undefined) return;
  const ignored = used.filter((option) => !GLOBAL_OPTIONS.has(option) && !accepted.includes(option));
  if (ignored.length === 0) return;
  throw new CliError({
    code: "INVALID_ARGUMENT",
    message: `${command} does not read ${ignored.join(", ")}. It would have been accepted and ignored, so it is refused instead.`,
    exitCode: EXIT_CODES.usage,
    details: { command, ignored, accepted: [...accepted] },
  });
}

/** A repeated-value flag taken as one comma-separated list, empties dropped. */
function splitList(value: string): readonly string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
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
  let budget: string | undefined;
  let recordPath: string | undefined;
  let withinDays: number | undefined;
  let credentialTtlSeconds: number | undefined;
  let reason: string | undefined;
  let requestIdFilter: string | undefined;
  let scenarioId: string | undefined;
  let best = false;
  let gateway = false;
  let discardLocalChanges = false;
  let limit: number | undefined;
  let modelAllowlist: readonly string[] | undefined;
  let excludePublishers: readonly string[] | undefined;
  let maxPrice: string | undefined;
  let dryRun = false;
  let list = false;
  let live = false;
  let apiKeyId: string | undefined;
  let rotating = false;
  let apiKeyHelper = false;
  let from: string | undefined;
  let to: string | undefined;
  let granularity: "hour" | "day" | "month" | undefined;
  let hubUrl: string | undefined;
  let clientId: string | undefined;
  let pathPrefix: string | undefined;
  let force = false;
  let optionsEnded = false;
  const used: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (optionsEnded || !arg.startsWith("--")) {
      operands.push(arg);
      continue;
    }
    if (arg !== "--") used.push(arg);
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
      case "--api-key-helper":
        apiKeyHelper = true;
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
      case "--within": {
        const value = valueAfter(args, index, arg);
        withinDays = Number(value);
        if (!Number.isSafeInteger(withinDays) || withinDays < 0 || withinDays > 365) {
          throw new CliError({
            code: "INVALID_ARGUMENT",
            message: "--within must be a whole number of days between 0 and 365.",
            exitCode: EXIT_CODES.usage,
          });
        }
        index += 1;
        break;
      }
      case "--credential-ttl": {
        const value = valueAfter(args, index, arg);
        credentialTtlSeconds = Number(value);
        // The floor is two minutes because the renewal window is half the
        // lifetime: below that the replacement is due almost as soon as it
        // arrives, and the run would spend itself minting credentials.
        if (!Number.isSafeInteger(credentialTtlSeconds) || credentialTtlSeconds < 120 || credentialTtlSeconds > 86_400) {
          throw new CliError({
            code: "INVALID_ARGUMENT",
            message: "--credential-ttl must be a whole number of seconds between 120 and 86400.",
            exitCode: EXIT_CODES.usage,
          });
        }
        index += 1;
        break;
      }
      case "--record":
        recordPath = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--reason":
        reason = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--request-id":
        requestIdFilter = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--discard-local-changes":
        discardLocalChanges = true;
        break;
      case "--gateway":
        gateway = true;
        break;
      case "--limit": {
        const raw = valueAfter(args, index, arg);
        const requested = Number(raw);
        if (!Number.isSafeInteger(requested) || requested <= 0) {
          throw new CliError({ code: "INVALID_ARGUMENT", message: "--limit takes a positive whole number.", exitCode: EXIT_CODES.usage });
        }
        limit = requested;
        index += 1;
        break;
      }
      case "--best":
        best = true;
        break;
      case "--model-allowlist":
        modelAllowlist = splitList(valueAfter(args, index, arg));
        index += 1;
        break;
      case "--exclude-publisher":
        excludePublishers = splitList(valueAfter(args, index, arg));
        index += 1;
        break;
      case "--scenario":
        scenarioId = valueAfter(args, index, arg);
        index += 1;
        break;
      case "--max-price": {
        maxPrice = valueAfter(args, index, arg);
        if (!/^[0-9]+(?:\.[0-9]+)?$/.test(maxPrice)) {
          throw new CliError({
            code: "INVALID_ARGUMENT",
            message: "--max-price must be a decimal blended price per million tokens, such as 2.5.",
            exitCode: EXIT_CODES.usage,
          });
        }
        index += 1;
        break;
      }
      case "--budget": {
        budget = valueAfter(args, index, arg);
        if (!/^[0-9]+(?:\.[0-9]+)?$/.test(budget)) {
          throw new CliError({
            code: "INVALID_ARGUMENT",
            message: "--budget must be a decimal amount, such as 0.05.",
            exitCode: EXIT_CODES.usage,
          });
        }
        index += 1;
        break;
      }
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
  if (command !== undefined && !help && !version) assertOptionsAreRead(command, used);
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
    ...(budget ? { budget } : {}),
    ...(recordPath ? { recordPath } : {}),
    ...(withinDays === undefined ? {} : { withinDays }),
    ...(credentialTtlSeconds === undefined ? {} : { credentialTtlSeconds }),
    ...(reason ? { reason } : {}),
    ...(requestIdFilter ? { requestId: requestIdFilter } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    best,
    gateway,
    discardLocalChanges,
    ...(limit === undefined ? {} : { limit }),
    ...(modelAllowlist ? { modelAllowlist } : {}),
    ...(excludePublishers ? { excludePublishers } : {}),
    ...(maxPrice ? { maxPrice } : {}),
    dryRun,
    list,
    live,
    ...(apiKeyId ? { apiKeyId } : {}),
    rotating,
    apiKeyHelper,
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
  // Hub drops a scope the account was never granted rather than refusing the
  // login, so a session can come back quietly narrower than it asked for. The
  // collector scopes are the live case: they are granted per account by a Hub
  // admin, and finding that out at the first submission is too late.
  const granted = new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean));
  const ungranted = (tokens.requestedScope ?? "").split(/\s+/).filter((scope) => scope && !granted.has(scope));
  return {
    data: {
      profile: parsed.profile,
      authenticated: true,
      tokenType: tokens.tokenType,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      ...(ungranted.length > 0 ? { ungrantedScopes: ungranted } : {}),
      accountId: tokens.accountId,
    },
    warnings: ungranted.length > 0
      ? [`Hub did not grant ${ungranted.join(", ")}. The session is otherwise valid; commands needing those scopes will fail until an administrator grants them to this account.`]
      : [] as readonly string[],
    human: [
      `Authenticated profile ${parsed.profile}${tokens.accountId ? ` as ${tokens.accountId}` : ""}.`,
      ...(ungranted.length > 0 ? [`Not granted: ${ungranted.join(", ")}`] : []),
    ].join("\n"),
  };
}

async function executeLogout(parsed: ParsedArguments, dependencies: CliDependencies) {
  noOperands(parsed);

  // Logging out is the one command that can make a restore impossible. A
  // restore asks Hub to reissue the connection it is rolling back to, so once
  // the session is gone the transaction can never be undone: the Agent keeps a
  // configuration pointing at Hub, and there is no longer an account to manage
  // it with. Refusing is the same rule `run --gateway` and `restore --yes`
  // ended up on -- a command must not walk the user into a state with no way
  // out and report success.
  if (!parsed.yes) {
    const restorable = (await (await backupExecutor(parsed, dependencies)).listBackups())
      .filter((item) => item.restorable);
    const bindings = new RuntimeBindingStore(credentialStore(dependencies));
    const connected: string[] = [];
    for (const integration of integrationRegistry(dependencies).list()) {
      const binding = await bindings.load(integration.manifest.id, parsed.profile).catch(() => null);
      if (binding) connected.push(integration.manifest.displayName);
    }
    if (restorable.length > 0 || connected.length > 0) {
      throw new CliError({
        code: "APPROVAL_REQUIRED",
        message: [
          restorable.length > 0
            ? `${restorable.length} transaction${restorable.length === 1 ? " is" : "s are"} still restorable (${restorable.map((item) => item.transactionId).join(", ")}); logging out makes ${restorable.length === 1 ? "it" : "them"} permanently unrestorable, because a restore needs this session to reissue the previous credential.`
            : "",
          connected.length > 0
            ? `${connected.join(", ")} ${connected.length === 1 ? "is" : "are"} still configured to reach Apexnova AI Hub and will keep a credential this session can no longer revoke.`
            : "",
          'Run "apexnova restore <transaction>" first, or re-run logout with --yes to leave it as it is.',
        ].filter((line) => line.length > 0).join(" "),
        exitCode: EXIT_CODES.permission,
        details: {
          restorable: restorable.map((item) => ({ transactionId: item.transactionId, integrationId: item.integrationId })),
          connected,
        },
      });
    }
  }

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
  const registry = integrationRegistry(dependencies);
  const filterIntegration = parsed.agent ? resolveIntegration(parsed.agent, dependencies) : undefined;
  const catalog = await hubService(parsed, dependencies).catalog(parsed.profile, operationSignal(parsed));
  const usable = filterIntegration
    ? hubProtocolsFor(filterIntegration)
    : new Set(registry.list().flatMap((integration) => [...hubProtocolsFor(integration)]));
  const modelsById = new Map(catalog.models.map((model) => [model.id, model]));
  const deployments = catalog.deployments
    .filter((deployment) => !parsed.protocol || deployment.protocols.some((protocol) => protocol.protocol === parsed.protocol))
    .filter((deployment) => !filterIntegration || deployment.protocols.some((protocol) => usable.has(protocol.protocol)))
    .filter((deployment) => !parsed.compatibleOnly || (deployment.availability.status === "available" && deployment.protocols.some((protocol) => usable.has(protocol.protocol))))
    .map((deployment) => ({
      ...deployment,
      model: modelsById.get(deployment.modelId),
      compatibility: filterIntegration
        ? (deployment.protocols.some((protocol) => usable.has(protocol.protocol)) ? "adapter-supported-unverified" : "unsupported")
        : "not-evaluated",
    }));
  const warnings = filterIntegration
    ? ["Adapter protocol support is not Agent compatibility evidence; H1 deployments remain unverified until compatibility testing is available."]
    : [];
  const human = deployments.length === 0
    ? "No matching deployments."
    : deployments.map((deployment) => `${deployment.id}  ${deployment.model?.name ?? deployment.modelId}  ${deployment.availability.status}  ${deployment.protocols.map((protocol) => protocol.protocol).join(",")}`).join("\n");
  const io = dependencies.io ?? defaultIo();
  const catalogEnvelope = {
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    generatedAt: catalog.generatedAt,
    expiresAt: catalog.expiresAt,
    // The snapshot's providers were parsed but never surfaced, and reading this
    // output as if it were the snapshot is what produced a wrong finding about
    // the catalog. Emit what was actually returned.
    providers: catalog.providers,
    deployments,
  };
  if (io.isInteractive && !parsed.nonInteractive && !parsed.json && deployments.length > 0) {
    // Switching needs one unambiguous target, so a multi-agent install has to
    // say which Agent the selected model is for.
    const registered = registry.list();
    const target = filterIntegration ?? (registered.length === 1 ? registered[0] : undefined);
    if (!target) {
      throw new CliError({
        code: "INVALID_ARGUMENT",
        message: "Pass --agent <id> to switch a model interactively when more than one Agent is registered.",
        exitCode: EXIT_CODES.usage,
        details: { supportedAgents: registry.agentIds },
      });
    }
    const picker = resolvePicker(dependencies);
    const items: CliPickerItem<HubCatalogDeployment>[] = deployments.map((deployment) => ({
      label: `${deployment.displayName} (${deployment.inferenceAlias})`,
      description: `${deployment.model?.name ?? deployment.modelId} · ${deployment.availability.status}`,
      value: deployment,
    }));
    const selected = await picker("Select a model to switch to (Esc to cancel):", items);
    const protocol = selectProtocol(selected, target);
    const result = await configureAgent(parsed, dependencies, target, selected, protocol, catalog);
    return {
      data: { ...catalogEnvelope, switchedTo: selected.id, agentId: target.manifest.id, credentialKind: result.binding.kind ?? "runtime" },
      warnings: [...warnings, ...result.warnings],
      human: `Switched to ${selected.displayName} (${selected.inferenceAlias}). Run "apexnova run ${target.manifest.id}" to use it.`,
    };
  }
  return { data: catalogEnvelope, warnings, human };
}

/**
 * The executor that owns this profile's backups. One construction, because
 * `logout` has to see the same transactions `restore` would act on -- a guard
 * reading a different set would be worse than no guard.
 */
async function backupExecutor(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
): Promise<FileConfigExecutor> {
  const registry = integrationRegistry(dependencies);
  const context = integrationContext(parsed, dependencies);
  const backupRoot = join(localStateRoot(dependencies), "backups");
  const candidates = [
    context.workingDirectory,
    ...registry.list().flatMap((integration) => integration.configRoots(context)),
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
  return new FileConfigExecutor({ allowedRoots, backupRoot });
}

async function executeRestore(parsed: ParsedArguments, dependencies: CliDependencies) {
  if (parsed.operands.length > 1) {
    throw new CliError({ code: "INVALID_ARGUMENT", message: "restore accepts at most one transaction ID.", exitCode: EXIT_CODES.usage });
  }
  const registry = integrationRegistry(dependencies);
  const executor = await backupExecutor(parsed, dependencies);
  const transactionId = parsed.operands[0];
  const backups = await executor.listBackups();
  if (transactionId === undefined && (parsed.yes || parsed.dryRun)) {
    // Listing was the fallback for a missing operand, so `restore --yes` printed
    // the transactions and exited 0 -- the user had asked to restore, approved
    // it, and got a table. The configuration stayed written and the runtime
    // credential stayed live while the exit code said it was done. A restore
    // names the transaction it undoes: the spec's ordering rule is explicit, and
    // picking one on the user's behalf could roll back an integration they
    // never mentioned.
    const restorable = backups.filter((item) => item.restorable);
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: restorable.length === 0
        ? "restore needs a transaction ID, and there is nothing restorable. Run \"apexnova restore --list\" to see what exists."
        : `restore needs a transaction ID; nothing was restored. Restorable now: ${restorable.map((item) => `${item.transactionId} (${item.integrationId})`).join(", ")}.`,
      exitCode: EXIT_CODES.usage,
      details: { restorable: restorable.map((item) => ({ transactionId: item.transactionId, integrationId: item.integrationId })) },
    });
  }
  if (parsed.list || transactionId === undefined) {
    return {
      data: { backups },
      warnings: [] as readonly string[],
      human: backups.length === 0
        ? "No restorable transactions."
        // The target path is on the line because restoring a transaction that
        // was applied with `--config` needs that same `--config`, and an id
        // alone does not say which.
        : backups.map((item) => [
            `${item.transactionId}  ${item.integrationId}  ${item.state}  ${item.appliedAt}${item.restorable ? "  restorable" : ""}`,
            ...item.targetPaths.map((path) => `    ${path}`),
          ].join("\n")).join("\n"),
    };
  }
  const summary = backups.find((item) => item.transactionId === transactionId);
  const receipt = await executor.getReceipt(transactionId);
  // The backup directory is what knows which transaction the files hold, so the
  // ordering comes from there. Checking it before --dry-run keeps the preview
  // honest, and before any credential work keeps a refusal free of side effects.
  if (summary && !summary.restorable) {
    const newest = backups.find((item) => item.integrationId === summary.integrationId && item.restorable);
    throw new CliError({
      code: "RESTORE_ORDER_CONFLICT",
      message: `Restore ${newest?.transactionId ?? "the newer transaction"} before restoring ${transactionId}.`,
      exitCode: EXIT_CODES.conflict,
      details: { integrationId: summary.integrationId, ...(newest ? { restoreFirst: newest.transactionId } : {}) },
    });
  }
  if (parsed.dryRun) {
    return {
      data: { dryRun: true, transactionId, planId: receipt.planId },
      warnings: ["Dry-run did not restore files."],
      human: `Transaction ${transactionId} can be restored. No files were changed.`,
    };
  }
  if (!parsed.yes) {
    throw new CliError({ code: "APPROVAL_REQUIRED", message: "restore requires --yes after reviewing the transaction or --dry-run.", exitCode: EXIT_CODES.permission });
  }

  const warnings: string[] = [];
  let runtimeCredentialRevoked: boolean | undefined;
  let runtimeCredentialRestored = false;
  // A backup written by an integration this build no longer loads can still be
  // rolled back; only its credential bookkeeping is skipped.
  const integration = summary && registry.has(summary.integrationId)
    ? registry.resolve(summary.integrationId)
    : undefined;
  const agentId = integration?.manifest.id;
  const bindings = agentId ? new RuntimeBindingStore(credentialStore(dependencies)) : undefined;
  const binding = bindings && agentId ? await bindings.load(agentId, parsed.profile) : null;
  // The binding only carries the credential chain. One that names a different
  // transaction -- an older build could leave that behind -- no longer blocks the
  // restore: the chain is dropped and the profile disconnects instead.
  const bindingOwnsTransaction = binding?.transactionId === transactionId;
  if (binding && !bindingOwnsTransaction && (binding.transactionId !== undefined || binding.restoreTarget !== undefined)) {
    warnings.push(`The stored runtime credential does not belong to ${transactionId}; it was revoked and the profile disconnected. Run "apexnova connect ${agentId}" to reconnect.`);
  }

  let replacement: typeof binding = null;
  if (binding?.restoreTarget && integration && bindingOwnsTransaction) {
    const service = hubService(parsed, dependencies);
    const target = binding.restoreTarget;
    const catalog = await service.catalog(parsed.profile, operationSignal(parsed));
    const deployment = catalog.deployments.find((item) => item.id === target.deploymentId);
    const protocol = deployment?.protocols.find((item) => item.protocol === target.protocol);
    if (!deployment || !protocol || (deployment.availability.status !== "available" && deployment.availability.status !== "degraded")) {
      throw new CliError({ code: "BINDING_MISMATCH", message: "The previous runtime target is no longer available; configuration was not restored.", exitCode: EXIT_CODES.verification });
    }
    const created = await service.createRuntimeCredential(parsed.profile, {
      name: `${integration.manifest.displayName} (${parsed.profile})`,
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
    await executor.rollback(receipt, parsed.discardLocalChanges ? { discardChangedTargets: true } : undefined);
  } catch (cause) {
    if (replacement) await hubService(parsed, dependencies).revokeRuntimeCredential(parsed.profile, replacement.credentialId, compensationSignal(parsed)).catch(() => {});
    throw cause;
  }
  if (binding && bindings && agentId) {
    if (replacement) {
      try {
        await bindings.save(agentId, parsed.profile, replacement);
        runtimeCredentialRestored = true;
      } catch (cause) {
        await hubService(parsed, dependencies).revokeRuntimeCredential(parsed.profile, replacement.credentialId, compensationSignal(parsed)).catch(() => {});
        await hubService(parsed, dependencies).revokeRuntimeCredential(parsed.profile, binding.credentialId, compensationSignal(parsed)).catch(() => {});
        await bindings.delete(agentId, parsed.profile).catch(() => {});
        throw new CliError({ code: "RESTORE_BINDING_INCOMPLETE", message: "Configuration was restored, but the replacement runtime credential could not be saved; the profile was disconnected.", exitCode: EXIT_CODES.recovery, cause });
      }
    }
    try {
      await hubService(parsed, dependencies).revokeRuntimeCredential(parsed.profile, binding.credentialId, compensationSignal(parsed));
      runtimeCredentialRevoked = true;
    } catch (cause) {
      // Revocation is idempotent: a credential Hub no longer has is revoked,
      // whoever did it. Reporting that as a failure sent the user to revoke
      // something that was already gone -- observed twice on 2026-09-11, both
      // times with the credential absent from the account afterwards -- and made
      // a real failure indistinguishable from a redundant one.
      if (cause instanceof HubClientError && cause.code === "NOT_FOUND") {
        runtimeCredentialRevoked = true;
      } else {
        runtimeCredentialRevoked = false;
        warnings.push(`Runtime credential ${binding.credentialId} could not be revoked from Hub; revoke the device or credential manually.`);
      }
    }
    if (!replacement) await bindings.delete(agentId, parsed.profile);
  }
  // A restore changes the connection target, which is what this milestone
  // defined a route to be, so it belongs in the log. Without it the log shows a
  // switch to B and then, with no entry between, requests billed against A.
  if (agentId !== undefined) {
    try {
      const restoredTarget = replacement ?? undefined;
      await routingAuditLog(dependencies).append(
        createRoutingAuditEntry(
          restoredTarget
            ? {
                event: "selected",
                agentId,
                ...(integration ? { integrationId: integration.manifest.id } : {}),
                profile: parsed.profile,
                command: "restore",
                deploymentId: restoredTarget.deploymentId,
                protocol: restoredTarget.protocol,
                grounds: "restore",
                credentialId: restoredTarget.credentialId,
                transactionId,
                recordedAt: new Date(currentTime(dependencies)).toISOString(),
              }
            : {
                // Undoing the first connect leaves no target at all. Recording
                // that as a selection of nothing would be a record of something
                // that did not happen.
                event: "released",
                agentId,
                ...(integration ? { integrationId: integration.manifest.id } : {}),
                profile: parsed.profile,
                command: "restore",
                transactionId,
                recordedAt: new Date(currentTime(dependencies)).toISOString(),
              },
        ),
      );
    } catch {
      warnings.push("The configuration was restored but the change was not written to the audit log.");
    }
  }

  return {
    data: { restored: true, transactionId, planId: receipt.planId, runtimeCredentialRestored, ...(runtimeCredentialRevoked === undefined ? {} : { runtimeCredentialRevoked }) },
    warnings,
    // The credential ID only ever reached `warnings`, and human mode prints
    // `human` alone -- so the one instruction the user was given ("revoke it
    // yourself") came without the thing to revoke.
    human: `Restored transaction ${transactionId}.${parsed.discardLocalChanges ? ` Changes made since it was applied were copied into ${join(localStateRoot(dependencies), "backups", "discarded")} before restoring.` : ""}${runtimeCredentialRestored ? " Previous runtime connection was reissued." : ""}${runtimeCredentialRevoked === false ? ` Runtime credential ${binding?.credentialId ?? "(id unknown)"} could not be revoked from Hub; revoke it there.` : ""}`,
  };
}

function evidenceStore(dependencies: CliDependencies): FileEvidenceStore {
  return new FileEvidenceStore({ root: join(localStateRoot(dependencies), "evidence") });
}

function platformTag(dependencies: CliDependencies): string {
  return `${currentPlatform(dependencies) ?? dependencies.platform ?? process.platform}-${process.arch}`;
}

/** A probe failure must not stop the command: it only costs the version note. */
/**
 * Why a version is or is not in hand. `catch { return undefined }` used to
 * collapse five different situations into one, and the sentence built from it
 * said "not installed here, or its version could not be read" -- with the
 * reader left to guess which. They are not the same problem: an absent product
 * has to be installed, a version probe that failed has to be retried, and a
 * product outside the supported range must not be worked around at all.
 */
type AgentVersionLookup =
  | { readonly status: "known"; readonly version: string }
  | { readonly status: "not-found" }
  | { readonly status: "unsupported"; readonly reason: string }
  | { readonly status: "no-version"; readonly detail: string }
  | { readonly status: "detection-failed"; readonly cause: string };

async function installedVersionOf(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
): Promise<AgentVersionLookup> {
  let detection: DetectionResult;
  try {
    detection = await detectForCommand(parsed, dependencies, integration);
  } catch (error) {
    return {
      status: "detection-failed",
      cause: error instanceof Error ? error.message : "the detection probe failed",
    };
  }
  if (detection.status === "not-found") return { status: "not-found" };
  if (detection.status === "unsupported") {
    return { status: "unsupported", reason: detection.unsupportedReason };
  }
  if (detection.productVersion !== undefined) {
    return { status: "known", version: detection.productVersion };
  }
  // Found, but nothing answered the version probe. `detect` already says so in
  // its warnings, so the reason is carried rather than restated.
  const detail = detection.status === "config-only"
    ? "only a configuration file was found, so there is no executable to read a version from"
    : detection.warnings[0] ?? "the version probe returned nothing";
  return { status: "no-version", detail };
}

function knownVersion(lookup: AgentVersionLookup): string | undefined {
  return lookup.status === "known" ? lookup.version : undefined;
}

/** One sentence naming which of the four it was, for whoever has to act on it. */
function versionUnavailableReason(lookup: AgentVersionLookup, displayName: string): string {
  // The pieces this quotes come from a detection warning or an error message,
  // and those usually end in a full stop of their own.
  const trimmed = (text: string): string => text.replace(/\s*\.\s*$/, "");
  switch (lookup.status) {
    case "known":
      return "";
    case "not-found":
      return `${displayName} was not found in the current environment.`;
    case "unsupported":
      return `${displayName} is outside the version range this integration supports: ${trimmed(lookup.reason)}.`;
    case "no-version":
      return `${displayName} is present but its version could not be read: ${trimmed(lookup.detail)}. That is not the same as it being absent.`;
    case "detection-failed":
      return `Detecting ${displayName} failed: ${trimmed(lookup.cause)}. The product may well be installed; this says the probe did not finish.`;
  }
}

function suiteProtocol(hubProtocol: string): SuiteProtocol | undefined {
  if (hubProtocol === "openai-responses") return "openai-responses";
  if (hubProtocol === "anthropic-messages") return "anthropic-messages";
  // The catalog spells this one `openai-chat`; manifests and the schema
  // vocabulary spell it `openai-chat-completions`. Both are accepted here, and
  // the caller still records the catalog's own spelling so a subject cannot
  // split in two.
  if (hubProtocol === "openai-chat" || hubProtocol === "openai-chat-completions") return "openai-chat-completions";
  return undefined;
}

interface CollectionTarget {
  readonly integration: AgentIntegration;
  readonly agentVersion: string;
  readonly deployment: HubCatalogDeployment;
  readonly hubProtocol: HubCatalogProtocol;
  readonly protocol: SuiteProtocol;
  readonly protocolId: string;
  readonly currency: string;
}

/**
 * Hub stamps an edge failure (nginx, ahead of the data plane) with this prefix
 * and `source: "edge"`. Such an ID is not a ledger key and cannot be looked up.
 */
const EDGE_REQUEST_ID_PREFIX = "edge_";

interface CollectionResult {
  readonly evidenceId: string;
  readonly subject: EvidenceSubject;
  readonly verdict: SubjectVerdict;
  readonly outcomes: readonly CapabilityOutcomeDetail[];
  readonly billedAmount: string;
  readonly currency: string;
  readonly settled: number;
  /** Every request ID the suite saw, edge failures included. */
  readonly requestIds: readonly string[];
  readonly unsettled: readonly string[];
  /** Known to Hub and deliberately free, which is not the same as unsettled. */
  readonly notBillable: readonly string[];
  /** Hub gave up settling these; they will never turn into a cost. */
  readonly unsettleable: readonly string[];
  /** Rejected before the data plane, so never in the ledger. */
  readonly edgeIds: readonly string[];
  /** Refused before authentication, so Hub never opened a ledger row. */
  readonly preAuthIds: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Mints a credential scoped to the one deployment under test, runs the suite,
 * revokes the credential whatever happened, reconciles what Hub billed and
 * stores the record. Shared by `run` and `refresh` so a re-collection is the
 * same measurement as the first one, not a second implementation of it.
 */
async function collectEvidence(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  target: CollectionTarget,
): Promise<CollectionResult> {
  const { integration, agentVersion, deployment, hubProtocol, protocol, protocolId } = target;
  const service = hubService(parsed, dependencies);
  const signal = operationSignal(parsed);
  const environment = dependencies.environment ?? process.env;
  const created = await service.createRuntimeCredential(parsed.profile, {
    name: `${integration.manifest.displayName} capability suite (${parsed.profile})`,
    protocols: [hubProtocol.protocol],
    publicDeploymentIds: [deployment.id],
    expiresIn: 86_400,
  }, signal);

  const recorder = parsed.recordPath === undefined
    ? undefined
    : createRecordingFetch({ credential: created.secret.reveal() });

  let suiteResult;
  try {
    suiteResult = await (dependencies.runCapabilitySuite ?? runCapabilitySuite)({
      endpoint: hubProtocol.baseUrl,
      protocol,
      model: deployment.inferenceAlias,
      deploymentId: deployment.id,
      credential: created.secret,
      requestTimeoutMs: parsed.timeoutSeconds * 1_000,
      allowInsecureLoopback: environment.APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK === "1",
      signal,
      ...(recorder ? { fetch: recorder.fetch } : {}),
    });
  } finally {
    // The credential exists only for this run, whatever the run found.
    await service
      .revokeRuntimeCredential(parsed.profile, created.credentialId, compensationSignal(parsed))
      .catch(() => {});
  }

  const warnings: string[] = [];
  const attributed = [...new Set(suiteResult.requestIds)];
  // An edge failure carries `source: "edge"` and an `edge_` prefixed ID that
  // never reaches the billing ledger -- Hub says so outright, so asking for it
  // would spend three attempts to learn what we already know.
  const edgeIds = attributed.filter((id) => id.startsWith(EDGE_REQUEST_ID_PREFIX));
  // A probe refused before authentication is answered with a request ID but
  // never written to the ledger: there is no account to bill. Asking for it
  // would leave every run reporting one request as permanently unsettled.
  const preAuthIds = attributed.filter(
    (id) => !id.startsWith(EDGE_REQUEST_ID_PREFIX) && suiteResult.preAuthRequestIds.includes(id),
  );
  const requestIds = attributed.filter(
    (id) => !id.startsWith(EDGE_REQUEST_ID_PREFIX) && !suiteResult.preAuthRequestIds.includes(id),
  );
  let billed = 0;
  let currency = target.currency;
  const notBillable: string[] = [];
  const unsettleable: string[] = [];
  let pending = [...requestIds];
  // Hub settles a request a beat after it answers, so the first pass usually
  // misses some. Reporting an unsettled request as costing nothing would be the
  // local number presented as the real one, which is what M1 established must
  // never happen -- so wait a little, then say plainly what is still open.
  // `settlementStatus` now separates the three things an empty answer used to
  // mean, and only `pending` is worth asking about again.
  for (let attempt = 0; attempt < 3 && pending.length > 0; attempt += 1) {
    if (attempt > 0) await (dependencies.sleep ?? defaultSleep)(5_000, signal);
    const stillOpen: string[] = [];
    for (const requestId of pending) {
      try {
        const usage = await service.usage(parsed.profile, requestId, signal);
        // A request Hub has never heard of is indistinguishable from one it has
        // not written yet, so both stay pending. An older Hub that answers
        // without a status is read from the amount, as before.
        const status = usage === undefined
          ? "pending"
          : usage.settlementStatus ?? (usage.amount === undefined ? "pending" : "settled");
        if (status === "settled" && usage?.amount !== undefined) {
          billed += Number(usage.amount);
          currency = usage.currency;
        } else if (status === "not-billable") {
          notBillable.push(requestId);
        } else if (status === "failed") {
          unsettleable.push(requestId);
        } else {
          stillOpen.push(requestId);
        }
      } catch {
        stillOpen.push(requestId);
      }
    }
    pending = stillOpen;
  }
  const unsettled = pending;
  const settled = requestIds.length - unsettled.length - notBillable.length - unsettleable.length;
  if (unsettled.length > 0) {
    warnings.push(
      `Hub has not settled ${unsettled.length} of ${requestIds.length} requests yet; the billed figure covers ${settled} of them. Reconcile the rest with "apexnova usage --from".`,
    );
  }
  if (unsettleable.length > 0) {
    warnings.push(
      `Hub reported settlement as failed for ${unsettleable.length} of ${requestIds.length} requests (${unsettleable.join(", ")}); the billed figure does not include them and they will not settle later.`,
    );
  }
  if (edgeIds.length > 0) {
    warnings.push(
      `${edgeIds.length} requests failed at the edge (${edgeIds.join(", ")}); those IDs are not in the billing ledger and cannot be reconciled.`,
    );
  }


  if (recorder && parsed.recordPath !== undefined) {
    const recording = buildRecording({
      endpoint: hubProtocol.baseUrl,
      protocol,
      model: deployment.inferenceAlias,
      deploymentId: deployment.id,
      recordedAt: new Date(currentTime(dependencies)).toISOString(),
      interactions: recorder.interactions(),
    });
    await writeFile(parsed.recordPath, `${JSON.stringify(recording, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  const supported = suiteResult.outcomes.filter((outcome) => outcome.support === "supported").length;
  const billedAmount = billed.toFixed(6);
  const subject: EvidenceSubject = {
    agentId: integration.manifest.id,
    agentVersion,
    integrationId: integration.manifest.id,
    integrationVersion: integration.manifest.version,
    deploymentId: deployment.id,
    // The catalog's own value, verbatim: one protocol under two spellings would
    // split a subject in two and the evidence would never accumulate.
    protocol: protocolId,
    platform: platformTag(dependencies),
    ...(deployment.implementationFingerprint === undefined
      ? {}
      : { implementationFingerprint: deployment.implementationFingerprint }),
  };
  const evidence = createEvidence({
    sourceType: "maintainer-test",
    subject,
    observedAt: new Date(currentTime(dependencies)).toISOString(),
    testSuite: {
      id: suiteResult.suite.id,
      version: suiteResult.suite.version,
      environment: `${platformTag(dependencies)} node ${process.version}`,
    },
    outcomes: suiteResult.outcomes.map((outcome) => ({
      capabilityId: outcome.capabilityId,
      support: outcome.support,
      value: outcome.detail,
    })),
    summary: truncateSummary(
      [
        `${supported}/${suiteResult.outcomes.length} supported`,
        `billed ${billedAmount} ${currency} over ${settled} settled of ${attributed.length} attributed requests`,
        ...(notBillable.length === 0 ? [] : [`${notBillable.length} not billable`]),
        ...(unsettleable.length === 0 ? [] : [`${unsettleable.length} failed to settle`]),
        ...(edgeIds.length === 0 ? [] : [`${edgeIds.length} failed at the edge`]),
        ...(preAuthIds.length === 0 ? [] : [`${preAuthIds.length} refused before authentication`]),
        `requests ${attributed.join(" ")}`,
      ].join("; "),
    ),
  });

  const store = evidenceStore(dependencies);
  const stored = await store.append(evidence);
  const verdict = computeVerdict({
    subject,
    evidence: await store.list({ agentId: subject.agentId }),
    now: new Date(currentTime(dependencies)),
  });


  return {
    evidenceId: stored.evidence.id,
    subject,
    verdict: verdict.verdict,
    outcomes: suiteResult.outcomes,
    billedAmount,
    currency,
    settled,
    requestIds: attributed,
    unsettled,
    notBillable,
    unsettleable,
    edgeIds,
    preAuthIds,
    warnings,
  };
}

/**
 * Runs the capability suite against one deployment and writes what it found.
 *
 * This is the billable half of M3: it mints a runtime credential scoped to the
 * one deployment under test, sends the probes, revokes the credential, and
 * reconciles every request it made against Hub usage. Nothing is sent before
 * the estimate has been shown and approved, and a local ceiling refuses a run
 * that would cost more than expected -- Hub has no per-request cap yet.
 */
async function executeCompatibilityRun(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  operands: readonly string[],
) {
  const agentId = operands[0];
  if (agentId === undefined || operands.length !== 1) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "compatibility run requires exactly one agent.",
      exitCode: EXIT_CODES.usage,
    });
  }
  const integration = resolveIntegration(agentId, dependencies);
  const detection = requireAvailable(
    await detectForCommand(parsed, dependencies, integration),
    integration,
  );
  const agentVersion = "productVersion" in detection ? detection.productVersion : undefined;
  if (agentVersion === undefined) {
    throw new CliError({
      code: "AGENT_VERSION_UNKNOWN",
      message: `The installed ${integration.manifest.displayName} version could not be determined; evidence has to name the version it was collected against.`,
      exitCode: EXIT_CODES.unavailable,
    });
  }

  const service = hubService(parsed, dependencies);
  const signal = operationSignal(parsed);
  const catalog = await service.catalog(parsed.profile, signal);
  const deployment = await resolveDeployment(parsed, dependencies, integration, catalog);
  const hubProtocol = selectProtocol(deployment, integration, parsed.protocol);
  const protocol = suiteProtocol(hubProtocol.protocol);
  // toProtocolId only checks that this is a protocol the contracts know; the
  // value recorded is the catalog's own, so a subject cannot split in two.
  const protocolId = toProtocolId(hubProtocol.protocol) === undefined ? undefined : hubProtocol.protocol;
  if (protocol === undefined || protocolId === undefined) {
    throw new CliError({
      code: "PROTOCOL_NOT_SUPPORTED",
      message: `The capability suite covers openai-responses, anthropic-messages and openai-chat; ${hubProtocol.protocol} is not in it.`,
      exitCode: EXIT_CODES.unavailable,
    });
  }

  const estimate = await service.estimatePricing(
    parsed.profile,
    deployment.id,
    CAPABILITY_SUITE_ESTIMATE_USAGE,
    signal,
  );
  const ceiling = parsed.budget === undefined ? CAPABILITY_SUITE_BUDGET : Number(parsed.budget);
  if (Number(estimate.amount) > ceiling) {
    throw new CliError({
      code: "BUDGET_EXCEEDED",
      message: `Hub estimates ${estimate.amount} ${estimate.currency} for the suite, above the ${ceiling} ceiling. Raise it with --budget if that is intended.`,
      exitCode: EXIT_CODES.billing,
      details: { estimate, estimateAssumptions: CAPABILITY_SUITE_ESTIMATE_USAGE, ceiling },
    });
  }
  if (!parsed.yes) {
    throw new CliError({
      code: "APPROVAL_REQUIRED",
      message: `The suite sends eight requests to ${deployment.id} over ${hubProtocol.protocol}, six of them billable. Hub estimates ${estimate.amount} ${estimate.currency}, which is not a spending cap. Re-run with --yes to approve.`,
      exitCode: EXIT_CODES.permission,
      details: {
        estimate,
        estimateAssumptions: CAPABILITY_SUITE_ESTIMATE_USAGE,
        deploymentId: deployment.id,
        protocol: hubProtocol.protocol,
        capabilities: CAPABILITY_DEFINITIONS.map((definition) => definition.id),
      },
    });
  }

  const collected = await collectEvidence(parsed, dependencies, {
    integration,
    agentVersion,
    deployment,
    hubProtocol,
    protocol,
    protocolId,
    currency: estimate.currency,
  });
  const { billedAmount, currency, settled, requestIds, unsettled, notBillable, unsettleable, edgeIds, preAuthIds, warnings } = collected;

  return {
    data: {
      evidenceId: collected.evidenceId,
      subject: collected.subject,
      verdict: collected.verdict,
      outcomes: collected.outcomes,
      estimate,
      estimateAssumptions: CAPABILITY_SUITE_ESTIMATE_USAGE,
      billed: {
        amount: billedAmount,
        currency,
        settledRequests: settled,
        attributedRequests: requestIds.length,
        ...(notBillable.length > 0 ? { notBillableRequests: notBillable.length } : {}),
        ...(unsettleable.length > 0 ? { failedToSettleRequests: unsettleable.length } : {}),
        ...(edgeIds.length > 0 ? { edgeRequests: edgeIds.length } : {}),
        ...(preAuthIds.length > 0 ? { preAuthRequests: preAuthIds.length } : {}),
      },
      requestIds,
      ...(unsettled.length > 0 ? { unsettledRequestIds: unsettled } : {}),
      ...(notBillable.length > 0 ? { notBillableRequestIds: notBillable } : {}),
      ...(unsettleable.length > 0 ? { failedToSettleRequestIds: unsettleable } : {}),
      ...(edgeIds.length > 0 ? { edgeRequestIds: edgeIds } : {}),
    },
    warnings,
    human: [
      `${integration.manifest.displayName} ${agentVersion} · ${deployment.id} · ${hubProtocol.protocol}: ${collected.verdict}`,
      ...collected.outcomes.map(
        (outcome) =>
          `  ${outcome.capabilityId.padEnd(26)} ${outcome.support.padEnd(11)} ${outcome.detail}`,
      ),
      `Billed: ${billedAmount} ${currency} over ${settled} of ${requestIds.length} attributed requests (non-binding estimate was ${estimate.amount} ${estimate.currency})`,
      ...(unsettled.length > 0
        ? [`Not settled yet: ${unsettled.join(", ")} — reconcile with "apexnova usage --from"`]
        : []),
      ...(notBillable.length > 0 ? [`Not billable: ${notBillable.join(", ")}`] : []),
      ...(unsettleable.length > 0 ? [`Settlement failed: ${unsettleable.join(", ")}`] : []),
      ...(edgeIds.length > 0 ? [`Failed at the edge, not in the ledger: ${edgeIds.join(", ")}`] : []),
      ...(preAuthIds.length > 0 ? [`Refused before authentication, never in the ledger: ${preAuthIds.join(", ")}`] : []),
      `Requests: ${requestIds.join(", ")}`,
      `Evidence: ${collected.evidenceId}`,
    ].join("\n"),
  };
}

/** The schema caps a summary at 1200 characters; a long request list must not lose the record. */
function truncateSummary(summary: string): string {
  return summary.length <= 1_200 ? summary : `${summary.slice(0, 1_199)}…`;
}

interface RefreshCandidate {
  readonly subject: EvidenceSubject;
  readonly dueAt?: string;
  /** The newest observation behind the row, to compare against the catalog. */
  readonly observedAt?: string;
  readonly expired: boolean;
  /** Due because a statement has expired or is about to. */
  readonly ttlDue: boolean;
}

/**
 * Says whether the deployment is no longer the one that was tested. Two things
 * can say so, and Hub warned about both: the fingerprint differs, or the
 * catalog reports a change after the observation -- an implementation that
 * reverts to an earlier one carries the earlier fingerprint again but a newer
 * `implementationChangedAt`. A record collected before the catalog had
 * fingerprints has none of its own, which is not evidence of a change, so only
 * the timestamp can speak for it.
 */
function implementationChange(
  candidate: RefreshCandidate,
  deployment: HubCatalogDeployment,
): string | undefined {
  const collected = candidate.subject.implementationFingerprint;
  const current = deployment.implementationFingerprint;
  if (collected !== undefined && current !== undefined && collected !== current) {
    return `the implementation changed from ${collected.slice(0, 12)} to ${current.slice(0, 12)}`;
  }
  const changedAt = deployment.implementationChangedAt;
  if (changedAt !== undefined && candidate.observedAt !== undefined && Date.parse(changedAt) > Date.parse(candidate.observedAt)) {
    return `the deployment changed its implementation on ${changedAt}, after this was collected`;
  }
  return undefined;
}

function refreshReason(entry: RefreshPlanEntry): string {
  if (entry.implementationChanged !== undefined) return entry.implementationChanged;
  return entry.expired ? "expired" : `expires ${entry.dueAt}`;
}

interface RefreshPlanEntry {
  readonly subject: EvidenceSubject;
  readonly dueAt?: string;
  readonly expired: boolean;
  /** Why the implementation no longer matches what was tested, when it does not. */
  readonly implementationChanged?: string;
  readonly target?: CollectionTarget;
  readonly estimate?: string;
  readonly skipped?: string;
  /** The installed Agent differs, so a re-collection lands on a new subject. */
  readonly installedVersion?: string;
}

const DEFAULT_REFRESH_WINDOW_DAYS = 7;

/**
 * Re-collects what has aged out. Evidence expires on purpose -- a 30-day tool
 * or streaming result stops standing for the present -- so something has to say
 * which subjects need running again and what that will cost, rather than
 * leaving a matrix to quietly decay into `unknown`.
 *
 * Nothing is sent before the plan and its estimate are approved, and a subject
 * that cannot be re-collected (Agent gone, deployment withdrawn, protocol no
 * longer offered) is reported as skipped with the reason instead of silently
 * dropping off the list.
 */
async function executeCompatibilityRefresh(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  operands: readonly string[],
) {
  if (operands.length > 0) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "compatibility refresh takes no operands; filter with --agent, --deployment or --protocol.",
      exitCode: EXIT_CODES.usage,
    });
  }

  const now = new Date(currentTime(dependencies));
  const withinDays = parsed.withinDays ?? DEFAULT_REFRESH_WINDOW_DAYS;
  const horizon = new Date(now.getTime() + withinDays * 86_400_000);
  const store = evidenceStore(dependencies);
  const evidence = await store.list({
    ...(parsed.agent === undefined ? {} : { agentId: parsed.agent }),
    ...(parsed.deployment === undefined ? {} : { deploymentId: parsed.deployment }),
    ...(parsed.protocol === undefined ? {} : { protocol: parsed.protocol }),
  });

  const tracked: RefreshCandidate[] = [];
  for (const row of buildCompatibilityMatrix({ evidence, now }).rows) {
    const expiries = row.capabilities
      .map((capability) => capability.expiresAt)
      .filter((at): at is string => at !== undefined)
      .sort();
    const dueAt = expiries[0];
    tracked.push({
      subject: row.subject,
      ...(dueAt === undefined ? {} : { dueAt }),
      ...(row.observedAt === undefined ? {} : { observedAt: row.observedAt }),
      expired: row.stale,
      ttlDue: row.stale || (dueAt !== undefined && Date.parse(dueAt) <= horizon.getTime()),
    });
  }

  if (tracked.length === 0) {
    return {
      data: { generatedAt: now.toISOString(), withinDays, due: [], refreshed: [] },
      warnings: [] as readonly string[],
      human: "No compatibility evidence has been collected yet.",
    };
  }

  const service = hubService(parsed, dependencies);
  const signal = operationSignal(parsed);
  const catalog = await service.catalog(parsed.profile, signal);
  const registry = integrationRegistry(dependencies);
  const estimates = new Map<string, { readonly amount: string; readonly currency: string }>();
  const plan: RefreshPlanEntry[] = [];

  for (const candidate of tracked) {
    const deployment = catalog.deployments.find((item) => item.id === candidate.subject.deploymentId);
    // Evidence also stops standing when the thing it tested changed underneath
    // it -- 12A.3, and the reason the fingerprint was worth putting in the
    // subject at all. TTL is only the other half.
    const changed = deployment === undefined ? undefined : implementationChange(candidate, deployment);
    if (!candidate.ttlDue && changed === undefined) continue;
    const base = {
      subject: candidate.subject,
      ...(candidate.dueAt === undefined ? {} : { dueAt: candidate.dueAt }),
      expired: candidate.expired,
      ...(changed === undefined ? {} : { implementationChanged: changed }),
    };
    if (!registry.has(candidate.subject.agentId)) {
      plan.push({ ...base, skipped: "this build does not load that Agent's integration" });
      continue;
    }
    const integration = registry.resolve(candidate.subject.agentId);
    const lookup = await installedVersionOf(parsed, dependencies, integration);
    const agentVersion = knownVersion(lookup);
    if (agentVersion === undefined) {
      // A record that should be re-collected is being skipped, so the reason has
      // to say whether the fix is to install something or to try again.
      plan.push({ ...base, skipped: versionUnavailableReason(lookup, integration.manifest.displayName) });
      continue;
    }
    if (!deployment) {
      plan.push({ ...base, skipped: "the deployment is no longer in the visible catalog" });
      continue;
    }
    if (deployment.availability.status !== "available" && deployment.availability.status !== "degraded") {
      plan.push({ ...base, skipped: `the deployment is ${deployment.availability.status}` });
      continue;
    }
    // Match the catalog value first; records collected before that was pinned
    // may carry the normalized spelling instead.
    const hubProtocol =
      deployment.protocols.find((item) => item.protocol === candidate.subject.protocol) ??
      deployment.protocols.find((item) => toProtocolId(item.protocol) === candidate.subject.protocol);
    const protocol = hubProtocol ? suiteProtocol(hubProtocol.protocol) : undefined;
    const protocolId = hubProtocol && toProtocolId(hubProtocol.protocol) !== undefined
      ? hubProtocol.protocol
      : undefined;
    if (!hubProtocol || protocol === undefined || protocolId === undefined) {
      plan.push({ ...base, skipped: `the deployment no longer offers ${candidate.subject.protocol}` });
      continue;
    }

    let estimate = estimates.get(deployment.id);
    if (estimate === undefined) {
      const priced = await service.estimatePricing(
        parsed.profile,
        deployment.id,
        CAPABILITY_SUITE_ESTIMATE_USAGE,
        signal,
      );
      estimate = { amount: priced.amount, currency: priced.currency };
      estimates.set(deployment.id, estimate);
    }

    plan.push({
      ...base,
      estimate: estimate.amount,
      target: {
        integration,
        agentVersion,
        deployment,
        hubProtocol,
        protocol,
        protocolId,
        currency: estimate.currency,
      },
      ...(agentVersion === candidate.subject.agentVersion ? {} : { installedVersion: agentVersion }),
    });
  }

  const ready = plan.filter((entry) => entry.target !== undefined);
  const skipped = plan.filter((entry) => entry.skipped !== undefined);
  const total = ready.reduce((sum, entry) => sum + Number(entry.estimate ?? 0), 0);
  const totalAmount = total.toFixed(6);
  const estimateCurrency = [...estimates.values()][0]?.currency ?? "USD";
  const ceiling = parsed.budget === undefined ? CAPABILITY_SUITE_BUDGET : Number(parsed.budget);

  const planLines = [
    ...ready.map(
      (entry) =>
        `  ${entry.subject.agentId} ${entry.subject.agentVersion} · ${entry.subject.deploymentId} · ${entry.subject.protocol}: ${refreshReason(entry)}, estimate ${entry.estimate}${entry.installedVersion === undefined ? "" : ` (will be collected for the installed ${entry.installedVersion})`}`,
    ),
    ...skipped.map(
      (entry) =>
        `  ${entry.subject.agentId} ${entry.subject.agentVersion} · ${entry.subject.deploymentId} · ${entry.subject.protocol}: ${refreshReason(entry)}, skipped, ${entry.skipped}`,
    ),
  ];

  if (plan.length === 0) {
    return {
      data: { generatedAt: now.toISOString(), withinDays, due: [], refreshed: [] },
      warnings: [] as readonly string[],
      human: `No evidence expires within ${withinDays} days. No deployment has changed its implementation either.`,
    };
  }

  if (ready.length === 0) {
    return {
      data: { generatedAt: now.toISOString(), withinDays, due: plan.map(planEntryDocument), refreshed: [] },
      warnings: ["Nothing could be re-collected; every due subject was skipped."],
      human: [`${plan.length} subjects are due, none can be re-collected:`, ...planLines].join("\n"),
    };
  }

  if (total > ceiling) {
    throw new CliError({
      code: "BUDGET_EXCEEDED",
      message: [
        `Refreshing ${ready.length} subjects is estimated at ${totalAmount} ${estimateCurrency}, above the ${ceiling} ceiling. Raise it with --budget or narrow the run with --agent, --deployment or --within.`,
        ...planLines,
      ].join("\n"),
      exitCode: EXIT_CODES.billing,
      details: { estimatedTotal: totalAmount, currency: estimateCurrency, ceiling, due: plan.map(planEntryDocument) },
    });
  }

  if (!parsed.yes) {
    throw new CliError({
      code: "APPROVAL_REQUIRED",
      // The list is what someone approves, so it belongs in the message: only
      // --json readers ever see `details`.
      message: [
        `${ready.length} subjects are due within ${withinDays} days, estimated at ${totalAmount} ${estimateCurrency} in total; this is not a spending cap. Re-run with --yes to approve.`,
        ...planLines,
      ].join("\n"),
      exitCode: EXIT_CODES.permission,
      details: {
        estimatedTotal: totalAmount,
        currency: estimateCurrency,
        withinDays,
        due: plan.map(planEntryDocument),
      },
    });
  }

  const warnings: string[] = [];
  const refreshed = [];
  const failures = [];
  let billed = 0;
  let currency = "USD";
  for (const entry of ready) {
    try {
      const collected = await collectEvidence(parsed, dependencies, entry.target!);
      billed += Number(collected.billedAmount);
      currency = collected.currency;
      warnings.push(...collected.warnings);
      refreshed.push({
        subject: collected.subject,
        verdict: collected.verdict,
        evidenceId: collected.evidenceId,
        billed: collected.billedAmount,
      });
    } catch (error) {
      const normalized = normalizeError(error);
      failures.push({ subject: entry.subject, code: normalized.code, message: normalized.message });
      warnings.push(
        `${entry.subject.agentId} on ${entry.subject.deploymentId} could not be re-collected: ${normalized.code}.`,
      );
    }
  }

  if (refreshed.length === 0) {
    throw new CliError({
      code: "REFRESH_FAILED",
      message: `None of the ${ready.length} due subjects could be re-collected.`,
      exitCode: EXIT_CODES.runtime,
      details: { failures },
    });
  }

  const billedAmount = billed.toFixed(6);
  return {
    data: {
      generatedAt: now.toISOString(),
      withinDays,
      due: plan.map(planEntryDocument),
      refreshed,
      ...(failures.length > 0 ? { failures } : {}),
      billed: { amount: billedAmount, currency },
      estimatedTotal: totalAmount,
    },
    warnings,
    human: [
      `Refreshed ${refreshed.length} of ${ready.length} due subjects, billed ${billedAmount} ${currency} (estimate was ${totalAmount} ${estimateCurrency}).`,
      ...refreshed.map(
        (item) =>
          `  ${item.subject.agentId} ${item.subject.agentVersion} · ${item.subject.deploymentId} · ${item.subject.protocol}: ${item.verdict} (${item.evidenceId})`,
      ),
      ...failures.map((item) => `  ${item.subject.agentId} · ${item.subject.deploymentId}: failed, ${item.code}`),
      ...skipped.map(
        (entry) => `  ${entry.subject.agentId} · ${entry.subject.deploymentId}: skipped, ${entry.skipped}`,
      ),
    ].join("\n"),
  };
}

/**
 * Ranks the catalog for one Agent and one Scenario, from the evidence on hand.
 *
 * Read-only and local except for the catalog: the ranking is computed here, so
 * it can be recomputed by anyone holding the same records. Everything that
 * decided the order is in the output -- the dimensions with their numbers, the
 * evidence behind each one, and the priorities nothing measures yet.
 */
interface RankedDeployments {
  readonly result: ReturnType<typeof recommend>;
  readonly profile: typeof CODING_GENERAL;
  readonly agentVersion: string;
  readonly constraints: RecommendationConstraints;
  readonly catalog: HubCatalogSnapshot;
}

/**
 * The one place the catalog is ranked. `recommend` reports it and
 * `connect --best` acts on it; a second copy of these rules is how the audit
 * would come to record a reason that was computed differently from the one the
 * operator was shown.
 */
async function rankDeployments(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
  existingCatalog?: HubCatalogSnapshot,
): Promise<RankedDeployments> {
  const profile = parsed.scenarioId === undefined ? CODING_GENERAL : scenarioProfile(parsed.scenarioId);
  if (profile === undefined) {
    throw new CliError({
      code: "SCENARIO_NOT_FOUND",
      message: `No Scenario ${parsed.scenarioId}. This build carries ${CODING_GENERAL.id}.`,
      exitCode: EXIT_CODES.usage,
    });
  }

  const lookup = await installedVersionOf(parsed, dependencies, integration);
  const agentVersion = knownVersion(lookup);
  if (agentVersion === undefined) {
    // Evidence is collected against an Agent version. Recommending without one
    // would mean picking whichever records happen to be in the store -- but
    // which of the four reasons stopped us decides what the reader does next,
    // so each one gets its own code and its own sentence.
    throw new CliError({
      code: lookup.status === "unsupported"
        ? "PRODUCT_VERSION_UNSUPPORTED"
        : lookup.status === "not-found"
          ? "AGENT_NOT_FOUND"
          : "AGENT_VERSION_UNKNOWN",
      message: `${versionUnavailableReason(lookup, integration.manifest.displayName)} Compatibility evidence is per Agent version, so there is nothing to recommend from.`,
      exitCode: lookup.status === "unsupported" ? EXIT_CODES.conflict : EXIT_CODES.unavailable,
      details: { agentId: integration.manifest.id, detection: lookup.status },
    });
  }

  const catalog = existingCatalog ?? await hubService(parsed, dependencies).catalog(parsed.profile, operationSignal(parsed));
  const protocols = [...hubProtocolsFor(integration)];
  const publisherOf = new Map(
    catalog.models.map((model) => [model.id, model.publisherName ?? model.publisher]),
  );
  const candidates: RecommendationCandidate[] = catalog.deployments.map((deployment) => ({
    deploymentId: deployment.id,
    displayName: deployment.displayName,
    ...(publisherOf.get(deployment.modelId) === undefined
      ? {}
      : { publisher: publisherOf.get(deployment.modelId)! }),
    protocols: deployment.protocols.map((entry) => entry.protocol),
    availability: deployment.availability.status,
    ...(deployment.pricing === undefined
      ? {}
      : {
          pricing: {
            currency: deployment.pricing.currency,
            billingMode: deployment.pricing.billingMode,
            unit: deployment.pricing.unit,
            input: deployment.pricing.input,
            output: deployment.pricing.output,
            ...(deployment.pricing.priceValidUntil === undefined
              ? {}
              : { priceValidUntil: deployment.pricing.priceValidUntil }),
          },
        }),
    ...(deployment.limits?.contextWindow === undefined ? {} : { contextWindow: deployment.limits.contextWindow }),
    ...(deployment.implementationFingerprint === undefined
      ? {}
      : { implementationFingerprint: deployment.implementationFingerprint }),
  }));

  const store = evidenceStore(dependencies);
  if (parsed.deployment !== undefined && parsed.modelAllowlist !== undefined) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "--deployment and --model-allowlist both narrow the candidate set; pass one of them.",
      exitCode: EXIT_CODES.usage,
    });
  }
  // References are resolved against the catalog here rather than matched as
  // strings in the engine: `glm-5.2` is an alias, and an allowlist that silently
  // matches nothing is the same failure as a price ceiling that excludes nobody.
  const allowlist = parsed.modelAllowlist?.map((reference) => {
    const deployment = selectDeploymentByReference(catalog, reference);
    if (deployment === undefined) {
      throw new CliError({
        code: "DEPLOYMENT_NOT_FOUND",
        message: `The allowlist names ${reference}, which is not in the visible Hub catalog.`,
        exitCode: EXIT_CODES.unavailable,
        details: { reference },
      });
    }
    return deployment.id;
  });
  const constraints = {
    ...(parsed.deployment === undefined ? {} : { deploymentIds: [parsed.deployment] }),
    ...(allowlist === undefined ? {} : { deploymentIds: allowlist }),
    ...(parsed.maxPrice === undefined ? {} : { maxBlendedPricePerMillion: parsed.maxPrice }),
    ...(parsed.excludePublishers === undefined ? {} : { excludePublishers: parsed.excludePublishers }),
  };
  const result = recommend({
    scenario: profile,
    agentId: integration.manifest.id,
    agentVersion,
    integrationId: integration.manifest.id,
    integrationVersion: integration.manifest.version,
    platform: platformTag(dependencies),
    agentProtocols: protocols,
    catalogVersion: catalog.catalogVersion,
    candidates,
    evidence: await store.list({ agentId: integration.manifest.id }),
    now: new Date(currentTime(dependencies)),
    constraints,
  });


  return { result, profile, agentVersion, constraints, catalog };
}

async function executeRecommend(parsed: ParsedArguments, dependencies: CliDependencies) {
  const requested = agentOperand(parsed, dependencies, { optional: false, command: "recommend" });
  const integration = resolveIntegration(requested!, dependencies);
  const { result, profile, agentVersion, constraints } = await rankDeployments(parsed, dependencies, integration);

  const eligible = result.candidates.filter((candidate) => candidate.eligible);
  const excluded = result.candidates.filter((candidate) => !candidate.eligible);
  const warnings: string[] = [];
  if (result.unmeasured.length > 0) {
    warnings.push(
      `${result.unmeasured.map((entry) => entry.priority).join(", ")} ${result.unmeasured.length === 1 ? "is a priority" : "are priorities"} this Scenario asks for that nothing measures yet; the ranking rests on ${result.candidates[0]?.dimensions?.map((dimension) => dimension.priority).join(", ") ?? "the remaining dimensions"}.`,
    );
  }
  if (eligible.length === 0) {
    warnings.push(
      `Nothing is recommendable for ${integration.manifest.displayName} ${agentVersion} on ${result.platform}. Collect evidence with "apexnova compatibility run ${integration.manifest.id} --deployment <id>".`,
    );
  }

  const human = [
    `${integration.manifest.displayName} ${agentVersion} · ${profile.id} ${profile.profileVersion} · ${result.platform} · rule ${result.ruleVersion}`,
    `Catalog ${result.catalogVersion}; ${eligible.length} eligible of ${result.candidates.length} considered.`,
    // A ranking of four Apexnova deployments reads as "the best four there are"
    // unless the boundary is on the page. ADR 0008 moved the second candidate
    // source to M5; until it lands, the scope is stated on every run rather
    // than left in a document.
    "Candidates come from the Apexnova catalog only. A Provider outside it is not ranked lower here; it is not considered at all.",
    ...result.unmeasured.map((entry) => `Not measured — ${entry.priority}: ${entry.why}`),
    "",
    // The summary names what actually excluded them; asserting a cause here as
    // well is how the ceiling case came to be reported as an evidence problem.
    ...(eligible.length === 0 ? [result.summary] : []),
    ...eligible.flatMap((candidate) => [
      `${candidate.rank}. ${candidate.displayName}  score ${candidate.score?.toFixed(3)}  confidence ${candidate.confidence?.toFixed(2)}  ${candidate.protocol}`,
      `     ${candidate.deploymentId}`,
      ...(candidate.dimensions ?? []).map(
        (dimension) =>
          `     ${dimension.priority.padEnd(14)} ${dimension.score.toFixed(2)} ×${dimension.weight.toFixed(2)}  ${dimension.detail}`,
      ),
      `     Evidence: ${candidate.evidenceRefs.join(", ") || "none"}`,
    ]),
    ...(excluded.length === 0
      ? []
      : ["", "Excluded:", ...excluded.map((candidate) => `  ${candidate.displayName} — ${candidate.reasons[0] ?? "no reason recorded"}`)]),
  ].join("\n");

  // `data` is the Recommendation itself, so it is the shape
  // `recommendation.schema.json` freezes rather than whatever the renderer
  // found convenient. The wider view stays in `human`, which no contract binds.
  return {
    data: recommendationRecord(result, constraints),
    warnings: warnings as readonly string[],
    human,
  };
}

/**
 * Publishes local evidence to Hub. Push only: pulling other people's records
 * into the store that feeds our published matrix would need the trust rules for
 * community submissions, and those do not exist yet (no signature scheme), so
 * this submits what we collected and reports what Hub makes of it.
 *
 * Nothing is sent before the list is approved. Accepted evidence is immutable
 * and public: a mistake can only be answered with a superseding record or a
 * revocation, both of which stay visible.
 */
async function executeCompatibilitySync(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  operands: readonly string[],
) {
  if (operands.length > 0) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "compatibility sync takes no operands; filter with --agent, --deployment or --protocol.",
      exitCode: EXIT_CODES.usage,
    });
  }

  const store = evidenceStore(dependencies);
  const records = await store.list({
    ...(parsed.agent === undefined ? {} : { agentId: parsed.agent }),
    ...(parsed.deployment === undefined ? {} : { deploymentId: parsed.deployment }),
    ...(parsed.protocol === undefined ? {} : { protocol: parsed.protocol }),
  });
  // Records written before the id form was agreed cannot be submitted: Hub
  // refuses `evidence.<32hex>` with 400 evidence_legacy_id, and they are
  // immutable, so they can only stay local.
  const skipped = records
    .filter((record) => isLegacyEvidenceId(record.id))
    .map((record) => ({
      evidenceId: record.id,
      subject: record.subject,
      reason: "Hub refuses the pre-agreement id form (400 evidence_legacy_id); this record stays local.",
    }));
  const uploadable = records.filter((record) => !isLegacyEvidenceId(record.id));

  if (uploadable.length === 0) {
    return {
      data: { generatedAt: new Date(currentTime(dependencies)).toISOString(), submitted: [], skipped, failed: [] },
      warnings: skipped.length > 0
        ? [`${skipped.length} local records cannot be submitted because of their id form; re-collect those subjects to publish them.`]
        : [] as readonly string[],
      human: records.length === 0
        ? "No evidence has been collected yet."
        : `Nothing can be submitted: all ${records.length} records carry the pre-agreement id form.`,
    };
  }

  const listing = uploadable.map(
    (record) =>
      `  ${record.id}\n    ${record.subject.agentId} ${record.subject.agentVersion} · ${record.subject.deploymentId} · ${record.subject.protocol} · ${record.subject.platform}`,
  );

  if (!parsed.yes) {
    throw new CliError({
      code: "APPROVAL_REQUIRED",
      message: [
        `${uploadable.length} evidence records would be submitted to Hub. Accepted evidence is immutable and public: it can be superseded or revoked, never edited or deleted. Re-run with --yes to approve.`,
        ...listing,
        ...(skipped.length === 0 ? [] : [`  (${skipped.length} skipped: pre-agreement id form)`]),
      ].join("\n"),
      exitCode: EXIT_CODES.permission,
      details: {
        submitting: uploadable.map((record) => ({ evidenceId: record.id, subject: record.subject })),
        skipped,
      },
    });
  }

  const service = hubService(parsed, dependencies);
  const signal = operationSignal(parsed);
  const warnings: string[] = [];

  // Registering the suite is not a precondition for submitting -- Hub accepts
  // records either way -- but without it Hub cannot tell that a later major has
  // superseded these records, which is half of what 12A.3 asks for.
  let suite: { readonly id: string; readonly version: string; readonly state: string };
  try {
    const registration = await service.registerTestSuite(parsed.profile, {
      suiteId: CAPABILITY_SUITE_ID,
      version: CAPABILITY_SUITE_VERSION,
      capabilityDigest: {
        digest: CAPABILITY_DEFINITIONS_DIGEST,
        capabilities: CAPABILITY_DEFINITIONS.map((definition) => ({
          id: definition.id,
          category: definition.category,
          defaultLevel: definition.defaultLevel,
          ttlDays: definition.ttlDays,
        })),
      },
      ttlTable: Object.fromEntries(CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition.ttlDays])),
      environment: `${platformTag(dependencies)} node ${process.version}`,
    }, signal);
    suite = {
      id: registration.suite.suiteId,
      version: registration.suite.version,
      state: registration.created ? "registered" : "already registered",
    };
  } catch (error) {
    const apiCode = error instanceof HubClientError ? error.apiCode : undefined;
    const normalized = normalizeError(error);
    suite = { id: CAPABILITY_SUITE_ID, version: CAPABILITY_SUITE_VERSION, state: `not registered (${apiCode ?? normalized.code})` };
    warnings.push(
      apiCode === "suite_version_immutable"
        // A version is an immutable identifier: someone registered this one
        // from a different definition, and the records already pointing at it
        // no longer mean what this build thinks they mean.
        ? `Hub already holds ${CAPABILITY_SUITE_ID} ${CAPABILITY_SUITE_VERSION} with a different definition. Records still upload, but the version no longer identifies one definition -- treat it as a contract problem, not a retry.`
        : `The test suite version could not be registered (${normalized.code}). Records still upload, but Hub cannot expire them when the suite's major changes.`,
    );
  }

  const submitted: {
    readonly evidenceId: string;
    readonly created: boolean;
    readonly supportsCurrentVerdict?: boolean;
    readonly staleReason?: string;
    readonly fingerprint?: string;
    readonly signatureStatus?: string;
  }[] = [];
  const failed: { readonly evidenceId: string; readonly code: string; readonly message: string }[] = [];
  let firstFailure: unknown;

  for (const record of uploadable) {
    try {
      const result = await service.submitEvidence(parsed.profile, record as unknown as Record<string, unknown>, signal);
      submitted.push({
        evidenceId: result.record.id,
        created: result.created,
        ...(result.record.derived.supportsCurrentVerdict === undefined
          ? {}
          : { supportsCurrentVerdict: result.record.derived.supportsCurrentVerdict }),
        ...(result.record.derived.staleReason === undefined ? {} : { staleReason: result.record.derived.staleReason }),
        ...(result.record.derived.fingerprint === undefined ? {} : { fingerprint: result.record.derived.fingerprint.match }),
        ...(result.record.received.signatureStatus === undefined ? {} : { signatureStatus: result.record.received.signatureStatus }),
      });
    } catch (error) {
      firstFailure ??= error;
      const apiCode = error instanceof HubClientError ? error.apiCode : undefined;
      const normalized = normalizeError(error);
      failed.push({ evidenceId: record.id, code: apiCode ?? normalized.code, message: normalized.message });
    }
  }

  // Every record failing is not a partial result to report; it is the command
  // failing, and the first error carries the exit code that says why.
  if (submitted.length === 0 && firstFailure !== undefined) throw firstFailure;

  const created = submitted.filter((entry) => entry.created).length;
  const notCounted = submitted.filter((entry) => entry.supportsCurrentVerdict === false);
  if (notCounted.length > 0) {
    warnings.push(
      `Hub does not count ${notCounted.length} of the submitted records toward a current verdict (${[...new Set(notCounted.map((entry) => entry.staleReason ?? "not stated"))].join(", ")}). They stay queryable.`,
    );
  }
  if (skipped.length > 0) {
    warnings.push(`${skipped.length} local records were not submitted because of their id form; re-collect those subjects to publish them.`);
  }
  for (const failure of failed) {
    warnings.push(`${failure.evidenceId} was rejected: ${failure.code}. ${failure.message}`);
  }

  return {
    data: {
      generatedAt: new Date(currentTime(dependencies)).toISOString(),
      suite,
      submitted,
      skipped,
      failed,
    },
    warnings: warnings as readonly string[],
    human: [
      `Suite ${suite.id} ${suite.version}: ${suite.state}`,
      `Submitted ${submitted.length} of ${uploadable.length} records (${created} new, ${submitted.length - created} already held by Hub).`,
      ...submitted.map(
        (entry) =>
          `  ${entry.evidenceId} ${entry.created ? "created" : "existing"}${entry.supportsCurrentVerdict === undefined ? "" : entry.supportsCurrentVerdict ? ", supports the current verdict" : `, does not support the current verdict${entry.staleReason ? ` (${entry.staleReason})` : ""}`}${entry.fingerprint ? `, fingerprint ${entry.fingerprint}` : ""}`,
      ),
      ...failed.map((entry) => `  ${entry.evidenceId} rejected: ${entry.code}`),
      ...skipped.map((entry) => `  ${entry.evidenceId} skipped: pre-agreement id form`),
    ].join("\n"),
  };
}

/**
 * Revokes one published record. Hub keeps it and writes why it was pulled --
 * months later nobody can reconstruct that from an absence -- so the reason is
 * required here as well as there. Revoking twice is the same outcome as once,
 * and the first reason is the one that stands.
 */
async function executeCompatibilityRevoke(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  operands: readonly string[],
) {
  const [evidenceId, ...rest] = operands;
  if (evidenceId === undefined || rest.length > 0) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "compatibility revoke takes exactly one evidence ID.",
      exitCode: EXIT_CODES.usage,
    });
  }
  const reason = parsed.reason?.trim();
  if (!reason) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: 'compatibility revoke requires --reason "why this record was pulled". Hub refuses a revocation without one.',
      exitCode: EXIT_CODES.usage,
    });
  }
  if (!parsed.yes) {
    throw new CliError({
      code: "APPROVAL_REQUIRED",
      message: `Revoking ${evidenceId} is public and permanent: the record stops supporting any verdict, stays readable by ID, and carries the reason from now on. Re-run with --yes to approve.`,
      exitCode: EXIT_CODES.permission,
      details: { evidenceId, reason },
    });
  }

  const record = await hubService(parsed, dependencies)
    .revokeEvidence(parsed.profile, evidenceId, reason, operationSignal(parsed));
  const recorded = record.received.revokedReason;
  const warnings = recorded !== undefined && recorded !== reason
    ? [`This record was already revoked; the original reason stands: ${recorded}`]
    : [] as readonly string[];
  return {
    data: { evidenceId: record.id, revokedAt: record.received.revokedAt, reason: recorded ?? reason },
    warnings,
    human: [
      `Revoked ${record.id}${record.received.revokedAt ? ` at ${record.received.revokedAt}` : ""}.`,
      `Reason: ${recorded ?? reason}`,
    ].join("\n"),
  };
}

function planEntryDocument(entry: RefreshPlanEntry) {
  return {
    subject: entry.subject,
    expired: entry.expired,
    ...(entry.dueAt === undefined ? {} : { dueAt: entry.dueAt }),
    ...(entry.implementationChanged === undefined ? {} : { implementationChanged: entry.implementationChanged }),
    ...(entry.estimate === undefined ? {} : { estimate: entry.estimate }),
    ...(entry.skipped === undefined ? {} : { skipped: entry.skipped }),
    ...(entry.installedVersion === undefined ? {} : { installedVersion: entry.installedVersion }),
  };
}

/**
 * Runs the suite against a recorded run. It costs nothing, needs no Hub and no
 * credential, and it writes no evidence: replaying a recording says what the
 * suite decides about those responses, not what a deployment does now. Evidence
 * only ever comes from a real run.
 */
async function executeCompatibilityReplay(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  operands: readonly string[],
) {
  const path = operands[0];
  if (path === undefined || operands.length !== 1) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "compatibility replay requires exactly one recording path.",
      exitCode: EXIT_CODES.usage,
    });
  }

  let parsedRecording: unknown;
  try {
    parsedRecording = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (cause) {
    throw new CliError({
      code: "RECORDING_NOT_READABLE",
      message: `The recording at ${path} could not be read.`,
      exitCode: EXIT_CODES.usage,
      cause,
    });
  }
  const recording = parseRecording(parsedRecording);

  const result = await (dependencies.runCapabilitySuite ?? runCapabilitySuite)({
    endpoint: recording.endpoint,
    protocol: recording.protocol,
    model: recording.model,
    deploymentId: recording.deploymentId,
    credential: SecretValue.from(REPLAY_CREDENTIAL),
    fetch: createReplayFetch(recording),
  });

  const supported = result.outcomes.filter((outcome) => outcome.support === "supported").length;
  return {
    data: {
      replayed: true,
      recordedAt: recording.recordedAt,
      recordingSuite: recording.suite,
      suite: result.suite,
      deploymentId: recording.deploymentId,
      protocol: recording.protocol,
      outcomes: result.outcomes,
    },
    warnings: [
      "A replay is not evidence: it reports what the suite decides about recorded responses, not what the deployment does now.",
      ...(recording.suite.version === result.suite.version
        ? []
        : [`The recording came from suite ${recording.suite.version}; this build runs ${result.suite.version}.`]),
    ],
    human: [
      `Replay of ${recording.deploymentId} · ${recording.protocol} recorded ${recording.recordedAt}: ${supported}/${result.outcomes.length} supported`,
      ...result.outcomes.map(
        (outcome) => `  ${outcome.capabilityId.padEnd(26)} ${outcome.support.padEnd(11)} ${outcome.detail}`,
      ),
      "This is a replay, not evidence; nothing was stored.",
    ].join("\n"),
  };
}

/**
 * Reads back the routing audit log. Entries nobody can read are a file, not an
 * audit: the exit condition asks for routes that are explicable, and until this
 * command existed the explanation lived only in JSON lines.
 *
 * Attributions are shown under the selection they belong to, because the three
 * questions a route has to answer -- which Deployment, on what grounds, and who
 * actually paid -- are answered by the pair and not by either alone.
 */
async function executeAudit(parsed: ParsedArguments, dependencies: CliDependencies) {
  const requested = agentOperand(parsed, dependencies, { optional: true, command: "audit" });
  const agentId = requested === undefined ? undefined : resolveIntegration(requested, dependencies).manifest.id;
  const limit = parsed.limit ?? 20;

  const entries = (await routingAuditLog(dependencies).list()).filter(
    (entry) => (agentId === undefined || entry.agentId === agentId) && entry.profile === parsed.profile,
  );

  const attributionsBySelection = new Map<string, RoutingAuditEntry[]>();
  const unlinked: RoutingAuditEntry[] = [];
  for (const entry of entries) {
    if (entry.event !== "attributed") continue;
    if (entry.selectionId === undefined) {
      // Shown on its own rather than dropped: an attribution nobody can trace
      // back to a decision is still a fact about spending, and hiding it would
      // be the quiet omission this log exists to prevent.
      unlinked.push(entry);
      continue;
    }
    const existing = attributionsBySelection.get(entry.selectionId) ?? [];
    existing.push(entry);
    attributionsBySelection.set(entry.selectionId, existing);
  }

  const routes = entries
    .filter((entry) => entry.event === "selected" || entry.event === "released")
    .reverse()
    .slice(0, limit);

  const human = entries.length === 0
    ? `No routes have been recorded for profile ${parsed.profile}.`
    : [
        ...routes.map((entry) => {
          const attributions = attributionsBySelection.get(entry.id) ?? [];
          return [
            entry.event === "released"
              ? `${entry.recordedAt}  ${entry.agentId}  released${entry.command ? ` by ${entry.command}` : ""}`
              : `${entry.recordedAt}  ${entry.agentId}  ${entry.deploymentId}`,
            ...(entry.event === "released"
              ? []
              : [
                  `  chosen: ${entry.grounds ?? "unrecorded"}${entry.recommendationId ? ` (${entry.recommendationId})` : ""}${entry.command ? ` by ${entry.command}` : ""}`,
                  ...(entry.protocol ? [`  protocol: ${entry.protocol}${entry.catalogVersion ? `, catalog ${entry.catalogVersion}` : ""}`] : []),
                  ...(entry.credentialId ? [`  credential: ${entry.credentialId}`] : []),
                ]),
            ...attributions.map((attribution) => {
              const billed = (attribution.attribution?.billedTo ?? [])
                .map((share) => `${share.requestCount} on ${share.apiKeyName ?? share.apiKeyId}`)
                .join(", ");
              // The method is printed because a window difference and a named
              // request are not the same claim, and a reader who cannot tell
              // them apart will take the approximation for the exact one.
              const requests = attribution.attribution?.requests ?? [];
              const named = requests.length === 0
                ? ""
                : `, ${requests.length} request${requests.length === 1 ? "" : "s"}`;
              return [
                `  billed (${attribution.command ?? "?"}): ${attribution.attribution?.status} via ${attribution.attribution?.method}${named}${billed ? ` \u2014 ${billed}` : ""}`,
                // One wall-clock reading each, not a latency measurement: no
                // aggregation, no percentile, no record of the conditions. It is
                // shown because it is what happened, and labelled so nobody
                // reads one sample as a distribution.
                ...requests
                  .filter((request) => request.path !== undefined)
                  .map((request) =>
                    `    ${request.method ?? "?"} ${request.path} ${request.status ?? "?"}${
                      request.durationMs === undefined ? "" : ` in ${request.durationMs}ms`
                    }${request.requestId ? ` (${request.requestId})` : ""}${request.failure ? ` \u2014 ${request.failure}` : ""}`,
                  ),
              ].join("\n");
            }),
          ].join("\n");
        }),
        ...(unlinked.length === 0
          ? []
          : ["", "Not linked to any recorded route:", ...unlinked.map((entry) => {
              // Who was billed is the useful half. A line that gives only the
              // status says something happened without saying to whom.
              const billed = (entry.attribution?.billedTo ?? [])
                .map((share) => `${share.requestCount} on ${share.apiKeyName ?? share.apiKeyId}`)
                .join(", ");
              return `  ${entry.recordedAt}  ${entry.agentId}  ${entry.attribution?.status}${billed ? ` \u2014 ${billed}` : ""}`;
            })]),
      ].join("\n\n");

  return {
    data: { profile: parsed.profile, entries: routes, unlinked },
    warnings: [] as readonly string[],
    human,
  };
}

/**
 * Renders the published matrix from the evidence on hand. It is generated, not
 * maintained: a hand-written matrix is a claim nobody can trace, which is the
 * thing M3 exists to stop. Reads the local store only, so it costs nothing.
 */
async function executeCompatibilityMatrix(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  operands: readonly string[],
) {
  if (operands.length > 0) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "compatibility matrix takes no operands; filter with --agent, --deployment or --protocol.",
      exitCode: EXIT_CODES.usage,
    });
  }
  const evidence = await evidenceStore(dependencies).list({
    ...(parsed.agent === undefined ? {} : { agentId: parsed.agent }),
    ...(parsed.deployment === undefined ? {} : { deploymentId: parsed.deployment }),
    ...(parsed.protocol === undefined ? {} : { protocol: parsed.protocol }),
  });
  const matrix = buildCompatibilityMatrix({ evidence, now: new Date(currentTime(dependencies)) });
  return {
    data: matrix,
    warnings: matrix.rows.length === 0 ? ["No evidence has been collected yet."] : ([] as readonly string[]),
    human: renderCompatibilityMatrix(matrix),
  };
}

/**
 * Reads what has been collected locally and says what it adds up to. It answers
 * from stored evidence only -- no Hub call, no billing -- so "nothing has been
 * collected" is an answer it gives rather than an error, and a subject whose
 * Agent version no longer matches what is installed is reported as not applying
 * instead of being quietly counted.
 */
/** The full sentence stays in the JSON `reason`; a terminal row needs the fact. */
function capabilityNote(capability: {
  readonly evidenceId?: string;
  readonly observedAt?: string;
  readonly expiresAt?: string;
  readonly stale: boolean;
}): string {
  if (capability.evidenceId === undefined) return "not collected";
  if (capability.stale) return `expired ${capability.expiresAt ?? ""}`.trimEnd();
  return `observed ${capability.observedAt ?? ""}`.trimEnd();
}

async function executeCompatibility(parsed: ParsedArguments, dependencies: CliDependencies) {
  const [subcommand, ...rest] = parsed.operands;
  if (subcommand === "run") return await executeCompatibilityRun(parsed, dependencies, rest);
  if (subcommand === "matrix") return await executeCompatibilityMatrix(parsed, dependencies, rest);
  if (subcommand === "replay") return await executeCompatibilityReplay(parsed, dependencies, rest);
  if (subcommand === "refresh") return await executeCompatibilityRefresh(parsed, dependencies, rest);
  if (subcommand === "sync") return await executeCompatibilitySync(parsed, dependencies, rest);
  if (subcommand === "revoke") return await executeCompatibilityRevoke(parsed, dependencies, rest);
  if (subcommand !== "explain") {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "compatibility accepts seven subcommands: run, refresh, sync, revoke, replay, explain and matrix.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (rest.length > 1) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "compatibility explain accepts at most one agent.",
      exitCode: EXIT_CODES.usage,
    });
  }

  const requestedAgent = rest[0];
  const targets = requestedAgent === undefined
    ? integrationRegistry(dependencies).list()
    : [resolveIntegration(requestedAgent, dependencies)];
  const store = evidenceStore(dependencies);
  const now = new Date(currentTime(dependencies));
  const runningOn = platformTag(dependencies);
  const warnings: string[] = [];

  const agents = [];
  for (const integration of targets) {
    const records = await store.list({
      agentId: integration.manifest.id,
      ...(parsed.deployment === undefined ? {} : { deploymentId: parsed.deployment }),
      ...(parsed.protocol === undefined ? {} : { protocol: parsed.protocol }),
    });
    const lookup = await installedVersionOf(parsed, dependencies, integration);
    const installedVersion = knownVersion(lookup);
    // `explain` still reports the stored records, but it must not imply they
    // describe what is installed when it could not find out what is installed.
    const versionNote = lookup.status === "no-version" || lookup.status === "detection-failed"
      ? `${versionUnavailableReason(lookup, integration.manifest.displayName)}${records.length === 0 ? "" : " Whether the evidence below applies to it cannot be established."}`
      : undefined;
    if (versionNote !== undefined) warnings.push(versionNote);

    const subjects = new Map<string, EvidenceSubject>();
    for (const record of records) subjects.set(subjectIdentity(record.subject), record.subject);

    const explained = [...subjects.values()].map((subject) => {
      const verdict = computeVerdict({ subject, evidence: records, now });
      const appliesToInstalled =
        installedVersion === undefined || installedVersion === subject.agentVersion;
      if (!appliesToInstalled) {
        warnings.push(
          `Evidence for ${integration.manifest.displayName} covers ${subject.agentVersion}, but ${installedVersion} is installed; a version change expires it.`,
        );
      }
      return {
        ...verdict,
        appliesToInstalled,
        collectedOnThisPlatform: subject.platform === runningOn,
      };
    });

    agents.push({
      agentId: integration.manifest.id,
      displayName: integration.manifest.displayName,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      ...(versionNote === undefined ? {} : { versionNote }),
      subjects: explained,
    });
  }

  // Human mode prints `human` and nothing else, so a note that only reached
  // `warnings` would be visible to `--json` and to no one else.
  const human = agents
    .map((agent) => {
      const note = agent.versionNote === undefined ? [] : [`  Note: ${agent.versionNote}`];
      if (agent.subjects.length === 0) {
        return [`${agent.displayName}: no compatibility evidence has been collected.`, ...note].join("\n");
      }
      return [...note, agent.subjects
        .map((entry) => {
          const subject = entry.subject;
          const cited = [
            ...new Set(
              entry.capabilities
                .map((capability) => capability.evidenceId)
                .filter((id): id is string => id !== undefined),
            ),
          ];
          return [
            `${agent.displayName}${subject.scenarioId ? ` (scenario ${subject.scenarioId})` : ""} ${subject.agentVersion} · ${subject.deploymentId}${subject.implementationFingerprint ? ` (impl ${subject.implementationFingerprint.slice(0, 12)})` : ""} · ${subject.protocol} · ${subject.platform}: ${entry.verdict}`,
            ...entry.capabilities.map(
              (capability) =>
                `  ${capability.capabilityId.padEnd(26)} ${capability.level.padEnd(9)} ${capability.support.padEnd(11)} ${capabilityNote(capability)}`,
            ),
            ...(cited.length === 0 ? [] : [`  Evidence: ${cited.join(", ")}`]),
            ...(entry.appliesToInstalled
              ? []
              : [`  Note: ${agent.installedVersion} is installed, so this evidence does not apply to it.`]),
            ...(entry.collectedOnThisPlatform
              ? []
              : [`  Note: collected on ${subject.platform}, running on ${runningOn}.`]),
          ].join("\n");
        })
        .join("\n\n")].join("\n");
    })
    .join("\n\n");

  return { data: { generatedAt: now.toISOString(), agents }, warnings, human };
}

function agentPlanSummary(plan: ChangePlan) {
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

function requireIntegration(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  command: string,
  options: { readonly trailingArgs?: boolean } = {},
): AgentIntegration {
  const agentId = agentOperand(parsed, dependencies, {
    optional: false,
    command,
    ...(options.trailingArgs ? { trailingArgs: true } : {}),
  });
  return resolveIntegration(agentId!, dependencies);
}

function rejectUnusableConfig(
  inspection: AgentInspection,
  integration: AgentIntegration,
): void {
  if (inspection.status !== "legacy" && inspection.status !== "invalid") return;
  throw new CliError({
    code: inspection.status === "legacy" ? "LEGACY_CONFIG" : "INVALID_CONFIG",
    message:
      inspection.warnings[0] ??
      `${integration.manifest.displayName} configuration is not supported.`,
    exitCode: EXIT_CODES.conflict,
    details: {
      agentId: inspection.agentId,
      configPath: inspection.configPath,
      status: inspection.status,
    },
  });
}

async function executeAgents(parsed: ParsedArguments, dependencies: CliDependencies) {
  noOperands(parsed);
  const registry = integrationRegistry(dependencies);
  const agents = registry.list().map((integration) => ({
    id: integration.manifest.id,
    displayName: integration.manifest.displayName,
    status: integration.manifest.status,
    platforms: integration.manifest.compatibility.platforms,
    protocols: integration.supportedProtocols,
    products: integration.manifest.compatibility.products.map((product) => ({
      name: product.name,
      versionRange: product.versionRange,
    })),
  }));
  return {
    data: { agents },
    warnings: [] as readonly string[],
    human: agents
      .map((agent) => `${agent.id}  ${agent.displayName}  ${agent.status}  ${agent.protocols.join(",")}`)
      .join("\n"),
  };
}

async function executeDetect(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
): Promise<{ readonly data: unknown; readonly warnings: readonly string[]; readonly human: string }> {
  const requestedAgent = agentOperand(parsed, dependencies, { optional: true, command: "detect" });
  // Without the platform filter, an Agent whose manifest excludes this platform
  // (Hermes has no Windows build) is probed anyway and reported as missing.
  const targets = requestedAgent
    ? [resolveIntegration(requestedAgent, dependencies)]
    : integrationRegistry(dependencies).list(currentPlatform(dependencies));

  const detections = [];
  for (const integration of targets) {
    detections.push(await detectForCommand(parsed, dependencies, integration));
  }

  const first = detections[0];
  if (requestedAgent && first && first.status === "not-found") {
    throw new CliError({
      code: "AGENT_NOT_FOUND",
      message: `${first.displayName} was not found in the current environment.`,
      exitCode: EXIT_CODES.unavailable,
      details: { agentId: first.agentId, configPath: first.configPath },
    });
  }

  const documents = detections.map(toDetectionDocument);
  const warnings = detections.flatMap((detection) => detection.warnings);
  const human = detections
    .map((detection) =>
      [
        `${detection.displayName}: ${detection.status}${detection.productVersion ? ` ${detection.productVersion}` : ""}`,
        `Config: ${detection.configPath}${detection.configExists ? "" : " (not created)"}`,
        ...(detection.status === "unsupported" ? [`Unsupported: ${detection.unsupportedReason}`] : []),
        ...detection.warnings.map((warning) => `Warning: ${warning}`),
      ].join("\n"),
    )
    .join("\n\n");
  return {
    data: requestedAgent ? documents[0] : { agents: documents },
    warnings,
    human,
  };
}

async function executeInspect(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
): Promise<{ readonly data: unknown; readonly warnings: readonly string[]; readonly human: string }> {
  const integration = requireIntegration(parsed, dependencies, "inspect");
  const detection = requireAvailable(
    await detectForCommand(parsed, dependencies, integration),
    integration,
  );
  const inspection = await integration.inspect(integrationContext(parsed, dependencies), detection);
  rejectUnusableConfig(inspection, integration);

  const connection = inspection.connection;
  const lines = [
    `${integration.manifest.displayName} configuration: ${inspection.status}`,
    `Config: ${inspection.configPath}`,
    `Managed by Apexnova-connect: ${inspection.managed ? "yes" : "no"}`,
  ];
  if (connection) {
    lines.push(
      `Protocol: ${connection.protocol ?? "unknown"}`,
      `Base URL: ${connection.baseUrl ?? "not set"}`,
      `Models: ${connection.modelIds.length > 0 ? connection.modelIds.join(", ") : "none"}`,
    );
  }
  return {
    data: toInspectionDocument(inspection),
    warnings: inspection.warnings,
    human: lines.join("\n"),
  };
}

interface AgentPlanResult {
  readonly integration: AgentIntegration;
  readonly plan: ChangePlan;
  readonly deployment: HubCatalogDeployment;
  readonly protocol: string;
  readonly catalogVersion: string;
  /** The ranking that chose this Deployment, when `--best` did the choosing. */
  readonly recommendationId?: string;
  readonly recommendationReasons?: readonly string[];
}

async function createAgentPlan(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
): Promise<AgentPlanResult> {
  const integration = requireIntegration(parsed, dependencies, parsed.command ?? "connect");
  if (parsed.best && parsed.deployment) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "--best and --deployment both choose the Deployment; pass one of them.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (!parsed.deployment && !parsed.best) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: `${parsed.command ?? "connect"} requires --deployment <id>, or --best to take the top of the ranking.`,
      exitCode: EXIT_CODES.usage,
    });
  }
  const context = integrationContext(parsed, dependencies);
  const detection = requireAvailable(
    await detectForCommand(parsed, dependencies, integration),
    integration,
  );
  const inspection = await integration.inspect(context, detection);
  rejectUnusableConfig(inspection, integration);

  const catalog = await hubService(parsed, dependencies).catalog(parsed.profile, operationSignal(parsed));
  // `--best` runs the ranking here rather than accepting a Recommendation id
  // from the command line. A cited id would be a claim this command cannot
  // check -- rankings are not stored, so nothing could confirm that the id
  // really ranked this Deployment -- and an audit entry whose grounds nobody
  // verified is worse than none. Running it makes the link by construction.
  const ranked = parsed.best ? await rankDeployments(parsed, dependencies, integration, catalog) : undefined;
  const chosen = ranked?.result.candidates.find((candidate) => candidate.eligible);
  if (ranked && chosen === undefined) {
    throw new CliError({
      code: "NO_ELIGIBLE_DEPLOYMENT",
      message: `Nothing is recommendable for ${integration.manifest.displayName} on ${ranked.result.platform}: ${ranked.result.summary}`,
      exitCode: EXIT_CODES.unavailable,
    });
  }
  const record = ranked ? recommendationRecord(ranked.result, ranked.constraints) : undefined;
  // --deployment is required above, so this takes the explicit branch and the
  // reference is resolved the one way, rather than a second copy of the rules.
  const deployment = chosen
    ? catalog.deployments.find((item) => item.id === chosen.deploymentId)!
    : await resolveDeployment(parsed, dependencies, integration, catalog);
  const protocol = selectProtocol(deployment, integration, parsed.protocol);
  const intent = connectionIntent(parsed, dependencies, integration, deployment, protocol, catalog);
  const plan = await integration.plan(context, detection, inspection, intent);

  return {
    integration,
    plan,
    ...(record === undefined ? {} : { recommendationId: record.id }),
    ...(chosen === undefined || ranked === undefined
      ? {}
      : {
          // The dimensions and their weights, not the candidate's caveats: the
          // question this answers is why this Deployment ranked first, and a
          // note about a preferred capability falling short does not answer it.
          recommendationReasons: [
            `Chosen by ${ranked.profile.id} ${ranked.profile.profileVersion} (rule ${ranked.result.ruleVersion}), score ${chosen.score?.toFixed(3)} of ${ranked.result.candidates.filter((candidate) => candidate.eligible).length} eligible`,
            ...(chosen.dimensions ?? []).map(
              (dimension) => `  ${dimension.priority.padEnd(14)} ${dimension.score.toFixed(2)} ×${dimension.weight.toFixed(2)}  ${dimension.detail}`,
            ),
            ...ranked.result.unmeasured.map((entry) => `  not measured — ${entry.priority}`),
          ],
        }),
    deployment,
    protocol: protocol.protocol,
    catalogVersion: catalog.catalogVersion,
  };
}

async function executeConnect(parsed: ParsedArguments, dependencies: CliDependencies) {
  const preview = await createAgentPlan(parsed, dependencies);
  const plan = agentPlanSummary(preview.plan);
  if (parsed.dryRun) {
    const warnings = [...preview.plan.warnings, "Dry-run performed no local writes and created no runtime credential."];
    return {
      data: { dryRun: true, agentId: preview.integration.manifest.id, catalogVersion: preview.catalogVersion, deploymentId: preview.deployment.id, protocol: preview.protocol, plan },
      warnings,
      human: [
        `Plan: ${plan.id}`,
        `Agent: ${preview.integration.manifest.displayName}`,
          `Deployment: ${preview.deployment.id}`,
        ...(preview.recommendationReasons ?? []).map((reason) => `  ${reason}`),
        `Protocol: ${preview.protocol}`,
        `Operations: ${plan.operations.length}`,
        ...plan.operations.map((operation) => `${operation.mode} ${operation.path} (${operation.contentBytes} bytes)`),
        "No changes were applied.",
      ].join("\n"),
    };
  }
  if (!parsed.yes) {
    throw new CliError({
      code: "APPROVAL_REQUIRED",
      message: `${parsed.command ?? "connect"} requires --yes after reviewing ${parsed.command ?? "connect"} --dry-run.`,
      exitCode: EXIT_CODES.permission,
      details: { plan },
    });
  }

  const catalog = await hubService(parsed, dependencies).catalog(parsed.profile, operationSignal(parsed));
  const deployment = catalog.deployments.find((item) => item.id === preview.deployment.id) ?? preview.deployment;
  const protocol = selectProtocol(deployment, preview.integration, parsed.protocol);
  const result = await configureAgent(
    parsed,
    dependencies,
    preview.integration,
    deployment,
    protocol,
    catalog,
    "runtime",
    preview.recommendationId === undefined
      ? undefined
      : { grounds: "recommendation", recommendationId: preview.recommendationId },
  );
  const applied = agentPlanSummary(result.plan);
  return {
    data: {
      connected: true,
      agentId: preview.integration.manifest.id,
      profile: parsed.profile,
      deploymentId: deployment.id,
      protocol: protocol.protocol,
      credentialId: result.binding.credentialId,
      credentialExpiresAt: result.binding.expiresAt,
      transactionId: result.transactionId,
      plan: applied,
    },
    warnings: result.warnings,
    human: [
      `Connected ${preview.integration.manifest.displayName} to ${deployment.displayName}.`,
      // The exit condition is that the user can always see the real Deployment
      // and the real billing subject. The display name is neither: it does not
      // identify the deployment, and it says nothing about which credential the
      // charges will land on.
      `Deployment: ${deployment.id}`,
      // `--best` chose it, so the reasons travel with the outcome: a ranking
      // that is only visible in a different command is not an explanation of
      // this one.
      ...(preview.recommendationReasons ?? []).map((reason) => `  ${reason}`),
      `Billed to runtime credential: ${result.binding.credentialId} (expires ${result.binding.expiresAt})`,
      ...(result.transactionId ? [`Restore transaction: ${result.transactionId}`] : []),
      `Launch with: apexnova run ${preview.integration.manifest.id}`,
    ].join("\n"),
  };
}

/**
 * `apexnova run <agent>` configures on first use and then launches. Existing
 * connections skip planning entirely and go straight to the launcher.
 */

interface LaunchAttribution {
  readonly ours: number;
  readonly others: readonly { readonly key: string; readonly requests: number; readonly detail: string }[];
}

/**
 * What the billing ledger says served requests in a window, grouped by the key
 * that paid. Buckets are hourly, so a snapshot is taken on both sides of the
 * launch and only the difference is attributed to it -- otherwise anything else
 * that ran earlier in the same hour would look like the Agent's doing.
 */
async function usageByKey(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  from: string,
  /**
   * The reconciliation that runs *after* a launch needs its own deadline. The
   * command's own has expired by then on any run worth reconciling, which lost
   * the attribution on exactly the long sessions where it matters most.
   */
  signal: AbortSignal = operationSignal(parsed),
): Promise<Map<string, { requests: number; name?: string; detail: Set<string> }>> {
  const result = await hubService(parsed, dependencies).usageQuery(
    parsed.profile,
    { from, granularity: "hour" },
    signal,
  );
  const byKey = new Map<string, { requests: number; name?: string; detail: Set<string> }>();
  // `granularity` was asked for, so the aggregate shape is what comes back; the
  // per-request shape has no bucket and is not what this compares.
  const items = "granularity" in result ? result.items : [];
  for (const item of items) {
    const key = item.apiKeyId ?? "(unattributed)";
    const entry = byKey.get(key) ?? { requests: 0, detail: new Set<string>() };
    entry.requests += item.requestCount;
    if (item.apiKeyName !== undefined) entry.name = item.apiKeyName;
    entry.detail.add(`${item.resolvedModel ?? item.requestedModel ?? "unknown model"} on ${item.publicDeploymentId ?? "unknown deployment"}`);
    byKey.set(key, entry);
  }
  return byKey;
}

/**
 * The launcher exists to make the Agent talk to the Deployment we configured on
 * the credential we issued. On 2026-09-11 it did neither and reported success:
 * OpenCode answered from a different model through a pre-existing long-lived
 * key, while every command printed success and the freshly minted credential
 * served nothing. A launcher that cannot tell that apart is not providing the
 * thing it exists for, so the run is reconciled against the ledger afterwards.
 *
 * Only positive evidence fails the run: requests appeared, none of them on our
 * credential. An empty ledger proves nothing -- settlement lags -- and is
 * reported as unconfirmed rather than treated as either outcome.
 */
function attributeLaunch(
  before: Map<string, { requests: number; name?: string; detail: Set<string> }>,
  after: Map<string, { requests: number; name?: string; detail: Set<string> }>,
  // A set, not one id: a run that outlives its credential is billed to the one
  // it started on and the one it was renewed onto, and counting the first as
  // ours and the second as a stranger's would report our own requests as
  // somebody else's.
  credentialIds: ReadonlySet<string>,
): LaunchAttribution {
  let ours = 0;
  const others: { key: string; requests: number; detail: string }[] = [];
  for (const [key, entry] of after) {
    const added = entry.requests - (before.get(key)?.requests ?? 0);
    if (added <= 0) continue;
    if (credentialIds.has(key)) ours += added;
    else others.push({ key: entry.name ? `${entry.name} (${key})` : key, requests: added, detail: [...entry.detail].sort().join(", ") });
  }
  return { ours, others: others.sort((left, right) => right.requests - left.requests) };
}

/**
 * Which credential paid for how many of the forwarded requests.
 *
 * One entry per credential rather than one line for the run, because a run that
 * crossed a renewal was billed to two of them and a single total would put
 * requests on a key that never carried them.
 */
function gatewayBilledTo(
  forwarded: readonly ForwardedRequest[],
  binding: RuntimeCredentialBinding,
): { apiKeyId: string; deploymentId: string; requestCount: number }[] {
  const counts = new Map<string, number>();
  for (const request of forwarded) {
    const apiKeyId = request.credentialId ?? binding.credentialId;
    counts.set(apiKeyId, (counts.get(apiKeyId) ?? 0) + 1);
  }
  return [...counts].map(([apiKeyId, requestCount]) => ({
    apiKeyId,
    deploymentId: binding.deploymentId,
    requestCount,
  }));
}

async function executeRun(parsed: ParsedArguments, dependencies: CliDependencies) {
  const integration = requireIntegration(parsed, dependencies, "run", { trailingArgs: true });
  const agentArgs = parsed.operands.slice(1);
  const io = dependencies.io ?? defaultIo();
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  const agentId = integration.manifest.id;

  const detection = requireAvailable(
    await detectForCommand(parsed, dependencies, integration),
    integration,
  );
  if (detection.status !== "installed") {
    throw new CliError({
      code: "AGENT_NOT_FOUND",
      message: `${integration.manifest.displayName} executable was not found; install it before using the launcher.`,
      exitCode: EXIT_CODES.unavailable,
      details: { agentId: detection.agentId, configPath: detection.configPath },
    });
  }

  let gateway: RunningGateway | undefined;
  const forwarded: ForwardedRequest[] = [];
  let gatewayBinding: RuntimeCredentialBinding | undefined;
  const gatewayNotices: string[] = [];
  let renewal: Promise<void> | undefined;
  let renewalFailedAt: number | undefined;

  /**
   * Replace the credential the gateway is holding, if it has come due.
   *
   * A renewal that fails is not a reason to fail the request. The credential in
   * hand is still valid -- "due" means inside the last hour of its life, not
   * expired -- so the run continues on it and says so. Once it really does
   * expire, Hub answers 401 and the gateway forwards that unchanged, which is
   * the truth about what happened rather than a guess made here.
   */
  async function renewGatewayCredential(): Promise<void> {
    try {
      // A fresh deadline per attempt. The command's own has expired by the
      // time a long run needs renewing, which is the only time it does.
      const outcome = await runtimeCredentialForLaunch(parsed, dependencies, integration, { signal: inFlightSignal(parsed) });
      const replaced = gatewayBinding!.credentialId !== outcome.binding.credentialId;
      gatewayBinding = outcome.binding;
      renewalFailedAt = undefined;
      if (replaced) {
        gatewayNotices.push(
          `The runtime credential was renewed mid-run; requests after that point are billed to ${outcome.binding.credentialId}.`,
        );
      }
      gatewayNotices.push(...outcome.warnings);
    } catch (cause) {
      // Remembered so the next request does not try again immediately. A Hub
      // that is refusing would otherwise be asked once per forwarded request.
      renewalFailedAt = currentTime(dependencies);
      gatewayNotices.push(
        `The runtime credential could not be renewed mid-run (${cause instanceof Error ? cause.message : "unknown error"}); the run continues on ${gatewayBinding!.credentialId} until it expires.`,
      );
    }
  }

  /**
   * What the gateway sends upstream, read once per request.
   *
   * This is the only path on which a credential can be replaced without
   * touching the Agent: on a direct connection the Agent holds the credential
   * in its own configuration, and swapping it would mean rewriting that
   * configuration underneath a running process. Here the Agent holds a local
   * token that never changes, and the replacement happens on this side of the
   * boundary.
   */
  async function gatewayCredential(): Promise<GatewayCredential> {
    const due = runtimeCredentialIsDue(gatewayBinding!, currentTime(dependencies));
    const coolingOff = renewalFailedAt !== undefined
      && currentTime(dependencies) - renewalFailedAt < RENEWAL_RETRY_COOLDOWN_MS;
    if (due && !coolingOff) {
      // Single-flight: eight requests arriving together must not mint eight
      // credentials, seven of which nothing would ever revoke.
      renewal ??= renewGatewayCredential().finally(() => { renewal = undefined; });
      await renewal;
    }
    const inForce = gatewayBinding!;
    return { secret: inForce.secret, credentialId: inForce.credentialId };
  }

  const existing = await bindings.load(agentId, parsed.profile);
  // `parsed.gateway`, not the variable below: that one is assigned inside this
  // branch, so reading it here left `--gateway` silently doing nothing whenever
  // a binding already existed -- the run went direct and said nothing.
  const needConfig = !existing || parsed.deployment !== undefined || parsed.gateway;
  let binding = existing;
  let selectionEntryId: string | undefined;
  let gatewayTransactionId: string | undefined;
  const configureWarnings: string[] = [];
  if (needConfig) {
    const catalog = await hubService(parsed, dependencies).catalog(parsed.profile, operationSignal(parsed));
    const deployment = await resolveDeployment(parsed, dependencies, integration, catalog, existing?.deploymentId);
    const protocol = selectProtocol(deployment, integration);
    if (parsed.gateway) {
      // Started here, once the endpoint this run will actually use is known --
      // taking whichever endpoint the catalog happened to list first would
      // forward to a different protocol's address. The credential is read per
      // request, so the gateway can be listening before the configure step below
      // mints it and writes the address down.
      gateway = await startGateway({
        upstreamBaseUrl: new URL(protocol.baseUrl).origin,
        credential: gatewayCredential,
        onForwarded: (request) => forwarded.push(request),
      });
    }
    // Through the gateway the Agent talks to loopback; the real endpoint stays
    // in this process. Only the origin changes -- the path is what tells the
    // upstream which endpoint this is, and dropping it would send every request
    // to the wrong one.
    const target = gateway
      ? { ...protocol, baseUrl: `${gateway.url}${new URL(protocol.baseUrl).pathname}` }
      : protocol;
    // Through the gateway the credential rotates: the Agent holds only the
    // local token, so replacing the Hub credential costs nothing on its side.
    // `run` defaults to a permanent key precisely because on a direct
    // connection the Agent holds the credential itself and swapping it would
    // mean rewriting a configuration it has already read -- a reason that does
    // not survive the process boundary. It also bounds what a crashed run can
    // leave behind: this path takes its credential back at the end, and if it
    // never gets there, a permanent key outlives the failure and a 24-hour one
    // does not.
    const result = await configureAgent(
      parsed, dependencies, integration, deployment, target, catalog,
      gateway ? "runtime" : "auto", undefined, gateway !== undefined,
    );
    binding = result.binding;
    gatewayBinding = result.binding;
    gatewayTransactionId = result.transactionId;
    selectionEntryId = result.auditEntryId;
    configureWarnings.push(...result.warnings);
    if (!parsed.json) {
      io.stderr(`Configured ${integration.manifest.displayName} with ${deployment.displayName} (${deployment.inferenceAlias}).\n`);
    }
  }
  if (!binding) {
    throw new CliError({ code: "RUNTIME_CREDENTIAL_NOT_FOUND", message: "No credential is stored for this profile.", exitCode: EXIT_CODES.authentication });
  }
  // A credential we just minted cannot be near expiry, so skip the rotation
  // check and its extra credential-store round trip on the configure path.
  const runtime = needConfig
    ? { binding, rotated: false, warnings: [] as readonly string[] }
    : await runtimeCredentialForLaunch(parsed, dependencies, integration);
  binding = runtime.binding;

  // Hourly buckets, so the before/after difference is what this launch did.
  const hourStart = new Date(currentTime(dependencies));
  hourStart.setUTCMinutes(0, 0, 0);
  const from = hourStart.toISOString();
  let before: Awaited<ReturnType<typeof usageByKey>> | undefined;
  try {
    before = await usageByKey(parsed, dependencies, from);
  } catch {
    // Reconciliation is a check on the launch, not a precondition for it.
    before = undefined;
  }

  const launchWarnings: string[] = [];
  if (parsed.gateway && gateway === undefined) {
    // Asked for and not running is a contradiction, not a fallback. Continuing
    // would send the request straight to Hub while the operator believes it went
    // through the gateway.
    throw new CliError({
      code: "GATEWAY_NOT_STARTED",
      message: "--gateway was requested but no gateway was started; the run was stopped rather than sent direct.",
      exitCode: EXIT_CODES.runtime,
    });
  }

  // Closing the gateway and taking the configuration back are not conditional
  // on the Agent having succeeded. Before this was a function called from both
  // paths, a launch that threw -- an Agent exiting non-zero raises
  // `AGENT_EXITED` -- left the gateway listening, so the process never exited
  // at all, and left the loopback address in the Agent's configuration.
  let released = false;
  async function releaseGateway(): Promise<void> {
    if (gateway === undefined || released) return;
    released = true;
    await gateway.close();
    // The configuration names an ephemeral loopback port and a token that died
    // with the process. Leaving it behind would give the next launch an address
    // that answers nothing, so the gateway run takes its own writes back.
    if (gatewayTransactionId !== undefined) {
      try {
        // The restore command already revokes the credential, restores the
        // previous binding and checks ordering. A second implementation here
        // would be a second set of rules to keep in step.
        await executeRestore(
          { ...parsed, command: "restore", operands: [gatewayTransactionId], yes: true, dryRun: false, list: false },
          dependencies,
        );
      } catch (cause) {
        launchWarnings.push(
          `The gateway configuration could not be rolled back automatically (${cause instanceof Error ? cause.message : "unknown error"}); run "apexnova restore --list".`,
        );
      }
    }
  }

  // Through the gateway the Agent gets the local token, never the Hub
  // credential: that is the point of the process boundary, not a side effect of
  // it.
  try {
    await launchAgent(
      parsed,
      dependencies,
      integration,
      gateway ? { ...binding, secret: SecretValue.from(gateway.localToken) } : binding,
      agentArgs,
    );
  } catch (cause) {
    await releaseGateway();
    // The gateway's own notices are the only record of what it did while the
    // Agent was running -- a credential renewed, or a renewal that failed and
    // left the run on a credential about to expire. They used to be assembled
    // after a successful launch and dropped on any other path, which threw them
    // away exactly when they explain the failure: an Agent that dies on
    // "Invalid API key" says nothing about why the key stopped working.
    for (const notice of gatewayNotices) io.stderr(`${notice}\n`);
    throw cause;
  }

  // Whatever the gateway ended up holding is what the last requests were billed
  // to, so the audit names that one. What each individual request cost is in
  // `billedTo`, which is split per credential below.
  if (gatewayBinding !== undefined) binding = gatewayBinding;
  launchWarnings.push(...gatewayNotices);

  await releaseGateway();

  // Every credential this run's requests could have been billed to: the one in
  // force at the end, plus any the gateway actually used before a renewal.
  const billedCredentialIds = new Set<string>([
    binding.credentialId,
    ...forwarded.flatMap((request) => (request.credentialId === undefined ? [] : [request.credentialId])),
  ]);

  let attribution: LaunchAttribution | undefined;
  if (before !== undefined) {
    try {
      attribution = attributeLaunch(
        before,
        await usageByKey(parsed, dependencies, from, inFlightSignal(parsed)),
        billedCredentialIds,
      );
    } catch {
      launchWarnings.push("The billing ledger could not be read after the run, so the requests it made were not attributed.");
    }
  } else {
    launchWarnings.push("The billing ledger could not be read before the run, so the requests it made were not attributed.");
  }

  // A launch that reused an existing binding made no selection of its own, so
  // the attribution points at the decision that is still in force.
  selectionEntryId ??= await selectionInForce(dependencies, agentId, parsed.profile, binding.deploymentId);

  // What a route cost is a second event, not an amendment to the first: it is
  // not known when the target is chosen, and rewriting the decision would lose
  // what was believed when it was made.
  if (gateway !== undefined) {
    // The gateway saw every request and the id the upstream gave it, so the
    // attribution stops being a difference between hourly buckets. It is also
    // confirmed by construction: nothing but this gateway held the credential.
    const failures = forwarded.filter((request) => request.failure !== undefined).length;
    try {
      await routingAuditLog(dependencies).append(
        createRoutingAuditEntry({
          event: "attributed",
          agentId,
          integrationId: integration.manifest.id,
          profile: parsed.profile,
          command: "run",
          deploymentId: binding.deploymentId,
          credentialId: binding.credentialId,
          ...(selectionEntryId === undefined ? {} : { selectionId: selectionEntryId }),
          attribution: {
            status: forwarded.length === 0 ? "unconfirmed" : "confirmed",
            method: "gateway",
            ...(forwarded.length === 0 ? {} : { requestCount: forwarded.length }),
            ...(forwarded.length === 0
              ? {}
              : {
                  requests: forwarded.slice(0, 200).map((request) => ({
                    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
                    method: request.method,
                    path: request.path,
                    status: request.status,
                    durationMs: Math.round(request.durationMs),
                    ...(request.failure === undefined ? {} : { failure: request.failure }),
                  })),
                }),
            ...(forwarded.length === 0 ? {} : { billedTo: gatewayBilledTo(forwarded, binding) }),
          },
          recordedAt: new Date(currentTime(dependencies)).toISOString(),
        }),
      );
    } catch {
      launchWarnings.push("The run completed but its billing attribution was not written to the audit log.");
    }
    if (failures > 0) {
      launchWarnings.push(`${failures} request${failures === 1 ? "" : "s"} could not reach the upstream and were not retried.`);
    }
  } else if (attribution !== undefined) {
    const billedTo = [
      ...(attribution.ours > 0 ? [{ apiKeyId: binding.credentialId, deploymentId: binding.deploymentId, requestCount: attribution.ours }] : []),
      ...attribution.others.map((entry) => ({ apiKeyId: entry.key, requestCount: entry.requests })),
    ];
    const status = attribution.ours === 0 && attribution.others.length > 0
      ? "mismatched" as const
      : attribution.ours === 0
        ? "unconfirmed" as const
        : "confirmed" as const;
    try {
      await routingAuditLog(dependencies).append(
        createRoutingAuditEntry({
          event: "attributed",
          agentId,
          integrationId: integration.manifest.id,
          profile: parsed.profile,
          command: "run",
          deploymentId: binding.deploymentId,
          credentialId: binding.credentialId,
          ...(selectionEntryId === undefined ? {} : { selectionId: selectionEntryId }),
          attribution: {
            status,
            method: "ledger-window",
            ...(status === "unconfirmed" ? {} : { requestCount: attribution.ours + attribution.others.reduce((sum, entry) => sum + entry.requests, 0) }),
            ...(billedTo.length === 0 ? {} : { billedTo }),
          },
          recordedAt: new Date(currentTime(dependencies)).toISOString(),
        }),
      );
    } catch {
      launchWarnings.push("The run completed but its billing attribution was not written to the audit log.");
    }
  }

  if (gateway === undefined && attribution && attribution.ours === 0 && attribution.others.length > 0) {
    const served = attribution.others
      .map((entry) => `${entry.requests} on ${entry.key} (${entry.detail})`)
      .join("; ");
    throw new CliError({
      code: "LAUNCH_ATTRIBUTION_MISMATCH",
      message: `${integration.manifest.displayName} exited, but none of the requests it billed used the credential this launcher issued. Served instead: ${served}. The Agent is reaching a Provider this profile did not configure, so what it costs and where it sends your code are not what Connect reported.`,
      exitCode: EXIT_CODES.verification,
      details: {
        agentId,
        expectedCredentialId: binding.credentialId,
        expectedDeploymentId: binding.deploymentId,
        served: attribution.others,
      },
    });
  }
  if (gateway === undefined && attribution && attribution.ours > 0 && attribution.others.length > 0) {
    launchWarnings.push(
      `Some requests in this window were billed to other credentials: ${attribution.others.map((entry) => `${entry.requests} on ${entry.key}`).join("; ")}.`,
    );
  }
  // Only for a direct run: a gateway run knows exactly what it forwarded, so
  // reporting the ledger's silence would describe a computation it did not do.
  if (gateway === undefined && attribution && attribution.ours === 0 && attribution.others.length === 0) {
    launchWarnings.push("The ledger shows no settled requests for this run yet, so its Deployment and billing subject were not confirmed.");
  }

  return {
    data: {
      agentId,
      profile: parsed.profile,
      deploymentId: binding.deploymentId,
      credentialKind: binding.kind ?? "runtime",
      credentialExpiresAt: binding.expiresAt,
      credentialRotated: runtime.rotated,
      exited: true,
      agentExitCode: 0,
      ...(attribution === undefined ? {} : { attributedRequests: attribution.ours }),
    },
    warnings: [...configureWarnings, ...runtime.warnings, ...launchWarnings],
    human: [
      `${runtime.rotated ? "Credential renewed.\n" : ""}${integration.manifest.displayName} exited successfully.`,
      ...(gateway
        ? [forwarded.length === 0
            ? `The local gateway forwarded no requests; this run made none.`
            : `${forwarded.length} request${forwarded.length === 1 ? "" : "s"} forwarded through the local gateway to ${binding.deploymentId}, each one named.`]
        : attribution && attribution.ours > 0
          ? [`${attribution.ours} request${attribution.ours === 1 ? "" : "s"} billed to this launcher's credential on ${binding.deploymentId}.`]
          : []),
      // Human mode prints `human` and nothing else.
      ...launchWarnings,
    ].join("\n"),
  };
}

/**
 * Prints the credential bound to an Agent and nothing else, for a target
 * product's own credential helper to consume. A rotating credential near its
 * expiry is renewed first, which is what makes the helper path stay valid over
 * a long session. Never emits the JSON envelope: a banner alongside the key
 * makes a helper fail.
 */
async function executeCredential(parsed: ParsedArguments, dependencies: CliDependencies) {
  const [subcommand, ...rest] = parsed.operands;
  if (subcommand !== "print") {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "credential accepts one subcommand: print.",
      exitCode: EXIT_CODES.usage,
    });
  }
  const agentId = rest[0];
  if (agentId === undefined || rest.length !== 1) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "credential print requires exactly one agent.",
      exitCode: EXIT_CODES.usage,
    });
  }
  const integration = resolveIntegration(agentId, dependencies);
  const bindings = new RuntimeBindingStore(credentialStore(dependencies));
  if (!(await bindings.load(integration.manifest.id, parsed.profile))) {
    throw new CliError({
      code: "RUNTIME_CREDENTIAL_NOT_FOUND",
      message: `No credential is stored for ${integration.manifest.displayName} on profile ${parsed.profile}; run connect first.`,
      exitCode: EXIT_CODES.authentication,
    });
  }
  const runtime = await runtimeCredentialForLaunch(parsed, dependencies, integration);
  (dependencies.io ?? defaultIo()).stdout(`${runtime.binding.secret.reveal()}\n`);
  return { raw: true as const, data: {}, warnings: [] as readonly string[], human: "" };
}

async function executeVerify(parsed: ParsedArguments, dependencies: CliDependencies) {
  const integration = requireIntegration(parsed, dependencies, "verify");
  const agentId = integration.manifest.id;
  const detection = requireAvailable(
    await detectForCommand(parsed, dependencies, integration),
    integration,
  );
  const inspection = await integration.inspect(integrationContext(parsed, dependencies), detection);
  const valid =
    inspection.status === "configured" &&
    inspection.managed &&
    (inspection.connection?.modelIds.length ?? 0) > 0;
  if (!valid) {
    throw new CliError({
      code: "VERIFICATION_FAILED",
      message: inspection.warnings[0] ?? `${integration.manifest.displayName} is not configured with a usable Apexnova provider.`,
      exitCode: EXIT_CODES.verification,
      details: { status: inspection.status, managed: inspection.managed },
    });
  }
  const configuration = {
    agentId,
    configPath: inspection.configPath,
    protocol: inspection.connection?.protocol,
    models: inspection.connection?.modelIds,
  };
  if (!parsed.live) {
    return {
      data: { valid: true, level: "configuration", ...configuration },
      warnings: ["Configuration verification passed; use --live to perform a minimal inference check."],
      human: `${integration.manifest.displayName} configuration is valid for ${inspection.connection?.modelIds.join(", ")}. Live inference was not tested.`,
    };
  }

  const binding = await new RuntimeBindingStore(credentialStore(dependencies)).load(agentId, parsed.profile);
  if (!binding) {
    throw new CliError({ code: "RUNTIME_CREDENTIAL_NOT_FOUND", message: "No runtime credential is stored for this profile; run connect first.", exitCode: EXIT_CODES.authentication });
  }
  if (binding.expiresAt !== undefined && Date.parse(binding.expiresAt) <= Date.now()) {
    throw new CliError({ code: "RUNTIME_CREDENTIAL_EXPIRED", message: "The stored runtime credential has expired; reconnect before live verification.", exitCode: EXIT_CODES.authentication });
  }
  if (
    binding.protocol !== "openai-responses" &&
    binding.protocol !== "openai-chat" &&
    binding.protocol !== "anthropic-messages"
  ) {
    throw new CliError({ code: "PROTOCOL_NOT_SUPPORTED", message: `Live verification does not support ${binding.protocol}.`, exitCode: EXIT_CODES.unavailable });
  }
  const bindingProtocol = binding.protocol;
  const service = hubService(parsed, dependencies);
  const catalog = await service.catalog(parsed.profile, operationSignal(parsed));
  const deployment = catalog.deployments.find((item) => item.id === binding.deploymentId);
  const protocol = deployment?.protocols.find((item) => item.protocol === binding.protocol);
  if (!deployment || !protocol || !inspection.connection?.modelIds.includes(deployment.inferenceAlias)) {
    throw new CliError({ code: "BINDING_MISMATCH", message: "The stored runtime credential no longer matches the visible catalog and the Agent configuration.", exitCode: EXIT_CODES.verification });
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
    else if (usage.settlementStatus === "pending") usageWarning = "The Hub has not settled this request yet; reconcile the billed cost later with the requestId below.";
    else if (usage.settlementStatus === "failed") usageWarning = "The Hub could not settle this request; it will not turn into a cost later.";
  } catch (error) {
    usageWarning = `Billing reconciliation skipped: ${normalizeError(error).code}. The requestId below is the source of truth for the real cost.`;
  }
  // `verify --live` reconciles by requestId, so its attribution is exact where
  // the launcher's is a time window: one request, named, and the ledger says
  // which key paid for it. A settlement that has not landed is `unconfirmed`,
  // never a confirmed zero.
  const auditWarnings: string[] = [];
  const selectionInForceId = await selectionInForce(dependencies, integration.manifest.id, parsed.profile, deployment.id);
  try {
    const billedKey = usage?.apiKeyId;
    const status = billedKey === undefined
      ? "unconfirmed" as const
      : billedKey === binding.credentialId
        ? "confirmed" as const
        : "mismatched" as const;
    await routingAuditLog(dependencies).append(
      createRoutingAuditEntry({
        event: "attributed",
        agentId: integration.manifest.id,
        integrationId: integration.manifest.id,
        profile: parsed.profile,
        command: "verify",
        deploymentId: deployment.id,
        credentialId: binding.credentialId,
        ...(selectionInForceId === undefined ? {} : { selectionId: selectionInForceId }),
        attribution: {
          status,
          method: "request-id",
          ...(billedKey === undefined ? {} : { requests: [{ requestId: inference.requestId }] }),
          ...(billedKey === undefined
            ? {}
            : {
                requestCount: 1,
                billedTo: [{
                  apiKeyId: billedKey,
                  ...(usage?.apiKeyName ? { apiKeyName: usage.apiKeyName } : {}),
                  deploymentId: deployment.id,
                  ...(inference.resolvedModel ? { resolvedModel: inference.resolvedModel } : {}),
                  requestCount: 1,
                }],
              }),
        },
        recordedAt: new Date(currentTime(dependencies)).toISOString(),
      }),
    );
  } catch {
    auditWarnings.push("The verification completed but its billing attribution was not written to the audit log.");
  }

  const billedLine = usage === undefined
    ? "Billed: not yet available"
    : usage.amount === undefined
      // `pending`, `not-billable` and `failed` all arrive without an amount, and
      // printing 0.000000 for any of them would be the local number presented
      // as the real one.
      ? `Billed: ${usage.settlementStatus ?? "not settled"}, no amount yet`
      : `Billed: ${usage.amount} ${usage.currency} (${usage.usage.inputTokens ?? 0} input + ${usage.usage.outputTokens ?? 0} output tokens)`;
  return {
    data: { valid: true, level: "live", ...configuration, estimate, estimateAssumptions: LIVE_VERIFY_ESTIMATE_USAGE, inference, ...(usage ? { usage } : {}) },
    warnings: [...(usageWarning ? [usageWarning] : []), ...auditWarnings] as readonly string[],
    human: [
      `${integration.manifest.displayName} live verification passed for ${inference.requestedModel}.`,
      `Deployment: ${inference.deploymentId}`,
      `Resolved model: ${inference.resolvedModel}`,
      `Request: ${inference.requestId}`,
      billedLine,
      `Non-binding estimate: ${estimate.amount} ${estimate.currency} (${LIVE_VERIFY_ESTIMATE_USAGE.inputTokens} input + ${LIVE_VERIFY_ESTIMATE_USAGE.outputTokens} output tokens assumed)`,
    ].join("\n"),
  };
}

const CREDENTIAL_PROBE_KEY = {
  integrationId: "apexnova-connect",
  accountId: "doctor",
  kind: "backend-probe",
} as const;

async function probeCredentialBackend(
  dependencies: CliDependencies,
  backendName: string,
): Promise<DiagnosticCheck> {
  const identity = { id: "credential-backend", severity: "error" } as const;
  let store;
  try {
    store = credentialStore(dependencies);
  } catch (error) {
    return {
      ...identity,
      status: "fail",
      code: `credential-backend.${error instanceof CredentialStoreError ? error.code : "unavailable"}`,
      severity: "error",
      message: backendName,
      remediation: error instanceof Error ? error.message : "The credential backend is unavailable.",
    };
  }

  const probe = SecretValue.from("apexnova-connect-doctor-probe");
  try {
    await store.set(CREDENTIAL_PROBE_KEY, probe);
    const stored = await store.get(CREDENTIAL_PROBE_KEY);
    await store.delete(CREDENTIAL_PROBE_KEY);
    if (stored?.reveal() !== probe.reveal()) {
      return {
        ...identity,
        status: "fail",
        code: "credential-backend.readback-mismatch",
        severity: "error",
        message: `${backendName} accepted a probe credential but did not return it.`,
      };
    }
    return {
      id: "credential-backend",
      status: "pass",
      code: `credential-backend.${platformCode(dependencies)}`,
      severity: "info",
      message: backendName,
    };
  } catch (error) {
    await store.delete(CREDENTIAL_PROBE_KEY).catch(() => {});
    const normalized = normalizeError(error);
    return {
      ...identity,
      status: "fail",
      code: `credential-backend.${normalized.code}`,
      severity: "error",
      message: backendName,
      remediation: normalized.message,
    };
  }
}

function platformCode(dependencies: CliDependencies): string {
  return dependencies.platform ?? process.platform;
}

async function executeDoctor(parsed: ParsedArguments, dependencies: CliDependencies) {
  const requestedAgent = agentOperand(parsed, dependencies, { optional: true, command: "doctor" });
  const targets = requestedAgent
    ? [resolveIntegration(requestedAgent, dependencies)]
    : integrationRegistry(dependencies).list(currentPlatform(dependencies));
  const context = integrationContext(parsed, dependencies);
  const checks: DiagnosticCheck[] = [];

  for (const integration of targets) {
    checks.push(...(await integration.diagnose(context)));
  }

  const platform = dependencies.platform ?? process.platform;
  const backendName = platform === "win32"
    ? "Windows Credential Manager"
    : platform === "linux"
      ? "Secret Service"
      : platform === "darwin"
        ? "macOS Keychain"
        : `unsupported on ${platform}`;
  // Naming the backend is not evidence it works: a headless Linux or WSL
  // session has secret-tool installed and no keyring answering behind it, and
  // the first sign used to be `login` failing after the user had approved the
  // device. Write, read back and delete a probe value instead.
  checks.push(await probeCredentialBackend(dependencies, backendName));
  checks.push({
    id: "state-root",
    status: "pass",
    code: "state-root.resolved",
    severity: "info",
    message: localStateRoot(dependencies),
  });
  const hubConfig = resolveHubConfig(hubConfigContext(dependencies));
  checks.push({
    id: "hub-endpoint",
    status: hubConfig ? "pass" : "fail",
    code: hubConfig ? "hub-endpoint.resolved" : "hub-endpoint.missing",
    severity: hubConfig ? "info" : "error",
    message: hubConfig ? `${hubConfig.baseUrl} (${hubConfig.source})` : "not configured; run `apexnova init`",
  });
  try {
    const account = await hubService(parsed, dependencies).whoami(parsed.profile, operationSignal(parsed));
    checks.push({ id: "hub-session", status: "pass", code: "hub-session.active", severity: "info", message: account.accountId ?? account.userId });
  } catch (error) {
    const normalized = normalizeError(error);
    checks.push({ id: "hub-session", status: "warning", code: `hub-session.${normalized.code}`, severity: "warning", message: normalized.code });
  }

  const failed = checks.some((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status !== "pass").map((check) => `${check.id}: ${check.message}`);
  return {
    data: { healthy: !failed, checks },
    warnings,
    human: checks.map((check) => `${check.status.toUpperCase()} ${check.id}: ${check.message}`).join("\n"),
  };
}

async function executeUsage(parsed: ParsedArguments, dependencies: CliDependencies) {
  noOperands(parsed);
  const service = hubService(parsed, dependencies);
  const query: UsageQuery = {
    // Reconciliation is per request: the ledger key is the request ID, and
    // "what did this one request cost" is the question a suite run leaves open.
    ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
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
    `${item.at}  ${item.apiKeyId ?? "-"}  ${item.resolvedModel}  ${item.amount === undefined ? `— (${item.settlementStatus ?? "not settled"})` : `${item.amount} ${item.currency}`}${item.abortedAt === undefined ? "" : "  aborted"}`,
  );
  return {
    data: result,
    warnings: [] as readonly string[],
    human: rows.length === 0 ? "No usage records." : rows.join("\n"),
  };
}

function normalizeError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  // A change that failed inside the shared lifecycle reports the integration's
  // own error, not the orchestration wrapper.
  if (error instanceof IntegrationChangeError && error.cause !== undefined) {
    return normalizeError(error.cause);
  }
  if (error instanceof AgentIntegrationError) {
    const exitCode =
      error.code === "INVALID_INPUT" || error.code === "MIXED_PROTOCOLS"
        ? EXIT_CODES.usage
        : error.code === "AGENT_NOT_FOUND" || error.code === "PROTOCOL_NOT_SUPPORTED"
          ? EXIT_CODES.unavailable
          : EXIT_CODES.conflict;
    return new CliError({
      code: error.code,
      message: error.message,
      exitCode,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
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
      ? "Your session lacks a scope this command needs. Run `apexnova login` to re-authorize. The compatibility:write and compatibility:revoke scopes also have to be granted to the account by a Hub administrator -- re-authorizing alone will not add them."
      : error.code === "KEY_TTL_POLICY"
        ? "Your organization requires keys to have a maximum TTL. Use --rotating for short-lived credentials or specify a shorter expiry."
        : error.message;
    return new CliError({ code: error.code, message, exitCode, retryable: error.retryable, ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}), ...(error.requestId ? { details: { requestId: error.requestId } } : {}), cause: error });
  }
  // Without this a keyring that is missing or not answering surfaces as
  // "The command failed unexpectedly", with nothing pointing at the keyring.
  if (error instanceof CredentialStoreError) {
    const exitCode =
      error.code === "BACKEND_UNAVAILABLE" || error.code === "UNSUPPORTED_PLATFORM"
        ? EXIT_CODES.unavailable
        : error.code === "INVALID_KEY" || error.code === "INVALID_SECRET"
          ? EXIT_CODES.usage
          : EXIT_CODES.runtime;
    const message =
      error.code === "BACKEND_UNAVAILABLE"
        ? `${error.message} Apexnova-connect stores sessions and credentials in the OS credential service and will not fall back to a plaintext file. On a headless Linux or WSL session, start a Secret Service provider (for example \`gnome-keyring-daemon --start --components=secrets\`) and try again.`
        : error.message;
    return new CliError({ code: error.code, message, exitCode, cause: error });
  }
  if (error instanceof ConfigExecutionError) {
    return new CliError({ code: error.code, message: error.message, exitCode: error.code === "ROLLBACK_FAILED" || error.code === "INVALID_RECEIPT" ? EXIT_CODES.recovery : error.code === "CONFLICT" || error.code === "ROLLBACK_ORDER_CONFLICT" ? EXIT_CODES.conflict : EXIT_CODES.runtime, cause: error });
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
      case "agents":
        result = await executeAgents(parsed, dependencies);
        break;
      case "audit":
        result = await executeAudit(parsed, dependencies);
        break;
      case "credential":
        result = await executeCredential(parsed, dependencies);
        break;
      case "usage":
        result = await executeUsage(parsed, dependencies);
        break;
      case "recommend":
        result = await executeRecommend(parsed, dependencies);
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
      case "compatibility":
        result = await executeCompatibility(parsed, dependencies);
        break;
      case "run":
        result = await executeRun(parsed, dependencies);
        break;
      // v0.1 shipped `apexnova opencode` as the one-command path. Keep it as an
      // alias so installed launchers and the published docs keep working.
      case "opencode":
        result = await executeRun(
          { ...parsed, command: "run", operands: ["opencode", ...parsed.operands] },
          dependencies,
        );
        break;
      default:
        throw new CliError({
          code: "UNKNOWN_COMMAND",
          message: `Unknown command: ${parsed.command ?? ""}.`,
          exitCode: EXIT_CODES.usage,
        });
    }

    // A raw result already wrote exactly what its caller must receive.
    if ("raw" in result && result.raw) return { exitCode: EXIT_CODES.success, requestId };
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
