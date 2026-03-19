import { describe, expect, it } from "vitest";
import { type IdleContext, IdleDetector } from "@/supervisor/idle-detector";

// ─── Helpers ─────────────────────────────────────────────

function createContext(overrides: Partial<IdleContext> = {}): IdleContext {
  return {
    eventCount: 0,
    activeRuns: 0,
    hasPendingConsolidation: false,
    hasExpiredDecisions: false,
    timeSinceLastHeartbeatMs: 0,
    idleSkipCount: 0,
    activeWorkSkipCount: 0,
    ...overrides,
  };
}

// ─── IdleDetector ────────────────────────────────────────

describe("IdleDetector", () => {
  const defaultConfig = { idleSkipMax: 3, activeWorkSkipMax: 1 };

  describe("shouldSkip", () => {
    // ─── Must process conditions ───────────────────────────

    it("returns skip=false when eventCount > 0", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ eventCount: 1 });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("events pending");
    });

    it("returns skip=false when hasPendingConsolidation=true", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ hasPendingConsolidation: true });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("pending consolidation");
    });

    it("returns skip=false when hasExpiredDecisions=true", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ hasExpiredDecisions: true });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("expired decisions");
    });

    // ─── Active runs threshold ─────────────────────────────

    it("returns skip=true when activeRuns > 0 and within activeWorkSkipMax threshold", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ activeRuns: 2, activeWorkSkipCount: 0 });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toBe("active runs, within threshold");
    });

    it("returns skip=false when activeRuns > 0 and activeWorkSkipCount >= activeWorkSkipMax", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ activeRuns: 2, activeWorkSkipCount: 1 });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("active work skip threshold exceeded");
    });

    it("returns skip=false when activeWorkSkipCount exceeds activeWorkSkipMax", () => {
      const detector = new IdleDetector({ idleSkipMax: 3, activeWorkSkipMax: 2 });
      const context = createContext({ activeRuns: 1, activeWorkSkipCount: 3 });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("active work skip threshold exceeded");
    });

    // ─── Idle threshold ────────────────────────────────────

    it("returns skip=true when idle and within idleSkipMax threshold", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ idleSkipCount: 2 });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toBe("idle, within threshold");
    });

    it("returns skip=false when idleSkipCount >= idleSkipMax", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ idleSkipCount: 3 });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("idle skip threshold exceeded");
    });

    it("returns skip=false when idleSkipCount exceeds idleSkipMax", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ idleSkipCount: 5 });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("idle skip threshold exceeded");
    });

    // ─── Priority order ────────────────────────────────────

    it("prioritizes events over active runs check", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({
        eventCount: 1,
        activeRuns: 2,
        activeWorkSkipCount: 0,
      });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("events pending");
    });

    it("prioritizes hasPendingConsolidation over active runs check", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({
        hasPendingConsolidation: true,
        activeRuns: 2,
      });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("pending consolidation");
    });

    it("prioritizes hasExpiredDecisions over active runs check", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({
        hasExpiredDecisions: true,
        activeRuns: 2,
      });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("expired decisions");
    });

    it("checks active runs before idle threshold", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({
        activeRuns: 1,
        activeWorkSkipCount: 0,
        idleSkipCount: 5,
      });

      const result = detector.shouldSkip(context);

      // Active runs path should be taken, not idle path
      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toBe("active runs, within threshold");
    });
  });

  describe("configuration", () => {
    it("respects custom idleSkipMax", () => {
      const detector = new IdleDetector({ idleSkipMax: 5, activeWorkSkipMax: 1 });

      // Count 4 should still skip
      expect(detector.shouldSkip(createContext({ idleSkipCount: 4 })).shouldSkip).toBe(true);

      // Count 5 should NOT skip
      expect(detector.shouldSkip(createContext({ idleSkipCount: 5 })).shouldSkip).toBe(false);
    });

    it("respects custom activeWorkSkipMax", () => {
      const detector = new IdleDetector({ idleSkipMax: 3, activeWorkSkipMax: 3 });

      // Count 2 should still skip
      expect(
        detector.shouldSkip(createContext({ activeRuns: 1, activeWorkSkipCount: 2 })).shouldSkip,
      ).toBe(true);

      // Count 3 should NOT skip
      expect(
        detector.shouldSkip(createContext({ activeRuns: 1, activeWorkSkipCount: 3 })).shouldSkip,
      ).toBe(false);
    });

    it("handles zero thresholds", () => {
      const detector = new IdleDetector({ idleSkipMax: 0, activeWorkSkipMax: 0 });

      // With idleSkipMax=0, should never skip in idle state
      expect(detector.shouldSkip(createContext({ idleSkipCount: 0 })).shouldSkip).toBe(false);

      // With activeWorkSkipMax=0, should never skip with active runs
      expect(
        detector.shouldSkip(createContext({ activeRuns: 1, activeWorkSkipCount: 0 })).shouldSkip,
      ).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles all conditions false", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext();

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toBe("idle, within threshold");
    });

    it("handles multiple events", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ eventCount: 100 });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBe("events pending");
    });

    it("handles multiple active runs", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ activeRuns: 10, activeWorkSkipCount: 0 });

      const result = detector.shouldSkip(context);

      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toBe("active runs, within threshold");
    });

    it("ignores timeSinceLastHeartbeatMs in skip decision", () => {
      const detector = new IdleDetector(defaultConfig);
      const context = createContext({ timeSinceLastHeartbeatMs: 999999 });

      const result = detector.shouldSkip(context);

      // timeSinceLastHeartbeatMs is not used in the current implementation
      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toBe("idle, within threshold");
    });

    it("handles boundary values for idleSkipCount", () => {
      const detector = new IdleDetector({ idleSkipMax: 3, activeWorkSkipMax: 1 });

      // Exactly at boundary - 1
      expect(detector.shouldSkip(createContext({ idleSkipCount: 2 })).shouldSkip).toBe(true);

      // Exactly at boundary
      expect(detector.shouldSkip(createContext({ idleSkipCount: 3 })).shouldSkip).toBe(false);
    });

    it("handles boundary values for activeWorkSkipCount", () => {
      const detector = new IdleDetector({ idleSkipMax: 3, activeWorkSkipMax: 2 });

      // Exactly at boundary - 1
      expect(
        detector.shouldSkip(createContext({ activeRuns: 1, activeWorkSkipCount: 1 })).shouldSkip,
      ).toBe(true);

      // Exactly at boundary
      expect(
        detector.shouldSkip(createContext({ activeRuns: 1, activeWorkSkipCount: 2 })).shouldSkip,
      ).toBe(false);
    });
  });

  describe("reason strings", () => {
    it("provides descriptive reason for events pending", () => {
      const detector = new IdleDetector(defaultConfig);
      const result = detector.shouldSkip(createContext({ eventCount: 1 }));

      expect(result.reason).toBe("events pending");
    });

    it("provides descriptive reason for pending consolidation", () => {
      const detector = new IdleDetector(defaultConfig);
      const result = detector.shouldSkip(createContext({ hasPendingConsolidation: true }));

      expect(result.reason).toBe("pending consolidation");
    });

    it("provides descriptive reason for expired decisions", () => {
      const detector = new IdleDetector(defaultConfig);
      const result = detector.shouldSkip(createContext({ hasExpiredDecisions: true }));

      expect(result.reason).toBe("expired decisions");
    });

    it("provides descriptive reason for active work skip threshold exceeded", () => {
      const detector = new IdleDetector(defaultConfig);
      const result = detector.shouldSkip(createContext({ activeRuns: 1, activeWorkSkipCount: 1 }));

      expect(result.reason).toBe("active work skip threshold exceeded");
    });

    it("provides descriptive reason for active runs within threshold", () => {
      const detector = new IdleDetector(defaultConfig);
      const result = detector.shouldSkip(createContext({ activeRuns: 1, activeWorkSkipCount: 0 }));

      expect(result.reason).toBe("active runs, within threshold");
    });

    it("provides descriptive reason for idle skip threshold exceeded", () => {
      const detector = new IdleDetector(defaultConfig);
      const result = detector.shouldSkip(createContext({ idleSkipCount: 3 }));

      expect(result.reason).toBe("idle skip threshold exceeded");
    });

    it("provides descriptive reason for idle within threshold", () => {
      const detector = new IdleDetector(defaultConfig);
      const result = detector.shouldSkip(createContext({ idleSkipCount: 0 }));

      expect(result.reason).toBe("idle, within threshold");
    });
  });
});
