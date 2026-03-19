import { z } from "zod";

// ─── Schemas ─────────────────────────────────────────────

export const idleDetectorConfigSchema = z.object({
  idleSkipMax: z.number(),
  activeWorkSkipMax: z.number(),
});

export const idleContextSchema = z.object({
  eventCount: z.number(),
  activeRuns: z.number(),
  hasPendingConsolidation: z.boolean(),
  hasExpiredDecisions: z.boolean(),
  timeSinceLastHeartbeatMs: z.number(),
  idleSkipCount: z.number(),
  activeWorkSkipCount: z.number(),
});

export const skipResultSchema = z.object({
  shouldSkip: z.boolean(),
  reason: z.string(),
});

// ─── Types ───────────────────────────────────────────────

export type IdleDetectorConfig = z.infer<typeof idleDetectorConfigSchema>;
export type IdleContext = z.infer<typeof idleContextSchema>;
export type SkipResult = z.infer<typeof skipResultSchema>;

// ─── Detector ────────────────────────────────────────────

/**
 * Determines whether a supervisor heartbeat cycle should be skipped.
 * Extracts skip logic into a testable, single-responsibility class.
 */
export class IdleDetector {
  private readonly config: IdleDetectorConfig;

  constructor(config: IdleDetectorConfig) {
    this.config = config;
  }

  /**
   * Evaluate whether the current heartbeat should be skipped.
   * @returns SkipResult with shouldSkip flag and reason
   */
  shouldSkip(context: IdleContext): SkipResult {
    // Events pending — must process
    if (context.eventCount > 0) {
      return { shouldSkip: false, reason: "events pending" };
    }

    // Consolidation waiting — must process
    if (context.hasPendingConsolidation) {
      return { shouldSkip: false, reason: "pending consolidation" };
    }

    // Expired decisions — must process
    if (context.hasExpiredDecisions) {
      return { shouldSkip: false, reason: "expired decisions" };
    }

    // Active runs — check threshold
    if (context.activeRuns > 0) {
      if (context.activeWorkSkipCount >= this.config.activeWorkSkipMax) {
        return { shouldSkip: false, reason: "active work skip threshold exceeded" };
      }
      return { shouldSkip: true, reason: "active runs, within threshold" };
    }

    // Idle — check threshold
    if (context.idleSkipCount >= this.config.idleSkipMax) {
      return { shouldSkip: false, reason: "idle skip threshold exceeded" };
    }

    return { shouldSkip: true, reason: "idle, within threshold" };
  }
}
