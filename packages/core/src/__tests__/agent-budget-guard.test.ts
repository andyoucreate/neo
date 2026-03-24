import { describe, expect, it } from "vitest";
import { agentBudgetGuard } from "@/middleware/agent-budget-guard";
import { buildMiddlewareChain } from "@/middleware/chain";
import type { MiddlewareContext, MiddlewareEvent } from "@/types";

// ─── Helpers ───────────────────────────────────────────

function makeContext(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  const store = new Map<string, unknown>();
  return {
    runId: "run-1",
    step: "step-1",
    agent: "test-agent",
    repo: "/tmp/repo",
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    ...overrides,
  };
}

function makeEvent(overrides?: Partial<MiddlewareEvent>): MiddlewareEvent {
  return {
    hookEvent: "PreToolUse",
    sessionId: "session-1",
    toolName: "Bash",
    input: { command: "ls" },
    ...overrides,
  };
}

// ─── Agent Budget Guard ────────────────────────────────

describe("agentBudgetGuard", () => {
  describe("cost tracking", () => {
    it("initializes estimatedCost to 0 on first tool use", async () => {
      const mw = agentBudgetGuard({ maxCost: 10.0, model: "sonnet" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      await chain.execute(makeEvent(), ctx);

      // After first tool use, cost should be 0.05 (sonnet)
      expect(ctx.get("estimatedCost")).toBe(0.05);
    });

    it("accumulates cost across multiple tool uses", async () => {
      const mw = agentBudgetGuard({ maxCost: 10.0, model: "sonnet" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      // First tool use: 0.05
      await chain.execute(makeEvent(), ctx);
      expect(ctx.get("estimatedCost")).toBe(0.05);

      // Second tool use: 0.10
      await chain.execute(makeEvent(), ctx);
      expect(ctx.get("estimatedCost")).toBe(0.1);

      // Third tool use: 0.15
      await chain.execute(makeEvent(), ctx);
      expect(ctx.get("estimatedCost")).toBeCloseTo(0.15, 5);
    });

    it("tracks cost for opus model ($0.15 per turn)", async () => {
      const mw = agentBudgetGuard({ maxCost: 1.0, model: "opus" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      await chain.execute(makeEvent(), ctx);
      expect(ctx.get("estimatedCost")).toBe(0.15);

      await chain.execute(makeEvent(), ctx);
      expect(ctx.get("estimatedCost")).toBe(0.3);
    });

    it("tracks cost for haiku model ($0.01 per turn)", async () => {
      const mw = agentBudgetGuard({ maxCost: 1.0, model: "haiku" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      await chain.execute(makeEvent(), ctx);
      expect(ctx.get("estimatedCost")).toBe(0.01);

      await chain.execute(makeEvent(), ctx);
      expect(ctx.get("estimatedCost")).toBe(0.02);
    });

    it("tracks cost for sonnet model ($0.05 per turn)", async () => {
      const mw = agentBudgetGuard({ maxCost: 1.0, model: "sonnet" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      await chain.execute(makeEvent(), ctx);
      expect(ctx.get("estimatedCost")).toBe(0.05);

      await chain.execute(makeEvent(), ctx);
      expect(ctx.get("estimatedCost")).toBe(0.1);
    });
  });

  describe("budget exceeded blocking", () => {
    it("blocks when estimated cost exceeds maxCost", async () => {
      const mw = agentBudgetGuard({ maxCost: 0.1, model: "sonnet" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      // First call: 0.05 (under budget)
      const result1 = await chain.execute(makeEvent(), ctx);
      expect(result1).toEqual({ decision: "pass" });

      // Second call: 0.10 (at budget)
      const result2 = await chain.execute(makeEvent(), ctx);
      expect(result2).toEqual({ decision: "pass" });

      // Third call: 0.15 (over budget)
      const result3 = await chain.execute(makeEvent(), ctx);
      expect(result3).toHaveProperty("decision", "block");
      expect(result3).toHaveProperty("reason");
      if (result3.decision !== "block") throw new Error("Expected block decision");
      expect(result3.reason).toMatch(/budget exceeded/i);
      expect(result3.reason).toContain("$0.15");
      expect(result3.reason).toContain("$0.10");
    });

    it("blocks when first tool use already exceeds budget", async () => {
      const mw = agentBudgetGuard({ maxCost: 0.01, model: "opus" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      // First call: 0.15 (over budget of 0.01)
      const result = await chain.execute(makeEvent(), ctx);
      expect(result).toHaveProperty("decision", "block");
      if (result.decision !== "block") throw new Error("Expected block decision");
      expect(result.reason).toMatch(/budget exceeded/i);
    });

    it("blocks exactly when cost equals maxCost + next turn cost", async () => {
      const mw = agentBudgetGuard({ maxCost: 0.05, model: "sonnet" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      // First call: 0.05 (equals budget)
      const result1 = await chain.execute(makeEvent(), ctx);
      expect(result1).toEqual({ decision: "pass" });

      // Second call: 0.10 (exceeds budget of 0.05)
      const result2 = await chain.execute(makeEvent(), ctx);
      expect(result2).toHaveProperty("decision", "block");
    });

    it("formats error message with proper decimal places", async () => {
      const mw = agentBudgetGuard({ maxCost: 0.1, model: "sonnet" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      // Execute 3 times to exceed budget
      await chain.execute(makeEvent(), ctx);
      await chain.execute(makeEvent(), ctx);
      const result = await chain.execute(makeEvent(), ctx);

      if (result.decision !== "block") throw new Error("Expected block decision");
      expect(result.reason).toMatch(/\$0\.15.*\$0\.10/);
    });

    it("allows unlimited usage when maxCost is very high", async () => {
      const mw = agentBudgetGuard({ maxCost: 1000.0, model: "opus" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      // Execute 100 times (100 * $0.15 = $15)
      for (let i = 0; i < 100; i++) {
        const result = await chain.execute(makeEvent(), ctx);
        expect(result).toEqual({ decision: "pass" });
      }

      expect(ctx.get("estimatedCost")).toBeCloseTo(15, 5);
    });
  });

  describe("default model fallback", () => {
    it("defaults to sonnet when model is not specified", async () => {
      const mw = agentBudgetGuard({ maxCost: 1.0 });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      await chain.execute(makeEvent(), ctx);

      // Should use sonnet default ($0.05)
      expect(ctx.get("estimatedCost")).toBe(0.05);
    });

    it("uses sonnet cost when defaulting", async () => {
      const mw = agentBudgetGuard({ maxCost: 0.08 });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      // First call: 0.05 (under budget)
      const result1 = await chain.execute(makeEvent(), ctx);
      expect(result1).toEqual({ decision: "pass" });

      // Second call: 0.10 (over budget of 0.08)
      const result2 = await chain.execute(makeEvent(), ctx);
      expect(result2).toHaveProperty("decision", "block");
    });
  });

  describe("context isolation", () => {
    it("uses existing estimatedCost from context if available", async () => {
      const mw = agentBudgetGuard({ maxCost: 1.0, model: "sonnet" });
      const chain = buildMiddlewareChain([mw]);

      // Pre-populate context with existing cost
      const store = new Map<string, unknown>([["estimatedCost", 0.5]]);
      const ctx = makeContext({
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => store.set(key, value),
      });

      await chain.execute(makeEvent(), ctx);

      // Should add 0.05 to existing 0.5
      expect(ctx.get("estimatedCost")).toBe(0.55);
    });

    it("handles zero estimatedCost in context correctly", async () => {
      const mw = agentBudgetGuard({ maxCost: 1.0, model: "haiku" });
      const chain = buildMiddlewareChain([mw]);

      const store = new Map<string, unknown>([["estimatedCost", 0]]);
      const ctx = makeContext({
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => store.set(key, value),
      });

      await chain.execute(makeEvent(), ctx);

      // Should add 0.01 to 0
      expect(ctx.get("estimatedCost")).toBe(0.01);
    });
  });

  describe("middleware metadata", () => {
    it("has correct middleware name", () => {
      const mw = agentBudgetGuard({ maxCost: 1.0 });
      expect(mw.name).toBe("agent-budget-guard");
    });

    it("hooks into PreToolUse event", () => {
      const mw = agentBudgetGuard({ maxCost: 1.0 });
      expect(mw.on).toBe("PreToolUse");
    });

    it("has handler function", () => {
      const mw = agentBudgetGuard({ maxCost: 1.0 });
      expect(typeof mw.handler).toBe("function");
    });
  });

  describe("edge cases", () => {
    it("handles very small maxCost values", async () => {
      const mw = agentBudgetGuard({ maxCost: 0.001, model: "haiku" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      // First call: 0.01 (exceeds 0.001)
      const result = await chain.execute(makeEvent(), ctx);
      expect(result).toHaveProperty("decision", "block");
    });

    it("handles very large maxCost values", async () => {
      const mw = agentBudgetGuard({ maxCost: 999999.99, model: "opus" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      const result = await chain.execute(makeEvent(), ctx);
      expect(result).toEqual({ decision: "pass" });
    });

    it("handles floating point precision correctly", async () => {
      const mw = agentBudgetGuard({ maxCost: 0.16, model: "sonnet" });
      const chain = buildMiddlewareChain([mw]);
      const ctx = makeContext();

      // 3 * 0.05 = 0.15 (under budget of 0.16)
      await chain.execute(makeEvent(), ctx);
      await chain.execute(makeEvent(), ctx);
      const result3 = await chain.execute(makeEvent(), ctx);
      expect(result3).toEqual({ decision: "pass" });

      // 4th call: 0.20 (exceeds budget of 0.16)
      const result4 = await chain.execute(makeEvent(), ctx);
      expect(result4).toHaveProperty("decision", "block");
    });
  });
});
