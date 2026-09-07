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
}

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
