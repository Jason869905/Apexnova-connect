import type { SecretValue } from "@apexnova-connect/credential-store";

export interface DeviceAuthorization {
  readonly deviceCode: SecretValue;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly revocationEndpoint: string;
  readonly scopesSupported: readonly string[];
}

export interface DeviceVerificationPrompt {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAt: string;
}

export type DevicePollResult =
  | {
      readonly status: "pending";
      readonly intervalSeconds: number;
    }
  | {
      readonly status: "authorized";
      readonly tokens: HubTokenSet;
    };

export interface HubTokenSet {
  readonly accessToken: SecretValue;
  readonly refreshToken?: SecretValue;
  readonly tokenType: string;
  readonly expiresAt?: string;
  readonly scope?: string;
  readonly accountId?: string;
}

export interface WaitForDeviceAuthorizationOptions {
  readonly signal?: AbortSignal;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly onPoll?: (attempt: number) => void;
}

export interface LoginOptions extends WaitForDeviceAuthorizationOptions {
  readonly onVerificationRequired: (
    prompt: DeviceVerificationPrompt,
  ) => void | Promise<void>;
}

export interface HubAccountSummary {
  readonly accountId?: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly plan?: { readonly id: string; readonly name: string };
  readonly defaultCurrency: string;
  readonly createdAt: string;
  readonly context: {
    readonly type: "personal" | "organization";
    readonly organizationId?: string;
    readonly role?: string;
    readonly readOnly?: boolean;
  };
  readonly deviceId?: string;
  readonly scopes: readonly string[];
}

export interface HubPromoCredit {
  readonly id: string;
  readonly remaining: string;
  readonly eligibleModelAliases: readonly string[];
  readonly expiresAt?: string;
}

export interface HubBalance {
  readonly currency: string;
  readonly normalBalance: string;
  readonly held: string;
  readonly normalAvailable: string;
  readonly promoCredits: readonly HubPromoCredit[];
  readonly asOf: string;
  readonly eligiblePromo?: string;
  readonly effectiveAvailable?: string;
}

export interface HubPricingUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly items?: number;
  readonly inputItems?: number;
  readonly seconds?: number;
  readonly itemAttrs?: Readonly<Record<string, string | boolean>>;
}

/**
 * Where a discount comes from and how long it lasts. Hub answered gap (g) with
 * this block; `discountRate` stays as the bare rate it used to be. For a
 * time-of-day promotion `expiresAt` is the end of the current window, not the
 * end of the campaign.
 */
export interface HubPricingDiscount {
  readonly rate: string;
  readonly source?: string;
  readonly appliesTo?: string;
  readonly expiresAt?: string;
}

export interface HubPricingEstimate {
  readonly deploymentId: string;
  readonly model: string;
  readonly currency: string;
  readonly billingMode: string;
  readonly listAmount: string;
  readonly discountRate?: string;
  readonly discount?: HubPricingDiscount;
  readonly amount: string;
  readonly priceVersion?: string;
  readonly estimateOnly: true;
}

export interface HubInferenceVerification {
  readonly status: number;
  readonly protocol: "openai-responses" | "openai-chat" | "anthropic-messages";
  readonly requestId: string;
  readonly providerId: string;
  readonly requestedModel: string;
  readonly resolvedModel: string;
  readonly deploymentId: string;
}

export interface HubCatalogProtocol {
  readonly protocol: "openai-responses" | "openai-chat" | "anthropic-messages" | string;
  readonly baseUrl: string;
}

export interface HubCatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: "platform";
}

export interface HubCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly publisher?: string;
  readonly publisherName?: string;
  readonly modelType: string;
  readonly capabilities: readonly string[];
  readonly deploymentIds: readonly string[];
}

export interface HubCatalogDeployment {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly inferenceAlias: string;
  readonly aliases: readonly string[];
  readonly protocols: readonly HubCatalogProtocol[];
  /** Changes when the deployment's implementation does; absent until Hub ships it. */
  readonly implementationFingerprint?: string;
  readonly implementationChangedAt?: string;
  readonly limits?: {
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
  };
  readonly capabilities: readonly string[];
  readonly availability: {
    readonly status: "available" | "degraded" | "maintenance" | "unavailable";
    readonly observedAt?: string;
    readonly source?: string;
  };
}

export interface HubCatalogSnapshot {
  readonly schemaVersion: string;
  readonly catalogVersion: string;
  readonly generatedAt: string;
  readonly expiresAt: string;
  readonly providers: readonly HubCatalogProvider[];
  readonly models: readonly HubCatalogModel[];
  readonly deployments: readonly HubCatalogDeployment[];
}

export interface CreateRuntimeCredentialInput {
  readonly name: string;
  readonly workspaceId?: string;
  readonly protocols: readonly string[];
  readonly publicDeploymentIds: readonly string[];
  readonly expiresIn?: number;
}

export interface CreatedRuntimeCredential {
  readonly credentialId: string;
  readonly secret: SecretValue;
  readonly expiresAt: string;
  readonly workspaceId?: string;
  readonly deviceId?: string;
}

export interface RuntimeCredentialSummary {
  readonly credentialId: string;
  readonly name: string;
  readonly prefix: string;
  readonly deviceId?: string;
  readonly workspaceId?: string;
  readonly protocols: readonly string[];
  readonly publicDeploymentIds: readonly string[];
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

/**
 * Hub's answer to gap (d): the three meanings an empty result used to carry are
 * now distinct. `pending` and `failed` leave `amount` null rather than zero --
 * an unsettled request is not a free one.
 */
export type UsageSettlementStatus = "pending" | "settled" | "not-billable" | "failed";

export interface HubUsageRecord {
  readonly id: string;
  readonly requestId: string;
  readonly at: string;
  readonly status: "success" | "error";
  readonly statusCode?: number;
  readonly requestedModel?: string;
  readonly requestedDeploymentId?: string;
  readonly resolvedModel: string;
  readonly resolvedDeploymentId?: string;
  readonly fallbackApplied?: boolean;
  readonly workspaceId?: string;
  readonly source: string;
  readonly usage: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly items?: number;
  };
  readonly currency: string;
  /** Absent until the request settles; `not-billable` and `failed` never carry one. */
  readonly amount?: string;
  readonly settlementStatus?: UsageSettlementStatus;
  /** Set when the client aborted; the request is still billed for what was produced. */
  readonly abortedAt?: string;
  readonly promoCovered?: string;
  readonly balanceCovered?: string;
  readonly discountRate?: string;
  readonly apiKeyId?: string;
  readonly apiKeyName?: string;
  readonly apiKeyKind?: "user" | "runtime";
}

export interface CreateApiKeyInput {
  readonly name: string;
  readonly workspaceId?: string;
  readonly protocols?: readonly string[];
  readonly publicDeploymentIds?: readonly string[];
  readonly expiresIn?: number | null;
  readonly scopes?: readonly string[];
}

export interface CreatedApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly secret: SecretValue;
  readonly kind: "user";
  readonly workspaceId?: string;
  readonly protocols: readonly string[];
  readonly publicDeploymentIds: readonly string[];
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly kind: "user";
  readonly workspaceId?: string;
  readonly protocols: readonly string[];
  readonly publicDeploymentIds: readonly string[];
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

export interface UpdateApiKeyInput {
  readonly name?: string;
  readonly protocols?: readonly string[];
  readonly publicDeploymentIds?: readonly string[];
  readonly expiresIn?: number | null;
}

export type UsageGranularity = "hour" | "day" | "month";

export interface UsageQuery {
  readonly requestId?: string;
  readonly apiKeyId?: string;
  readonly workspaceId?: string;
  readonly model?: string;
  readonly from?: string;
  readonly to?: string;
  readonly granularity?: UsageGranularity;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface UsageAggregateRecord {
  readonly bucketStart: string;
  readonly apiKeyId?: string;
  readonly apiKeyName?: string;
  readonly publicDeploymentId?: string;
  readonly requestedModel?: string;
  readonly resolvedModel?: string;
  readonly requestCount: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly normalCost: string;
  readonly promoCost?: string;
  readonly currency: string;
}

export interface UsageAggregateResult {
  readonly granularity: UsageGranularity;
  readonly from?: string;
  readonly to?: string;
  readonly items: readonly UsageAggregateRecord[];
  readonly nextCursor?: string;
  readonly asOf: string;
}

export interface UsageListResult {
  readonly items: readonly HubUsageRecord[];
  readonly nextCursor?: string;
  readonly asOf?: string;
}
