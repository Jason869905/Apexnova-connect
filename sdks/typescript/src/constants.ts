export const INTEGRATION_SCHEMA_VERSION = "1" as const;

export const INTEGRATION_STATUSES = [
  "research",
  "planned",
  "experimental",
  "stable",
  "deprecated",
] as const;

export const CORE_CATEGORIES = [
  "agent",
  "automation",
  "ide",
  "gateway",
  "chat-client",
  "other",
] as const;

export const CORE_DELIVERY_MODES = [
  "native-plugin",
  "provider-package",
  "config-adapter",
  "gateway-adapter",
  "launcher",
] as const;

export const CORE_PLATFORMS = ["windows", "macos", "linux", "web"] as const;

export const CORE_PROTOCOLS = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
] as const;

export const CORE_CAPABILITIES = [
  "authentication",
  "balance",
  "model-catalog",
  "provider-config",
  "gateway",
  "hot-switch",
  "restart-required",
  "backup-and-restore",
] as const;

export const CORE_PERMISSION_KINDS = [
  "filesystem-read",
  "filesystem-write",
  "network",
  "credential-store",
  "process-launch",
] as const;

