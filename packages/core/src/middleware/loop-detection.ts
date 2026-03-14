import type { Middleware } from "../types.js";

/**
 * Loop detection middleware.
 *
 * Tracks Bash commands per session. If the same command appears
 * `threshold` times, blocks it and tells the agent to escalate.
 *
 * Call `cleanup(sessionId)` when a session ends to prevent memory leaks.
 */
export interface LoopDetectionMiddleware extends Middleware {
  cleanup: (sessionId: string) => void;
}

export function loopDetection(options: {
  threshold: number;
  scope?: "session";
}): LoopDetectionMiddleware {
  const { threshold } = options;
  const commandHistory = new Map<string, Map<string, number>>();

  return {
    name: "loop-detection",
    on: "PreToolUse",
    match: "Bash",
    cleanup(sessionId: string) {
      commandHistory.delete(sessionId);
    },
    async handler(event) {
      const sessionId = event.sessionId;
      const command =
        event.input && typeof event.input === "object" && "command" in event.input
          ? String(event.input.command)
          : "";

      if (!command) return { decision: "pass" };

      if (!commandHistory.has(sessionId)) {
        commandHistory.set(sessionId, new Map());
      }

      const sessionHistory = commandHistory.get(sessionId) ?? new Map<string, number>();
      const count = (sessionHistory.get(command) ?? 0) + 1;
      sessionHistory.set(command, count);

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
