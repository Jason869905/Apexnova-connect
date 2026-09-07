import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Release bundles inject the production Hub endpoint here. Source builds leave
// these undefined on purpose: a development checkout must never reach production
// implicitly, so it keeps requiring an explicit environment or config file value.
declare const __APEXNOVA_DEFAULT_HUB_BASE_URL__: string | undefined;
declare const __APEXNOVA_DEFAULT_OAUTH_CLIENT_ID__: string | undefined;

export type HubConfigSource = "environment" | "config-file" | "built-in";

export interface HubEndpointConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly pathPrefix?: string;
  readonly source: HubConfigSource;
}

export interface HubConfigContext {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

export interface StoredHubConfig {
  readonly hubBaseUrl?: string;
  readonly oauthClientId?: string;
  readonly pathPrefix?: string;
}

function builtIn(value: string | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function builtInBaseUrl(): string | undefined {
  return typeof __APEXNOVA_DEFAULT_HUB_BASE_URL__ === "string"
    ? builtIn(__APEXNOVA_DEFAULT_HUB_BASE_URL__)
    : undefined;
}

function builtInClientId(): string | undefined {
  return typeof __APEXNOVA_DEFAULT_OAUTH_CLIENT_ID__ === "string"
    ? builtIn(__APEXNOVA_DEFAULT_OAUTH_CLIENT_ID__)
    : undefined;
}

export function hubConfigPath(context: HubConfigContext = {}): string {
  const environment = context.environment ?? process.env;
  const platform = context.platform ?? process.platform;
  const home = context.homeDirectory ?? environment.USERPROFILE ?? environment.HOME ?? process.cwd();
  if (platform === "win32") {
    return resolve(environment.APPDATA ?? join(home, "AppData", "Roaming"), "Apexnova", "connect", "config.json");
  }
  return resolve(environment.XDG_CONFIG_HOME ?? join(home, ".config"), "apexnova-connect", "config.json");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function readHubConfigFile(context: HubConfigContext = {}): StoredHubConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(hubConfigPath(context), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt file must not brick every command; explicit env values still win,
    // and `apexnova init` rewrites it.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const item = parsed as Record<string, unknown>;
  const hubBaseUrl = optionalString(item.hubBaseUrl);
  const oauthClientId = optionalString(item.oauthClientId);
  const pathPrefix = optionalString(item.pathPrefix);
  return {
    ...(hubBaseUrl ? { hubBaseUrl } : {}),
    ...(oauthClientId ? { oauthClientId } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
  };
}

/**
 * Resolves the Hub endpoint from, in order of precedence: environment variables,
 * the user config file, and the values baked into a release bundle. Returns
 * undefined when no source supplies both a base URL and a client ID.
 */
export function resolveHubConfig(context: HubConfigContext = {}): HubEndpointConfig | undefined {
  const environment = context.environment ?? process.env;
  const stored = readHubConfigFile(context);
  const envBaseUrl = optionalString(environment.APEXNOVA_HUB_BASE_URL);
  const envClientId = optionalString(environment.APEXNOVA_OAUTH_CLIENT_ID);
  const envPathPrefix = optionalString(environment.APEXNOVA_HUB_PATH_PREFIX);

  const baseUrl = envBaseUrl ?? stored?.hubBaseUrl ?? builtInBaseUrl();
  const clientId = envClientId ?? stored?.oauthClientId ?? builtInClientId();
  if (!baseUrl || !clientId) return undefined;
  const pathPrefix = envPathPrefix ?? stored?.pathPrefix;

  const source: HubConfigSource = envBaseUrl || envClientId
    ? "environment"
    : stored?.hubBaseUrl || stored?.oauthClientId
      ? "config-file"
      : "built-in";

  return { baseUrl, clientId, ...(pathPrefix ? { pathPrefix } : {}), source };
}

export function hubConfigDefaults(): { readonly baseUrl?: string; readonly clientId?: string } {
  const baseUrl = builtInBaseUrl();
  const clientId = builtInClientId();
  return { ...(baseUrl ? { baseUrl } : {}), ...(clientId ? { clientId } : {}) };
}

export function writeHubConfigFile(context: HubConfigContext, config: StoredHubConfig): string {
  const path = hubConfigPath(context);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = {
    version: 1,
    ...(config.hubBaseUrl ? { hubBaseUrl: config.hubBaseUrl } : {}),
    ...(config.oauthClientId ? { oauthClientId: config.oauthClientId } : {}),
    ...(config.pathPrefix ? { pathPrefix: config.pathPrefix } : {}),
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}
