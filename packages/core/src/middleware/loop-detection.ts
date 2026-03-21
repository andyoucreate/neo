import type { Middleware } from "@/types";

/**
 * Loop detection middleware.
 *
 * Tracks Bash commands per session. If the same command appears
 * `threshold` times, blocks it and tells the agent to escalate.
 *
 * Call `cleanup(sessionId)` when a session ends to prevent memory leaks.
 */
export interface LoopDetectionMiddleware extends Middleware {
  /** Remove all tracking data for a specific session. */
  cleanup: (sessionId: string) => void;
  /** Clear all tracking data across all sessions. */
  clearAll: () => void;
  /** Get the number of currently tracked sessions. */
  sessionCount: () => number;
}

/** Default TTL for session entries: 24 hours */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface SessionEntry {
  commands: Map<string, number>;
  createdAt: number;
}

export function loopDetection(options: {
  threshold: number;
  scope?: "session";
  /** TTL in milliseconds for automatic cleanup of stale entries. Defaults to 24 hours. */
  ttlMs?: number;
}): LoopDetectionMiddleware {
  const { threshold, ttlMs = DEFAULT_TTL_MS } = options;
  const sessionHistory = new Map<string, SessionEntry>();

  /**
   * Evict entries older than TTL.
   * Called lazily on each handler invocation to avoid timer overhead.
   */
  function evictStaleEntries(): void {
    const now = Date.now();
    for (const [sessionId, entry] of sessionHistory) {
      if (now - entry.createdAt > ttlMs) {
        sessionHistory.delete(sessionId);
      }
    }
  }

  return {
    name: "loop-detection",
    on: "PreToolUse",
    match: "Bash",
    cleanup(sessionId: string) {
      sessionHistory.delete(sessionId);
    },
    clearAll() {
      sessionHistory.clear();
    },
    sessionCount() {
      return sessionHistory.size;
    },
    async handler(event) {
      // Lazy eviction of stale entries
      evictStaleEntries();

      const sessionId = event.sessionId;
      const command =
        event.input && typeof event.input === "object" && "command" in event.input
          ? String(event.input.command)
          : "";

      if (!command) return { decision: "pass" };

      let entry = sessionHistory.get(sessionId);
      if (!entry) {
        entry = { commands: new Map(), createdAt: Date.now() };
        sessionHistory.set(sessionId, entry);
      }

      const count = (entry.commands.get(command) ?? 0) + 1;
      entry.commands.set(command, count);

      if (count >= threshold) {
        return {
          decision: "block",
          reason: `Loop detected: you have run this exact command ${String(count)} times. STOP and escalate — do not retry the same approach.`,
        };
      }

      return { decision: "pass" };
    },
  };
}
