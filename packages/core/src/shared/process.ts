/**
 * Checks whether a process with the given PID is currently running.
 *
 * Uses the POSIX signal 0 trick: `process.kill(pid, 0)` doesn't actually
 * send a signal but checks whether the process exists and the current
 * process has permission to signal it. If the process doesn't exist,
 * an ESRCH error is thrown.
 *
 * @param pid - The process ID to check. Must be a positive integer.
 * @returns `true` if the process is alive and accessible, `false` otherwise.
 *
 * @example
 * ```ts
 * import { isProcessAlive } from "@/shared/process";
 *
 * // Check if current process is alive (always true)
 * isProcessAlive(process.pid); // => true
 *
 * // Check if a non-existent process is alive
 * isProcessAlive(999999); // => false
 * ```
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
