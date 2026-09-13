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

/**
 * The first real `.exe` among `where.exe` output, which is what a launcher on
 * Windows will start: a `.cmd` shim cannot be spawned with `shell:false`, so
 * every integration resolves `<name>.exe` from PATH.
 *
 * Split out to be testable. The Windows branch of `defaultProbe` spawns real
 * processes and had no coverage at all, which is how "probe the shim, launch
 * the exe" survived until a machine turned up with two installs at different
 * versions.
 */
export function nativeWindowsTarget(whereOutput: string): string | undefined {
  return whereOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith(".exe"));
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
    // Prefer a real `.exe`, because that is what every launcher on Windows
    // starts: a `.cmd` shim cannot be spawned with `shell:false`, so all three
    // integrations resolve `<name>.exe` from PATH. Probing the shim instead
    // meant reporting the version of one install while launching another --
    // observed on 2026-09-13 with Claude Code 2.1.233 (npm shim) detected and
    // 2.1.201 (native exe) launched. The other two agreed only because their
    // shim and exe came from the same install.
    //
    // The path comes from `where.exe` and is spawned directly, which is what
    // the launchers already do with the same value.
    const exe = nativeWindowsTarget(located.stdout);
    if (exe) return execute(exe, args, timeoutMs);

    // No native target. The launcher will refuse, and the version reported here
    // is the shim's -- which is the only thing there is to report.
    // `executable` is validated against SAFE_EXECUTABLE and the arguments are
    // the integration's own constants, so nothing user-controlled is
    // interpolated into the command line.
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
