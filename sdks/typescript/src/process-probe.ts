import { execFile } from "node:child_process";

import type { Platform } from "./types.js";

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SAFE_EXECUTABLE = /^[a-z0-9][a-z0-9-]*$/;
// A leading `v` is part of the version, not a word boundary: Hermes prints
// "Hermes Agent v0.21.0 (2026.8.31)", where a \b-anchored pattern skips the
// real version and matches the build date instead.
const SEMANTIC_VERSION =
  /(?<![0-9A-Za-z.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

export interface CommandProbeResult {
  readonly found: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

export type CommandProbe = () => Promise<CommandProbeResult>;

export interface ProbeExecutableOptions {
  /** Bare command name, resolved through PATH. Must be `[a-z0-9][a-z0-9-]*`. */
  readonly executable: string;
  readonly displayName: string;
  readonly args?: readonly string[];
  readonly platform: Platform;
  readonly timeoutMs?: number;
  /** Injection point for tests; skips every real process launch. */
  readonly run?: CommandProbe;
}

export interface ExecutableProbe {
  readonly found: boolean;
  readonly version?: string;
  readonly evidence: readonly string[];
  readonly warnings: readonly string[];
}

/** Node's `process.platform` values mapped onto the manifest vocabulary. */
export function toPlatform(nodePlatform: string): Platform | undefined {
  if (nodePlatform === "win32") return "windows";
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "linux") return "linux";
  return undefined;
}

function execute(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandProbeResult> {
  return new Promise<CommandProbeResult>((resolve) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ found: true, stdout, stderr });
          return;
        }
        const code = "code" in error ? error.code : undefined;
        if (code === "ENOENT") {
          resolve({ found: false });
          return;
        }
        resolve({ found: true, stdout, stderr, error: error.message });
      },
    );
  });
}

function defaultProbe(
  executable: string,
  args: readonly string[],
  platform: Platform,
  timeoutMs: number,
): Promise<CommandProbeResult> {
  if (platform !== "windows") return execute(executable, args, timeoutMs);

  return execute("where.exe", [executable], timeoutMs).then((located) => {
    if (!located.found || located.error || !located.stdout?.trim()) {
      return { found: false };
    }
    // `.cmd` shims need cmd.exe on Windows. `executable` is validated against
    // SAFE_EXECUTABLE and the arguments are the integration's own constants, so
    // nothing user-controlled is interpolated into the command line.
    return execute(
      "cmd.exe",
      ["/d", "/s", "/c", `${executable}.cmd ${args.join(" ")}`],
      timeoutMs,
    );
  });
}

/**
 * Asks an installed CLI for its version. A missing executable is a normal
 * result, not an error: detection has to work on machines where the product was
 * never installed.
 */
export async function probeExecutableVersion(
  options: ProbeExecutableOptions,
): Promise<ExecutableProbe> {
  if (!SAFE_EXECUTABLE.test(options.executable)) {
    throw new TypeError(
      `Executable name ${options.executable} is not a safe bare command name.`,
    );
  }
  const args = options.args ?? ["--version"];
  for (const argument of args) {
    if (!/^[A-Za-z0-9._=-]+$/.test(argument)) {
      throw new TypeError(`Version probe argument ${argument} is not safe.`);
    }
  }

  const result = await (options.run ??
    (() =>
      defaultProbe(
        options.executable,
        args,
        options.platform,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )))();

  // A command that failed prints whatever it likes -- a broken Codex install
  // emits a Node.js crash banner, whose "Node.js v22.23.1" would otherwise be
  // recorded as the product version and then checked against the manifest
  // range. An untrustworthy output yields no version at all.
  const output = result.error
    ? ""
    : `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const version = output.match(SEMANTIC_VERSION)?.[1];
  const evidence: string[] = [];
  const warnings: string[] = [];

  if (result.found) {
    evidence.push(`${options.executable} executable responded to ${args.join(" ")}`);
  }
  if (result.error) {
    warnings.push(
      `The ${options.displayName} executable was found but its version command did not complete successfully.`,
    );
  } else if (result.found && !version) {
    warnings.push(
      `The ${options.displayName} executable did not return a recognizable semantic version.`,
    );
  }

  return {
    found: result.found,
    ...(version ? { version } : {}),
    evidence,
    warnings,
  };
}
