import { describe, expect, it } from "vitest";
import { SessionError } from "@/runner/session";

/**
 * Tests for the post-session budget check logic.
 *
 * The actual budget check is in SessionExecutor.execute(), but we test
 * the comparison logic and error format here in isolation.
 */
describe("budget check logic", () => {
  // Helper to simulate the budget check logic from session-executor.ts
  function checkBudget(maxCost: number | undefined, sessionCost: number, sessionId: string): void {
    if (maxCost !== undefined && sessionCost >= maxCost) {
      throw new SessionError(
        `Agent session exceeded budget: $${sessionCost.toFixed(4)} >= $${maxCost.toFixed(4)} limit`,
        "budget_exceeded",
        sessionId,
      );
    }
  }

  it("throws budget_exceeded when cost equals maxCost", () => {
    expect(() => checkBudget(5.0, 5.0, "session-equal")).toThrow(SessionError);

    try {
      checkBudget(5.0, 5.0, "session-equal");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).errorType).toBe("budget_exceeded");
    }
  });

  it("throws budget_exceeded when cost exceeds maxCost", () => {
    expect(() => checkBudget(5.0, 5.5, "session-over")).toThrow(SessionError);

    try {
      checkBudget(5.0, 5.5, "session-over");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).errorType).toBe("budget_exceeded");
      expect((error as SessionError).sessionId).toBe("session-over");
      expect((error as SessionError).message).toContain("$5.5000");
      expect((error as SessionError).message).toContain("$5.0000");
    }
  });

  it("does not throw when cost is below maxCost", () => {
    expect(() => checkBudget(5.0, 4.99, "session-under")).not.toThrow();
  });

  it("does not throw when maxCost is undefined", () => {
    expect(() => checkBudget(undefined, 100.0, "session-no-limit")).not.toThrow();
  });

  it("throws when maxCost is 0 and cost is 0 (conservative >= check)", () => {
    expect(() => checkBudget(0, 0, "session-zero")).toThrow(SessionError);
  });

  it("throws for tiny costs that equal limit", () => {
    expect(() => checkBudget(0.0001, 0.0001, "session-tiny")).toThrow(SessionError);
  });

  it("error message formats cost with 4 decimal places", () => {
    try {
      checkBudget(1.5, 2.123456, "session-precision");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect((error as SessionError).message).toContain("$2.1235");
      expect((error as SessionError).message).toContain("$1.5000");
    }
  });
});

describe("budget_exceeded error properties", () => {
  it("SessionError has correct structure for budget_exceeded", () => {
    const error = new SessionError(
      "Agent session exceeded budget: $5.0000 >= $3.0000 limit",
      "budget_exceeded",
      "test-session-123",
    );

    expect(error.name).toBe("SessionError");
    expect(error.errorType).toBe("budget_exceeded");
    expect(error.sessionId).toBe("test-session-123");
    expect(error.message).toBe("Agent session exceeded budget: $5.0000 >= $3.0000 limit");
    expect(error instanceof Error).toBe(true);
  });
});
