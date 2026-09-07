import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Release bundles replace this at build time from apps/cli/package.json, which is
// the single source of truth for the CLI version. Source builds fall back to
// reading that same manifest, so the two paths can never disagree.
declare const __APEXNOVA_VERSION__: string | undefined;

function injectedVersion(): string | undefined {
  if (typeof __APEXNOVA_VERSION__ !== "string") return undefined;
  return __APEXNOVA_VERSION__ === "" ? undefined : __APEXNOVA_VERSION__;
}

function manifestVersion(): string | undefined {
  try {
    // Both src/version.ts and dist/version.js sit one level below apps/cli.
    const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version ? version : undefined;
  } catch {
    return undefined;
  }
}

export const CLI_VERSION: string = injectedVersion() ?? manifestVersion() ?? "0.0.0-dev";
