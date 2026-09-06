import { createDefaultCredentialStore, SecretValue } from "@apexnova-connect/credential-store";
import {
  HubControlPlaneClient,
  HubClientError,
  HubOAuthClient,
  HubSessionService,
  HubSessionStore,
  type DeviceVerificationPrompt,
  type CreateRuntimeCredentialInput,
  type CreatedRuntimeCredential,
  type CreateApiKeyInput,
  type CreatedApiKey,
  type ApiKeySummary,
  type UpdateApiKeyInput,
  type HubAccountSummary,
  type HubBalance,
  type HubCatalogSnapshot,
  type HubPricingEstimate,
  type HubPricingUsage,
  type HubTokenSet,
  type HubUsageRecord,
  type RuntimeCredentialSummary,
  type UsageQuery,
  type UsageAggregateResult,
  type UsageListResult,
} from "@apexnova-connect/hub-client";

const CORE_SCOPE = [
  "account:read", "catalog:read", "billing:read", "usage:read",
  "devices:read", "devices:revoke", "runtime-credentials:write",
].join(" ");

const OPTIONAL_SCOPE = [
  "api-keys:write", "api-keys:read", "api-keys:revoke",
].join(" ");

export interface HubCommandService {
  login(profileId: string, onVerificationRequired: (prompt: DeviceVerificationPrompt) => void | Promise<void>, signal?: AbortSignal): Promise<HubTokenSet>;
  logout(profileId: string): Promise<{ readonly serverRevoked: boolean }>;
  whoami(profileId: string, signal?: AbortSignal): Promise<HubAccountSummary>;
  balance(profileId: string, signal?: AbortSignal): Promise<HubBalance>;
  catalog(profileId: string, signal?: AbortSignal): Promise<HubCatalogSnapshot>;
  estimatePricing(profileId: string, deploymentId: string, usage: HubPricingUsage, signal?: AbortSignal): Promise<HubPricingEstimate>;
  usage(profileId: string, requestId: string, signal?: AbortSignal): Promise<HubUsageRecord | undefined>;
  usageQuery(profileId: string, query: UsageQuery, signal?: AbortSignal): Promise<UsageAggregateResult | UsageListResult>;
  createRuntimeCredential(profileId: string, input: CreateRuntimeCredentialInput, signal?: AbortSignal): Promise<CreatedRuntimeCredential>;
  runtimeCredentials(profileId: string, signal?: AbortSignal): Promise<readonly RuntimeCredentialSummary[]>;
  revokeRuntimeCredential(profileId: string, credentialId: string, signal?: AbortSignal): Promise<void>;
  createApiKey(profileId: string, input: CreateApiKeyInput, signal?: AbortSignal): Promise<CreatedApiKey>;
  apiKeys(profileId: string, signal?: AbortSignal): Promise<readonly ApiKeySummary[]>;
  apiKey(profileId: string, id: string, signal?: AbortSignal): Promise<ApiKeySummary>;
  updateApiKey(profileId: string, id: string, input: UpdateApiKeyInput, signal?: AbortSignal): Promise<ApiKeySummary>;
  revokeApiKey(profileId: string, id: string, signal?: AbortSignal): Promise<void>;
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
  const apiPrefix = environment.APEXNOVA_HUB_PATH_PREFIX ?? "";
  if (!baseUrl || !clientId) {
    throw new HubClientError(
      "INVALID_CONFIG",
      "Hub staging is disabled until APEXNOVA_HUB_BASE_URL and APEXNOVA_OAUTH_CLIENT_ID are explicitly configured.",
    );
  }
  const credentials = createDefaultCredentialStore(options.platform ? { platform: options.platform } : {});
  const sessions = new HubSessionStore(credentials);
  const oauth = new HubOAuthClient({
    baseUrl, clientId, scope: CORE_SCOPE, optionalScopes: OPTIONAL_SCOPE,
    ...(apiPrefix ? { apiPrefix } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
  });
  const sessionService = new HubSessionService(oauth, sessions);
  const envAccessToken = environment.APEXNOVA_ACCESS_TOKEN;
  const control = (profileId: string) => new HubControlPlaneClient({
    baseUrl,
    accessToken: (signal) => envAccessToken
      ? Promise.resolve(SecretValue.from(envAccessToken))
      : sessionService.accessToken(profileId, signal ? { signal } : {}),
    ...(apiPrefix ? { apiPrefix } : {}),
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
    estimatePricing: (profileId, deploymentId, usage, signal) => control(profileId).estimatePricing(deploymentId, usage, signal),
    usage: (profileId, requestId, signal) => control(profileId).usage(requestId, signal),
    usageQuery: (profileId, query, signal) => control(profileId).usageQuery(query, signal),
    createRuntimeCredential: (profileId, input, signal) => control(profileId).createRuntimeCredential(input, signal),
    runtimeCredentials: (profileId, signal) => control(profileId).runtimeCredentials(signal),
    revokeRuntimeCredential: (profileId, credentialId, signal) => control(profileId).revokeRuntimeCredential(credentialId, signal),
    createApiKey: (profileId, input, signal) => control(profileId).createApiKey(input, signal),
    apiKeys: (profileId, signal) => control(profileId).apiKeys(signal),
    apiKey: (profileId, id, signal) => control(profileId).apiKey(id, signal),
    updateApiKey: (profileId, id, input, signal) => control(profileId).updateApiKey(id, input, signal),
    revokeApiKey: (profileId, id, signal) => control(profileId).revokeApiKey(id, signal),
  };
}
