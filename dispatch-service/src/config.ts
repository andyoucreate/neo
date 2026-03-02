import type { ConcurrencyLimits } from "./types.js";

// ─── Concurrency limits ────────────────────────────────────────
export const CONCURRENCY_LIMITS: ConcurrencyLimits = {
  maxConcurrentSessions: 5,
  maxConcurrentPerProject: 2,
  queueMaxSize: 50,
  sessionTimeoutMs: 3_600_000, // 60 min hard kill
  dispatchCooldownMs: 10_000, // 10s between dispatches
};

// ─── Server ────────────────────────────────────────────────────
export const SERVER_PORT = Number(process.env.DISPATCH_PORT) || 3001;
export const SERVER_HOST = process.env.DISPATCH_HOST || "127.0.0.1";

// ─── Paths ─────────────────────────────────────────────────────
export const COST_JOURNAL_DIR =
  process.env.COST_JOURNAL_DIR || "/opt/voltaire/costs";
export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || "/opt/voltaire/logs/audit.log";
export const EVENT_JOURNAL_PATH =
  process.env.EVENT_JOURNAL_PATH || "/opt/voltaire/events/journal.jsonl";

// ─── Recovery ──────────────────────────────────────────────────
export const MAX_RECOVERY_RETRIES = 3;
export const RECOVERY_BACKOFF_BASE_MS = 30_000;

// ─── Rate limits ───────────────────────────────────────────────
export const RATE_LIMIT_WARNING_THRESHOLD = 0.8;
export const RATE_LIMIT_BACKOFF_MS = [60_000, 120_000, 300_000] as const;

// ─── Input sanitization ────────────────────────────────────────
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_CRITERIA_LENGTH = 2_000;
export const QUARANTINE_LENGTH_MULTIPLIER = 3;
