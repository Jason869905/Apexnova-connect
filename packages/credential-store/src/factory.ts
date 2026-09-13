import { SpawnCommandRunner, type CommandRunner } from "./command-runner.js";
import { CredentialStoreError } from "./errors.js";
import { FileCredentialBackend, defaultCredentialFilePath } from "./file-store.js";
import { LinuxSecretServiceBackend } from "./linux-secret-service.js";
import { MacOsKeychainBackend } from "./macos-keychain.js";
import { SystemCredentialStore } from "./system-credential-store.js";
import { WindowsCredentialManagerBackend } from "./windows-credential-manager.js";

/**
 * Which family of backend to use.
 *
 * `system` is the operating system's credential service. `file` keeps secrets
 * in a 0600 file and protects them with file permissions alone.
 *
 * Linux defaults to `file`; Windows defaults to `system`. The Linux default is
 * a deliberate reversal (ADR 0036): the Secret Service is absent in the
 * environments this tool actually runs in -- containers, CI, headless SSH, WSL
 * -- and requiring it there bought no protection, only a five-command detour
 * that ended in a failure *after* the user had approved a device.
 *
 * What has not changed is that this is a *default*, never a fallback. A session
 * that asks for `system` and finds no keyring still fails: silently moving
 * secrets between two stores because one of them stopped answering would leave
 * a machine with half its credentials in each, and "where did my session go" is
 * a worse outcome than an error that names the problem.
 */
export type CredentialBackendKind = "system" | "file";

export interface DefaultCredentialStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly commandRunner?: CommandRunner;
  readonly serviceName?: string;
  /** Overrides the environment variable below. Defaults per platform. */
  readonly backend?: CredentialBackendKind;
  /** Where the `file` backend keeps its credentials. Defaults per platform. */
  readonly filePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  /**
   * Use the macOS Keychain backend even though macOS is not a supported
   * platform. Off by default; see the refusal below for why.
   */
  readonly allowUnverifiedMacOs?: boolean;
}

/** Environment escape hatch for `allowUnverifiedMacOs`, since no CLI flag exposes it. */
const ALLOW_UNVERIFIED_MACOS = "APEXNOVA_ALLOW_UNVERIFIED_MACOS";

/** Selects the backend family for callers that do not pass `backend`. */
const CREDENTIAL_STORE_ENV = "APEXNOVA_CREDENTIAL_STORE";

export interface CredentialBackendSelection {
  readonly kind: CredentialBackendKind;
  /** How the choice was made, for diagnostics that have to say why. */
  readonly source: "option" | "environment" | "default";
  /** Human-readable backend name, for `doctor` and error messages. */
  readonly backendName: string;
  /** Where the file backend stores secrets; absent for `system`. */
  readonly path?: string;
}

/**
 * The backend a platform gets when neither the caller nor the environment says
 * otherwise. Windows Credential Manager is present on every Windows session and
 * verified (ADR 0032), so Windows keeps it; macOS keeps `system` so the ADR 0024
 * refusal still fires rather than being quietly routed around.
 */
function platformDefault(platform: NodeJS.Platform): CredentialBackendKind {
  return platform === "linux" ? "file" : "system";
}

function systemBackendName(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows Credential Manager";
  if (platform === "linux") return "Secret Service";
  if (platform === "darwin") return "macOS Keychain";
  return `unsupported on ${platform}`;
}

/**
 * Resolves which backend a store built from these options would use, without
 * building one. `doctor` needs the answer before it probes anything, and an
 * answer derived a second way would eventually disagree with the store itself.
 */
export function resolveCredentialBackendSelection(
  options: DefaultCredentialStoreOptions = {},
): CredentialBackendSelection {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const requested: { readonly kind: CredentialBackendKind; readonly source: "option" | "environment" } | undefined =
    options.backend === undefined
      ? environmentBackend(environment)
      : { kind: options.backend, source: "option" };
  const kind = requested?.kind ?? platformDefault(platform);
  if (kind === "system") {
    return {
      kind: "system",
      source: requested?.source ?? "default",
      backendName: systemBackendName(platform),
    };
  }
  const path = options.filePath
    ?? defaultCredentialFilePath(environment, platform, options.homeDirectory);
  return {
    kind: "file",
    source: requested?.source ?? "default",
    backendName: "credential file (permissions only, no OS keyring)",
    path,
  };
}

function environmentBackend(
  environment: NodeJS.ProcessEnv,
): { readonly kind: CredentialBackendKind; readonly source: "environment" } | undefined {
  const raw = environment[CREDENTIAL_STORE_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "system" || value === "file") return { kind: value, source: "environment" };
  // A typo here would otherwise be read as "no preference" and send a session
  // that asked for the keyring into the file backend, or the reverse. Either
  // way the secrets end up somewhere the user did not choose, which is the one
  // thing this setting exists to prevent.
  throw new CredentialStoreError(
    "INVALID_CONFIGURATION",
    `${CREDENTIAL_STORE_ENV}=${raw} is not a credential backend. Use "system" or "file".`,
  );
}

export function createDefaultCredentialStore(
  options: DefaultCredentialStoreOptions = {},
): SystemCredentialStore {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const runner = options.commandRunner ?? new SpawnCommandRunner();
  const storeOptions =
    options.serviceName === undefined ? {} : { serviceName: options.serviceName };

  const selection = resolveCredentialBackendSelection(options);
  if (selection.kind === "file") {
    const path = selection.path
      ?? defaultCredentialFilePath(environment, platform, options.homeDirectory);
    return new SystemCredentialStore(
      new FileCredentialBackend(path, { platform }),
      storeOptions,
    );
  }

  if (platform === "win32") {
    return new SystemCredentialStore(
      new WindowsCredentialManagerBackend(runner),
      storeOptions,
    );
  }
  if (platform === "linux") {
    return new SystemCredentialStore(
      new LinuxSecretServiceBackend(runner),
      storeOptions,
    );
  }
  if (platform === "darwin") {
    // macOS stopped being a claimed platform in ADR 0024, and ADR 0027 narrowed
    // M2's exit condition to match. This backend is the reason that had to come
    // with a code change rather than only a documentation one: it has never run
    // against a real Keychain -- only a mock command runner -- and leaving it
    // selected by default would have kept an unverified implementation serving
    // the credential path silently, on a platform we no longer say we support.
    //
    // It is refused rather than warned about because of what it handles. A
    // half-working keychain write loses or corrupts a secret, and a warning on
    // stderr is not consent. The opt-in exists so this is a choice rather than
    // a dead end.
    const allowed = options.allowUnverifiedMacOs
      ?? (environment[ALLOW_UNVERIFIED_MACOS] === "1");
    if (!allowed) {
      throw new CredentialStoreError(
        "UNSUPPORTED_PLATFORM",
        `macOS is not a supported platform: the Keychain backend exists but has never been verified against a real Keychain. Set ${ALLOW_UNVERIFIED_MACOS}=1 to use it anyway, and treat anything it reports as unverified.`,
      );
    }
    return new SystemCredentialStore(
      new MacOsKeychainBackend(runner),
      storeOptions,
    );
  }
  throw new CredentialStoreError(
    "UNSUPPORTED_PLATFORM",
    `No safe system credential backend is available for ${platform}. Credentials can be kept in a permission-protected file instead, which has no OS protection behind it: set ${CREDENTIAL_STORE_ENV}=file to choose that.`,
  );
}
