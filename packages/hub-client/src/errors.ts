export type HubClientErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "OAUTH_ERROR"
  | "ACCESS_DENIED"
  | "DEVICE_CODE_EXPIRED"
  | "SESSION_NOT_FOUND"
  | "SESSION_CORRUPT"
  | "REFRESH_TOKEN_MISSING";

export class HubClientError extends Error {
  readonly code: HubClientErrorCode;
  readonly oauthError?: string;

  constructor(
    code: HubClientErrorCode,
    message: string,
    options: ErrorOptions & { readonly oauthError?: string } = {},
  ) {
    super(message, options);
    this.name = "HubClientError";
    this.code = code;
    if (options.oauthError !== undefined) this.oauthError = options.oauthError;
  }
}
