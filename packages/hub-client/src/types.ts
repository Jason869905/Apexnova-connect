import type { SecretValue } from "@apexnova-connect/credential-store";

export interface DeviceAuthorization {
  readonly deviceCode: SecretValue;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
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
