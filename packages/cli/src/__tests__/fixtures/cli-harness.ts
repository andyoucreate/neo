import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Options for running the CLI
 */
export interface RunCliOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Working directory for the CLI process */
  cwd?: string;
  /** Environment variables to pass to the CLI process */
  env?: Record<string, string>;
}

/**
 * Result from running the CLI
 */
export interface RunCliResult {
  /** Standard output from the CLI */
  stdout: string;
  /** Standard error from the CLI */
  stderr: string;
  /** Exit code from the CLI process */
  exitCode: number;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Spawns the neo CLI with the given arguments and returns the result.
 *
 * @param args - Command line arguments to pass to the CLI
 * @param options - Optional configuration for the CLI process
 * @returns Promise resolving to stdout, stderr, and exitCode
 */
export function runCli(args: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  const { timeout = DEFAULT_TIMEOUT, cwd, env } = options;

  // Path to the CLI entry point (dist/index.js after build)
  const cliPath = path.resolve(import.meta.dirname, "..", "..", "..", "dist", "index.js");

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn("node", [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let killed = false;

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");

        // Force kill after 1 second if SIGTERM doesn't work
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 1000);
      }, timeout);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      if (killed) {
        resolve({
          stdout,
          stderr,
          exitCode: signal === "SIGKILL" ? 137 : 143,
        });
        return;
      }

      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}
