import { SpawnCommandRunner, type CommandRunner } from "./command-runner.js";
import { CredentialStoreError } from "./errors.js";
import { LinuxSecretServiceBackend } from "./linux-secret-service.js";
import { MacOsKeychainBackend } from "./macos-keychain.js";
import { SystemCredentialStore } from "./system-credential-store.js";
import { WindowsCredentialManagerBackend } from "./windows-credential-manager.js";

export interface DefaultCredentialStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly commandRunner?: CommandRunner;
  readonly serviceName?: string;
  /**
   * Use the macOS Keychain backend even though macOS is not a supported
   * platform. Off by default; see the refusal below for why.
   */
  readonly allowUnverifiedMacOs?: boolean;
}

/** Environment escape hatch for `allowUnverifiedMacOs`, since no CLI flag exposes it. */
const ALLOW_UNVERIFIED_MACOS = "APEXNOVA_ALLOW_UNVERIFIED_MACOS";

export function createDefaultCredentialStore(
  options: DefaultCredentialStoreOptions = {},
): SystemCredentialStore {
  const platform = options.platform ?? process.platform;
  const runner = options.commandRunner ?? new SpawnCommandRunner();
  const storeOptions =
    options.serviceName === undefined ? {} : { serviceName: options.serviceName };

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
      ?? (process.env[ALLOW_UNVERIFIED_MACOS] === "1");
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
    `No safe system credential backend is available for ${platform}.`,
  );
}
