import { execFile } from "node:child_process";

/**
 * Determine if notifications should be sent.
 * Only notify in daemon/detached mode (when stdout is not a TTY).
 */
export function shouldNotify(isTTY: boolean): boolean {
  return !isTTY;
}

/**
 * Send a macOS notification using osascript.
 * Also prints terminal bell to daemon.log.
 *
 * Best-effort: silently catches all errors to never crash the daemon.
 */
export async function notify(title: string, message: string): Promise<void> {
  // Print terminal bell to daemon.log (visible in log file)
  process.stdout.write("\x07");

  // macOS notification via osascript
  const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;

  return new Promise((resolve) => {
    try {
      const child = execFile("osascript", ["-e", script], (error) => {
        if (error) {
          // Best-effort: silently ignore errors (e.g., not on macOS)
          console.debug(`[notify] osascript failed: ${error.message}`);
        }
        resolve();
      });
      child.unref();
    } catch {
      // Best-effort: silently ignore errors
      resolve();
    }
  });
}

/**
 * Send a success notification for run completion.
 */
export async function notifyRunComplete(runId: string, summary: string): Promise<void> {
  await notify("Neo ✓", `${runId}: ${summary.slice(0, 100)}`);
}

/**
 * Send a failure notification for run failure.
 */
export async function notifyRunFailed(runId: string, reason: string): Promise<void> {
  await notify("Neo ✗", `${runId}: ${reason.slice(0, 100)}`);
}

/**
 * Escape special characters for AppleScript string literals.
 */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
