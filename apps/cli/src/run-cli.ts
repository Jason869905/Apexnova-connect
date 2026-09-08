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
  type DiagnosticCheck,
} from "@apexnova-connect/integration-sdk";
import { IntegrationChangeError } from "@apexnova-connect/core";
import {
  HubClientError,
  verifyHubInference,
  type HubCatalogDeployment,
  type HubCatalogProtocol,
  type HubUsageRecord,
  type UsageQuery,
} from "@apexnova-connect/hub-client";
import {
  CAPABILITY_DEFINITIONS,
  FileEvidenceStore,
  REPLAY_CREDENTIAL,
  buildCompatibilityMatrix,
  buildRecording,
  computeVerdict,
  createEvidence,
  createRecordingFetch,
  createReplayFetch,
  parseRecording,
  renderCompatibilityMatrix,
  runCapabilitySuite,
  type CapabilityOutcomeDetail,
  type EvidenceSubject,
  type SubjectVerdict,
  type SuiteProtocol,
} from "@apexnova-connect/capabilities";
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
} from "./cli-core.js";
import {
  configureAgent,
  connectionIntent,
  detectForCommand,
  hubProtocolsFor,
  launchAgent,
  requireAvailable,
  resolveDeployment,
  runtimeCredentialForLaunch,
  selectProtocol,
  toProtocolId,
} from "./agent-workflow.js";
import { RuntimeBindingStore } from "./runtime-binding-store.js";
import {
  hubConfigDefaults,
  hubConfigPath,
  readHubConfigFile,
  resolveHubConfig,
  writeHubConfigFile,
} from "./hub-config.js";
import { CLI_VERSION } from "./version.js";

const LIVE_VERIFY_ESTIMATE_USAGE = { inputTokens: 64, outputTokens: 256 } as const;

// Five billable requests, sized from the probe bodies. Non-binding, like every
// estimate: the requestIds the run reports are what the real cost is read from.
const CAPABILITY_SUITE_ESTIMATE_USAGE = { inputTokens: 400, outputTokens: 700 } as const;

/** A local ceiling, because Hub has no per-request spending cap yet (M1-HUB-01). */
const CAPABILITY_SUITE_BUDGET = 0.05;

const HELP = `Apexnova-connect CLI

Usage:
  apexnova run <agent> [--deployment <id>] [--key <id>] [--rotating] [-- <agent args>]
  apexnova init [--hub-url <url>] [--client-id <id>] [--path-prefix <p>]
  apexnova login | logout | whoami | balance
  apexnova agents
  apexnova models [--agent <id>] [--protocol <id>] [--compatible-only]
  apexnova usage [--key <id>] [--from <iso>] [--to <iso>] [--granularity hour|day|month]
  apexnova connect <agent> --deployment <id> (--dry-run | --yes)
  apexnova switch <agent> --deployment <id> (--dry-run | --yes)
  apexnova verify <agent> [--live] [--yes] | doctor [agent]
  apexnova restore [transaction-id] [--list] [--dry-run] [--yes]
  apexnova compatibility run <agent> --deployment <id> [--budget <amount>] [--yes]
  apexnova compatibility refresh [--within <days>] [--budget <amount>] [--yes]
  apexnova compatibility replay <recording.json>
  apexnova compatibility explain [agent] [--deployment <id>] [--protocol <id>]
  apexnova compatibility matrix [--agent <id>] [--deployment <id>] [--protocol <id>]
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
  --budget <amount>      Local ceiling for a billable suite run (default 0.05)
  --record <path>        Write a replayable recording of a suite run
  --within <days>        Refresh evidence expiring within this many days (default 7)
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
      case "--record":
        recordPath = valueAfter(args, index, arg);
        index += 1;
        break;
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

async function executeRestore(parsed: ParsedArguments, dependencies: CliDependencies) {
  if (parsed.operands.length > 1) {
    throw new CliError({ code: "INVALID_ARGUMENT", message: "restore accepts at most one transaction ID.", exitCode: EXIT_CODES.usage });
  }
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
  const executor = new FileConfigExecutor({ allowedRoots, backupRoot });
  const transactionId = parsed.operands[0];
  const backups = await executor.listBackups();
  if (parsed.list || transactionId === undefined) {
    return {
      data: { backups },
      warnings: [] as readonly string[],
      human: backups.length === 0
        ? "No restorable transactions."
        : backups.map((item) => `${item.transactionId}  ${item.integrationId}  ${item.state}  ${item.appliedAt}${item.restorable ? "  restorable" : ""}`).join("\n"),
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
    await executor.rollback(receipt);
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
    } catch {
      runtimeCredentialRevoked = false;
      warnings.push(`Runtime credential ${binding.credentialId} could not be revoked from Hub; revoke the device or credential manually.`);
    }
    if (!replacement) await bindings.delete(agentId, parsed.profile);
  }
  return {
    data: { restored: true, transactionId, planId: receipt.planId, runtimeCredentialRestored, ...(runtimeCredentialRevoked === undefined ? {} : { runtimeCredentialRevoked }) },
    warnings,
    human: `Restored transaction ${transactionId}.${runtimeCredentialRestored ? " Previous runtime connection was reissued." : ""}${runtimeCredentialRevoked === false ? " Runtime credential requires manual revocation." : ""}`,
  };
}

function evidenceStore(dependencies: CliDependencies): FileEvidenceStore {
  return new FileEvidenceStore({ root: join(localStateRoot(dependencies), "evidence") });
}

function subjectKey(subject: EvidenceSubject): string {
  return [
    subject.agentId,
    subject.agentVersion,
    subject.integrationId,
    subject.integrationVersion,
    subject.deploymentId,
    subject.protocol,
    subject.platform,
  ].join("\u0000");
}

function platformTag(dependencies: CliDependencies): string {
  return `${currentPlatform(dependencies) ?? dependencies.platform ?? process.platform}-${process.arch}`;
}

/** A probe failure must not stop the command: it only costs the version note. */
async function installedVersionOf(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
  integration: AgentIntegration,
): Promise<string | undefined> {
  try {
    const detection = await detectForCommand(parsed, dependencies, integration);
    return "productVersion" in detection ? detection.productVersion : undefined;
  } catch {
    return undefined;
  }
}

function suiteProtocol(hubProtocol: string): SuiteProtocol | undefined {
  if (hubProtocol === "openai-responses") return "openai-responses";
  if (hubProtocol === "anthropic-messages") return "anthropic-messages";
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

interface CollectionResult {
  readonly evidenceId: string;
  readonly subject: EvidenceSubject;
  readonly verdict: SubjectVerdict;
  readonly outcomes: readonly CapabilityOutcomeDetail[];
  readonly billedAmount: string;
  readonly currency: string;
  readonly settled: number;
  readonly requestIds: readonly string[];
  readonly unsettled: readonly string[];
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
  const requestIds = [...new Set(suiteResult.requestIds)];
  let billed = 0;
  let currency = target.currency;
  let unsettled = [...requestIds];
  // Hub settles a request a beat after it answers, so the first pass usually
  // misses some. Reporting an unsettled request as costing nothing would be the
  // local number presented as the real one, which is what M1 established must
  // never happen -- so wait a little, then say plainly what is still open.
  for (let attempt = 0; attempt < 3 && unsettled.length > 0; attempt += 1) {
    if (attempt > 0) await (dependencies.sleep ?? defaultSleep)(5_000, signal);
    const stillOpen: string[] = [];
    for (const requestId of unsettled) {
      try {
        const usage = await service.usage(parsed.profile, requestId, signal);
        if (usage) {
          billed += Number(usage.amount);
          currency = usage.currency;
        } else {
          stillOpen.push(requestId);
        }
      } catch {
        stillOpen.push(requestId);
      }
    }
    unsettled = stillOpen;
  }
  const settled = requestIds.length - unsettled.length;
  if (unsettled.length > 0) {
    warnings.push(
      `Hub has not settled ${unsettled.length} of ${requestIds.length} requests yet; the billed figure covers ${settled} of them. Reconcile the rest with "apexnova usage --from".`,
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
    protocol: protocolId,
    platform: platformTag(dependencies),
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
      `${supported}/${suiteResult.outcomes.length} supported; billed ${billedAmount} ${currency} over ${settled} settled of ${requestIds.length} attributed requests; requests ${requestIds.join(" ")}`,
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
    requestIds,
    unsettled,
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
  const protocolId = toProtocolId(hubProtocol.protocol);
  if (protocol === undefined || protocolId === undefined) {
    throw new CliError({
      code: "PROTOCOL_NOT_SUPPORTED",
      message: `The first capability batch covers openai-responses and anthropic-messages; ${hubProtocol.protocol} is not in it yet.`,
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
      message: `The suite sends seven requests to ${deployment.id} over ${hubProtocol.protocol}, five of them billable. Hub estimates ${estimate.amount} ${estimate.currency}, which is not a spending cap. Re-run with --yes to approve.`,
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
  const { billedAmount, currency, settled, requestIds, unsettled, warnings } = collected;

  return {
    data: {
      evidenceId: collected.evidenceId,
      subject: collected.subject,
      verdict: collected.verdict,
      outcomes: collected.outcomes,
      estimate,
      estimateAssumptions: CAPABILITY_SUITE_ESTIMATE_USAGE,
      billed: { amount: billedAmount, currency, settledRequests: settled, attributedRequests: requestIds.length },
      requestIds,
      ...(unsettled.length > 0 ? { unsettledRequestIds: unsettled } : {}),
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
  readonly expired: boolean;
}

interface RefreshPlanEntry {
  readonly subject: EvidenceSubject;
  readonly dueAt?: string;
  readonly expired: boolean;
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

  const candidates: RefreshCandidate[] = [];
  for (const row of buildCompatibilityMatrix({ evidence, now }).rows) {
    const expiries = row.capabilities
      .map((capability) => capability.expiresAt)
      .filter((at): at is string => at !== undefined)
      .sort();
    const dueAt = expiries[0];
    const due = row.stale || (dueAt !== undefined && Date.parse(dueAt) <= horizon.getTime());
    if (!due) continue;
    candidates.push({
      subject: row.subject,
      ...(dueAt === undefined ? {} : { dueAt }),
      expired: row.stale,
    });
  }

  if (candidates.length === 0) {
    return {
      data: { generatedAt: now.toISOString(), withinDays, due: [], refreshed: [] },
      warnings: [] as readonly string[],
      human: `No evidence expires within ${withinDays} days.`,
    };
  }

  const service = hubService(parsed, dependencies);
  const signal = operationSignal(parsed);
  const catalog = await service.catalog(parsed.profile, signal);
  const registry = integrationRegistry(dependencies);
  const estimates = new Map<string, { readonly amount: string; readonly currency: string }>();
  const plan: RefreshPlanEntry[] = [];

  for (const candidate of candidates) {
    const base = {
      subject: candidate.subject,
      ...(candidate.dueAt === undefined ? {} : { dueAt: candidate.dueAt }),
      expired: candidate.expired,
    };
    if (!registry.has(candidate.subject.agentId)) {
      plan.push({ ...base, skipped: "this build does not load that Agent's integration" });
      continue;
    }
    const integration = registry.resolve(candidate.subject.agentId);
    const agentVersion = await installedVersionOf(parsed, dependencies, integration);
    if (agentVersion === undefined) {
      plan.push({ ...base, skipped: `${integration.manifest.displayName} is not installed here` });
      continue;
    }
    const deployment = catalog.deployments.find((item) => item.id === candidate.subject.deploymentId);
    if (!deployment) {
      plan.push({ ...base, skipped: "the deployment is no longer in the visible catalog" });
      continue;
    }
    if (deployment.availability.status !== "available" && deployment.availability.status !== "degraded") {
      plan.push({ ...base, skipped: `the deployment is ${deployment.availability.status}` });
      continue;
    }
    const hubProtocol = deployment.protocols.find(
      (item) => toProtocolId(item.protocol) === candidate.subject.protocol,
    );
    const protocol = hubProtocol ? suiteProtocol(hubProtocol.protocol) : undefined;
    const protocolId = hubProtocol ? toProtocolId(hubProtocol.protocol) : undefined;
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
        `  ${entry.subject.agentId} ${entry.subject.agentVersion} · ${entry.subject.deploymentId} · ${entry.subject.protocol}: ${entry.expired ? "expired" : `expires ${entry.dueAt}`}, estimate ${entry.estimate}${entry.installedVersion === undefined ? "" : ` (will be collected for the installed ${entry.installedVersion})`}`,
    ),
    ...skipped.map(
      (entry) =>
        `  ${entry.subject.agentId} ${entry.subject.agentVersion} · ${entry.subject.deploymentId} · ${entry.subject.protocol}: skipped, ${entry.skipped}`,
    ),
  ];

  if (ready.length === 0) {
    return {
      data: { generatedAt: now.toISOString(), withinDays, due: plan.map(planEntryDocument), refreshed: [] },
      warnings: ["Nothing could be re-collected; every due subject was skipped."],
      human: [`${candidates.length} subjects are due, none can be re-collected:`, ...planLines].join("\n"),
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

function planEntryDocument(entry: RefreshPlanEntry) {
  return {
    subject: entry.subject,
    expired: entry.expired,
    ...(entry.dueAt === undefined ? {} : { dueAt: entry.dueAt }),
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
  if (subcommand !== "explain") {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "compatibility accepts five subcommands: run, refresh, replay, explain and matrix.",
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
    const installedVersion = await installedVersionOf(parsed, dependencies, integration);

    const subjects = new Map<string, EvidenceSubject>();
    for (const record of records) subjects.set(subjectKey(record.subject), record.subject);

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
      subjects: explained,
    });
  }

  const human = agents
    .map((agent) => {
      if (agent.subjects.length === 0) {
        return `${agent.displayName}: no compatibility evidence has been collected.`;
      }
      return agent.subjects
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
            `${agent.displayName} ${subject.agentVersion} · ${subject.deploymentId} · ${subject.protocol} · ${subject.platform}: ${entry.verdict}`,
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
        .join("\n\n");
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
}

async function createAgentPlan(
  parsed: ParsedArguments,
  dependencies: CliDependencies,
): Promise<AgentPlanResult> {
  const integration = requireIntegration(parsed, dependencies, parsed.command ?? "connect");
  if (!parsed.deployment) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: `${parsed.command ?? "connect"} requires --deployment <id>.`,
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
  // --deployment is required above, so this takes the explicit branch and the
  // reference is resolved the one way, rather than a second copy of the rules.
  const deployment = await resolveDeployment(parsed, dependencies, integration, catalog);
  const protocol = selectProtocol(deployment, integration, parsed.protocol);
  const intent = connectionIntent(parsed, dependencies, integration, deployment, protocol, catalog);
  const plan = await integration.plan(context, detection, inspection, intent);

  return {
    integration,
    plan,
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
      `Runtime credential expires: ${result.binding.expiresAt}`,
      ...(result.transactionId ? [`Restore transaction: ${result.transactionId}`] : []),
      `Launch with: apexnova run ${preview.integration.manifest.id}`,
    ].join("\n"),
  };
}

/**
 * `apexnova run <agent>` configures on first use and then launches. Existing
 * connections skip planning entirely and go straight to the launcher.
 */
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

  const existing = await bindings.load(agentId, parsed.profile);
  const needConfig = !existing || parsed.deployment !== undefined;
  let binding = existing;
  const configureWarnings: string[] = [];
  if (needConfig) {
    const catalog = await hubService(parsed, dependencies).catalog(parsed.profile, operationSignal(parsed));
    const deployment = await resolveDeployment(parsed, dependencies, integration, catalog, existing?.deploymentId);
    const protocol = selectProtocol(deployment, integration);
    const result = await configureAgent(parsed, dependencies, integration, deployment, protocol, catalog);
    binding = result.binding;
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
  await launchAgent(parsed, dependencies, integration, binding, agentArgs);
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
    },
    warnings: [...configureWarnings, ...runtime.warnings],
    human: `${runtime.rotated ? "Credential renewed.\n" : ""}${integration.manifest.displayName} exited successfully.`,
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
  } catch (error) {
    usageWarning = `Billing reconciliation skipped: ${normalizeError(error).code}. The requestId below is the source of truth for the real cost.`;
  }
  const billedLine = usage
    ? `Billed: ${usage.amount} ${usage.currency} (${usage.usage.inputTokens ?? 0} input + ${usage.usage.outputTokens ?? 0} output tokens)`
    : `Billed: not yet available`;
  return {
    data: { valid: true, level: "live", ...configuration, estimate, estimateAssumptions: LIVE_VERIFY_ESTIMATE_USAGE, inference, ...(usage ? { usage } : {}) },
    warnings: usageWarning ? [usageWarning] : [] as readonly string[],
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
      ? "Your session lacks the required scopes (api-keys:*). Run `apexnova login` to re-authorize with the new permissions."
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
      case "credential":
        result = await executeCredential(parsed, dependencies);
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
