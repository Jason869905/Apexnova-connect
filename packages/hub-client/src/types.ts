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
  /** What Hub granted. It can be narrower than `requestedScope`. */
  readonly scope?: string;
  /** What was asked for: the advertised subset of the core and optional scopes. */
  readonly requestedScope?: string;
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

/**
 * A capability the catalog lists, with who is making the claim. Absence of a
 * statement means unknown, never unsupported: the catalog carries only what an
 * operator declared. Everything it emits today is `provider-claim` -- nobody
 * has measured it -- which is why a claim never reaches a tested verdict.
 */
export interface HubCatalogCapabilityStatement {
  readonly capabilityId: string;
  readonly support: "supported" | "partial" | "unsupported" | "unknown";
  readonly sourceType: "provider-claim" | "official-test" | "maintainer-test" | "community-test" | "runtime-observation";
  readonly observedAt?: string;
  readonly expiresAt?: string;
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
  /** The same capabilities, each carrying its evidence level. */
  readonly capabilityStatements: readonly HubCatalogCapabilityStatement[];
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
  /** Absent until billing settles -- `pending` and `failed` records carry none. */
  readonly status?: "success" | "error";
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

/**
 * The three blocks of a stored evidence record, kept strictly apart: `payload`
 * is the submission returned byte for byte, `received` is what Hub appended on
 * receipt, and `derived` is what Hub computed at query time. Merging them would
 * make it impossible to say which fields the submitter authored.
 */
export type EvidenceSignatureStatus = "none" | "unverified" | "valid" | "invalid";

export type EvidenceStaleReason =
  | "implementation-changed"
  | "implementation-unknown"
  | "suite-major-superseded";

export type EvidenceFingerprintMatch = "match" | "stale" | "unknown" | "absent";

export interface HubEvidenceReceived {
  readonly receivedAt?: string;
  readonly submittedBy?: string;
  /** `none` means no signature was submitted; `unverified` means one was and Hub has not checked it. */
  readonly signatureStatus?: EvidenceSignatureStatus;
  readonly payloadBytes?: number;
  /** Hub's own reading of the deployment fingerprint, beside the collector's claim in `subject`. */
  readonly implementationFingerprint?: string;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

export interface HubEvidenceCapabilityStatus {
  readonly capabilityId?: string;
  readonly expiresAt?: string;
  readonly expired: boolean;
}

export interface HubEvidenceFingerprintView {
  readonly subject?: string;
  readonly received?: string;
  readonly current?: string;
  /** `stale` is a fingerprint Hub has seen before; `unknown` is one it never has. */
  readonly match: EvidenceFingerprintMatch;
}

export interface HubEvidenceDerived {
  readonly recordExpired?: boolean;
  /** Per capability, evaluated independently; the payload's own list is never trimmed. */
  readonly capabilityStatus: readonly HubEvidenceCapabilityStatus[];
  readonly staleReason?: EvidenceStaleReason;
  readonly supersededBy?: string;
  readonly fingerprint?: HubEvidenceFingerprintView;
  /** Hub's own judgement; every input above is exposed so a caller can recompute it. */
  readonly supportsCurrentVerdict?: boolean;
}

export interface HubEvidenceRecord {
  readonly id: string;
  /** The submitted record, unchanged. Hub is not allowed to rewrite any field of it. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly received: HubEvidenceReceived;
  readonly derived: HubEvidenceDerived;
}

export interface HubEvidenceSubmission {
  readonly record: HubEvidenceRecord;
  /** False when Hub already held this exact record: submission is idempotent on the content hash. */
  readonly created: boolean;
}

export interface HubEvidenceListResult {
  readonly items: readonly HubEvidenceRecord[];
  readonly nextCursor?: string;
}

export interface HubEvidenceQuery {
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly integrationId?: string;
  readonly integrationVersion?: string;
  readonly deploymentId?: string;
  readonly protocol?: string;
  readonly platform?: string;
  readonly suiteId?: string;
  readonly suiteVersion?: string;
  readonly sourceType?: string;
  readonly includeExpired?: boolean;
  readonly includeRevoked?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RegisterTestSuiteInput {
  readonly suiteId: string;
  readonly version: string;
  readonly capabilityDigest: Readonly<Record<string, unknown>>;
  readonly ttlTable: Readonly<Record<string, unknown>>;
  readonly environment?: string;
}

export interface HubTestSuiteVersion {
  readonly suiteId: string;
  readonly version: string;
  readonly majorVersion: number;
  readonly capabilityDigest: Readonly<Record<string, unknown>>;
  readonly ttlTable: Readonly<Record<string, unknown>>;
  readonly environment?: string;
  readonly registeredAt: string;
}

export interface HubTestSuiteRegistration {
  readonly suite: HubTestSuiteVersion;
  /** False when this exact version was already registered with the same definition. */
  readonly created: boolean;
}

export interface HubTestSuiteListResult {
  readonly items: readonly HubTestSuiteVersion[];
  readonly nextCursor?: string;
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
