import { spawn } from "node:child_process";

export interface CommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export class CommandRunnerError extends Error {
  readonly kind: "not-found" | "timeout" | "output-limit" | "spawn-failed";

  constructor(
    kind: CommandRunnerError["kind"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommandRunnerError";
    this.kind = kind;
  }
}

const MAX_OUTPUT_BYTES = 128 * 1024;

export class SpawnCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(error);
      };

      const capture = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          finishReject(
            new CommandRunnerError(
              "output-limit",
              `Credential helper exceeded the ${MAX_OUTPUT_BYTES}-byte output limit.`,
            ),
          );
          return;
        }
        target.push(chunk);
      };

      const timer = setTimeout(() => {
        finishReject(
          new CommandRunnerError("timeout", "Credential helper timed out."),
        );
      }, request.timeoutMs ?? 30_000);

      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.on("error", (cause: NodeJS.ErrnoException) => {
        finishReject(
          new CommandRunnerError(
            cause.code === "ENOENT" ? "not-found" : "spawn-failed",
            `Credential helper could not be started: ${request.executable}.`,
            { cause },
          ),
        );
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });

      child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EPIPE") {
          finishReject(
            new CommandRunnerError(
              "spawn-failed",
              "Credential helper stdin failed.",
              { cause },
            ),
          );
        }
      });
      child.stdin.end(request.stdin ?? "");
    });
  }
}
