import type { ConcurrencyLimits } from "./types.js";

// ─── Concurrency limits ────────────────────────────────────────
export const CONCURRENCY_LIMITS: ConcurrencyLimits = {
  maxConcurrentSessions: 5,
  maxConcurrentPerProject: 2,
  queueMaxSize: 50,
  dispatchCooldownMs: 10_000, // 10s between dispatches
};

// ─── Server ────────────────────────────────────────────────────
export const SERVER_PORT = Number(process.env.DISPATCH_PORT) || 3001;
export const SERVER_HOST = process.env.DISPATCH_HOST || "127.0.0.1";

// ─── Paths ─────────────────────────────────────────────────────
export const COST_JOURNAL_DIR =
  process.env.COST_JOURNAL_DIR || "/opt/voltaire/costs";
export const EVENT_JOURNAL_PATH =
  process.env.EVENT_JOURNAL_PATH || "/opt/voltaire/events/journal.jsonl";
export const REPOS_BASE_DIR =
  process.env.REPOS_BASE_DIR || "/home/voltaire/repos";

// ─── Claude Code ───────────────────────────────────────────────
// npm install -g puts the binary at /usr/local/bin/claude on Ubuntu (NodeSource)
export const CLAUDE_CODE_PATH =
  process.env.CLAUDE_CODE_PATH || "/usr/local/bin/claude";

// ─── Recovery ──────────────────────────────────────────────────
export const MAX_RECOVERY_RETRIES = 3;
export const RECOVERY_BACKOFF_BASE_MS = 30_000;

// ─── Session watchdog ─────────────────────────────────────────
export const SESSION_INIT_TIMEOUT_MS =
  Number(process.env.SESSION_INIT_TIMEOUT_MS) || 120_000; // 2 min to get first SDK response
export const SESSION_MAX_DURATION_MS =
  Number(process.env.SESSION_MAX_DURATION_MS) || 30 * 60_000; // 30 min absolute safety net

// ─── CI polling ──────────────────────────────────────────────
export const CI_POLL_MAX_WAIT_MS =
  Number(process.env.CI_POLL_MAX_WAIT_MS) || 10 * 60_000; // 10 min max wait for CI

// ─── Loop detection ───────────────────────────────────────────
export const LOOP_DETECTION_THRESHOLD = 3; // block after N identical Bash commands

// ─── Budget guard ──────────────────────────────────────────────
export const DAILY_BUDGET_CAP_USD = Number(process.env.DAILY_BUDGET_CAP_USD) || 500;

// ─── Input sanitization ────────────────────────────────────────
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_CRITERIA_LENGTH = 2_000;
