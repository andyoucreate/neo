import { type SpawnOptions, spawn } from "node:child_process";

/**
 * Result of a successful spawn operation.
 */
export interface SpawnSuccess {
  pid: number;
  error?: undefined;
}

/**
 * Result of a failed spawn operation.
 */
export interface SpawnError {
  pid: 0;
  error: string;
}

export type SpawnResult = SpawnSuccess | SpawnError;

export interface SpawnWithConfirmationOptions {
  /**
   * Timeout in milliseconds before giving up on spawn confirmation.
   * Defaults to 1000ms.
   */
  timeoutMs?: number;
  /**
   * Additional spawn options passed to child_process.spawn().
   * Note: `detached` and `env` are set by default but can be overridden.
   */
  spawnOptions?: SpawnOptions;
  /**
   * Callback invoked when spawn completes (success, error, or timeout).
   * Use this for cleanup tasks like closing file descriptors.
   * Called before the promise resolves.
   */
  onComplete?: () => void;
}

/**
 * Spawn a child process with confirmation handling.
 *
 * This helper encapsulates the pattern of:
 * 1. Attaching error/spawn handlers before unref()
 * 2. Waiting for 'spawn' event to confirm the process started
 * 3. Calling unref() only after handlers are attached
 * 4. Resolving with PID only after spawn confirmation
 *
 * This pattern prevents "ghost runs" where spawn fails silently because:
 * - Error handlers are attached BEFORE unref(), so errors are captured
 * - PID is only returned AFTER spawn confirmation, ensuring the process exists
 *
 * @param command - The command to spawn (usually process.execPath for Node scripts)
 * @param args - Arguments to pass to the command
 * @param options - Configuration options
 * @returns Promise resolving to SpawnSuccess with PID, or SpawnError with message
 */
export function spawnWithConfirmation(
  command: string,
  args: readonly string[],
  options: SpawnWithConfirmationOptions = {},
): Promise<SpawnResult> {
  const { timeoutMs = 1000, spawnOptions = {}, onComplete } = options;

  return new Promise((resolve) => {
    let resolved = false;

    const safeResolve = (result: SpawnResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // Clean up event listeners to prevent memory leaks
      child.removeAllListeners();
      onComplete?.();
      resolve(result);
    };

    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
      ...spawnOptions,
    });

    // Capture spawn errors before unref() - these would otherwise be silently discarded
    child.on("error", (err) => {
      safeResolve({ pid: 0, error: err.message });
    });

    // Wait for 'spawn' event to confirm process started successfully
    child.on("spawn", () => {
      child.unref();

      if (child.pid) {
        safeResolve({ pid: child.pid });
      } else {
        safeResolve({ pid: 0, error: "Spawn succeeded but no PID assigned" });
      }
    });

    // Safety timeout in case neither event fires (shouldn't happen)
    const timer = setTimeout(() => {
      child.unref();
      if (child.pid) {
        safeResolve({ pid: child.pid });
      } else {
        safeResolve({ pid: 0, error: "Spawn timeout - no PID available" });
      }
    }, timeoutMs);
  });
}
