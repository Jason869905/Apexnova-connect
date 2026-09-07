export type HubClientErrorCode =
  | "INVALID_CONFIG"
  | "HUB_NOT_CONFIGURED"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "OAUTH_ERROR"
  | "ACCESS_DENIED"
  | "DEVICE_CODE_EXPIRED"
  | "SESSION_NOT_FOUND"
  | "SESSION_CORRUPT"
  | "REFRESH_TOKEN_MISSING"
  | "UNAUTHENTICATED"
  | "INSUFFICIENT_SCOPE"
  | "KEY_TTL_POLICY"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "BILLING_BLOCKED"
  | "API_ERROR";

export class HubClientError extends Error {
  readonly code: HubClientErrorCode;
  readonly oauthError?: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    code: HubClientErrorCode,
    message: string,
    options: ErrorOptions & {
      readonly oauthError?: string;
      readonly requestId?: string;
      readonly retryable?: boolean;
      readonly retryAfterSeconds?: number;
    } = {},
  ) {
    super(message, options);
    this.name = "HubClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.oauthError !== undefined) this.oauthError = options.oauthError;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
