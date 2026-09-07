import { AgentIntegrationError } from "./agent.js";
import type { ProtocolId } from "./types.js";

/**
 * The Hub catalog publishes a full protocol endpoint, such as
 * `https://api.example.com/v1/responses`. Target products want the root the
 * client appends its own operation path to, which differs per protocol:
 * OpenAI clients append `/responses` or `/chat/completions` to a `/v1` root,
 * while an Anthropic client appends the whole `/v1/messages`.
 */
export function protocolRootUrl(endpoint: string, protocol: ProtocolId): string {
  const url = new URL(endpoint);
  const suffix =
    protocol === "openai-responses"
      ? "/responses"
      : protocol === "openai-chat-completions"
        ? "/chat/completions"
        : protocol === "anthropic-messages"
          ? "/v1/messages"
          : "";
  if (suffix && url.pathname.endsWith(suffix)) {
    url.pathname = url.pathname.slice(0, -suffix.length);
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * Every integration writes a Hub base URL into a third-party configuration
 * file, so they all need the same guarantee: HTTPS, and no credentials, query
 * or fragment that could leak through a config file or a log. Plain-HTTP
 * loopback is allowed only when a caller explicitly opts in for local
 * development.
 */
export function assertSafeBaseUrl(
  value: string,
  options: { readonly allowInsecureLoopback?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentIntegrationError(
      "INVALID_INPUT",
      "Apexnova AI Hub base URL must be a valid HTTPS URL.",
    );
  }

  const insecureLoopback =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !(options.allowInsecureLoopback && insecureLoopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new AgentIntegrationError(
      "INVALID_INPUT",
      "Apexnova AI Hub base URL must use HTTPS and contain no credentials, query, or fragment.",
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}
