import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { FailureReport } from "./schemas.js";

type ErrorType = FailureReport["lastErrorType"];

/**
 * Build a suggested action based on the error type and reason.
 */
export function buildSuggestedAction(errorType: ErrorType, _reason: string): string {
  switch (errorType) {
    case "spawn_error":
      return "Check that all dependencies are installed. Run: pnpm install";

    case "timeout":
      return "Consider increasing the timeout limit or breaking the task into smaller steps.";

    case "budget":
      return "Review budget allocation. Consider increasing limits or optimizing token usage.";

    case "recovery_exhausted":
      return "All recovery attempts failed. Try a fresh session with simplified instructions.";

    default:
      return "Review the error details and consider manual intervention.";
  }
}

/**
 * Classify an error message into an error type.
 */
export function classifyError(reason: string): ErrorType {
  const lower = reason.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "timeout";
  }
  // Check recovery_exhausted before budget to avoid "exceeded" matching budget
  if (
    lower.includes("recovery") ||
    lower.includes("max retries") ||
    lower.includes("retries exceeded")
  ) {
    return "recovery_exhausted";
  }
  if (
    lower.includes("budget") ||
    lower.includes("cost exceeded") ||
    lower.includes("budget exceeded")
  ) {
    return "budget";
  }
  if (lower.includes("spawn") || lower.includes("module") || lower.includes("not found")) {
    return "spawn_error";
  }

  return "unknown";
}

/**
 * Write a structured failure report to inbox.jsonl.
 * This surfaces the failure as an actionable item in the supervisor prompt.
 */
export async function writeFailureReport(
  supervisorDir: string,
  report: Omit<FailureReport, "timestamp">,
): Promise<void> {
  const entry: FailureReport = {
    ...report,
    timestamp: new Date().toISOString(),
  };

  const inboxPath = path.join(supervisorDir, "inbox.jsonl");

  try {
    await appendFile(inboxPath, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error) {
    // Best-effort: log but don't throw
    console.debug(
      `[failure-report] Failed to write: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Create a failure report from run completion data.
 */
export function createFailureReport(opts: {
  runId: string;
  task: string;
  reason: string;
  attemptCount: number;
  costUsd: number;
}): Omit<FailureReport, "timestamp"> {
  const errorType = classifyError(opts.reason);
  const suggestedAction = buildSuggestedAction(errorType, opts.reason);

  return {
    type: "failure-report",
    runId: opts.runId,
    task: opts.task,
    reason: opts.reason.slice(0, 500),
    attemptCount: opts.attemptCount,
    lastErrorType: errorType,
    suggestedAction,
    costUsd: opts.costUsd,
  };
}
