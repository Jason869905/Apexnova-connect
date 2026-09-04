import { createDefaultCredentialStore } from "@apexnova-connect/credential-store";
import {
  HubControlPlaneClient,
  HubClientError,
  HubOAuthClient,
  HubSessionService,
  HubSessionStore,
  type DeviceVerificationPrompt,
  type CreateRuntimeCredentialInput,
  type CreatedRuntimeCredential,
  type HubAccountSummary,
  type HubBalance,
  type HubCatalogSnapshot,
  type HubTokenSet,
} from "@apexnova-connect/hub-client";

const DEFAULT_SCOPE = [
  "account:read", "catalog:read", "billing:read", "usage:read",
  "devices:read", "devices:revoke", "runtime-credentials:write",
].join(" ");

export interface HubCommandService {
  login(profileId: string, onVerificationRequired: (prompt: DeviceVerificationPrompt) => void | Promise<void>, signal?: AbortSignal): Promise<HubTokenSet>;
  logout(profileId: string): Promise<{ readonly serverRevoked: boolean }>;
  whoami(profileId: string, signal?: AbortSignal): Promise<HubAccountSummary>;
  balance(profileId: string, signal?: AbortSignal): Promise<HubBalance>;
  catalog(profileId: string, signal?: AbortSignal): Promise<HubCatalogSnapshot>;
  createRuntimeCredential(profileId: string, input: CreateRuntimeCredentialInput, signal?: AbortSignal): Promise<CreatedRuntimeCredential>;
  revokeRuntimeCredential(profileId: string, credentialId: string, signal?: AbortSignal): Promise<void>;
}

export interface DefaultHubCommandServiceOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function createDefaultHubCommandService(options: DefaultHubCommandServiceOptions = {}): HubCommandService {
  const environment = options.environment ?? process.env;
  const baseUrl = environment.APEXNOVA_HUB_BASE_URL;
  const clientId = environment.APEXNOVA_OAUTH_CLIENT_ID;
  const allowInsecureLoopback = environment.APEXNOVA_HUB_ALLOW_INSECURE_LOOPBACK === "1";
  if (!baseUrl || !clientId) {
    throw new HubClientError(
      "INVALID_CONFIG",
      "Hub staging is disabled until APEXNOVA_HUB_BASE_URL and APEXNOVA_OAUTH_CLIENT_ID are explicitly configured.",
    );
  }
  const credentials = createDefaultCredentialStore(options.platform ? { platform: options.platform } : {});
  const sessions = new HubSessionStore(credentials);
  const oauth = new HubOAuthClient({
    baseUrl, clientId, scope: DEFAULT_SCOPE,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
  });
  const sessionService = new HubSessionService(oauth, sessions);
  const control = (profileId: string) => new HubControlPlaneClient({
    baseUrl,
    accessToken: (signal) => sessionService.accessToken(profileId, signal ? { signal } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
  });

  return {
    async login(profileId, onVerificationRequired, signal) {
      await oauth.discover(signal);
      return sessionService.login(profileId, { onVerificationRequired, ...(signal ? { signal } : {}) });
    },
    async logout(profileId) {
      return sessionService.logout(profileId);
    },
    whoami: (profileId, signal) => control(profileId).me(signal),
    balance: (profileId, signal) => control(profileId).balance(signal),
    catalog: (profileId, signal) => control(profileId).catalog(signal),
    createRuntimeCredential: (profileId, input, signal) => control(profileId).createRuntimeCredential(input, signal),
    revokeRuntimeCredential: (profileId, credentialId, signal) => control(profileId).revokeRuntimeCredential(credentialId, signal),
  };
}
