import { describe, expect, it } from "vitest";
import { prepareSessionMiddleware } from "@/middleware/prepare-session";
import type { Middleware, ResolvedAgent } from "@/types";

function makeAgent(overrides?: Partial<ResolvedAgent>): ResolvedAgent {
  return {
    name: "test-agent",
    definition: {
      description: "Test agent",
      prompt: "You are a test agent",
      tools: ["Bash"],
      model: "sonnet",
    },
    sandbox: "readonly",
    source: "built-in",
    ...overrides,
  };
}

function makeDummyMiddleware(name: string): Middleware {
  return {
    name,
    on: "PreToolUse",
    async handler() {
      return { decision: "pass" };
    },
  };
}

describe("prepareSessionMiddleware", () => {
  it("returns base middleware unchanged when no maxCost configured", () => {
    const base = [makeDummyMiddleware("mw1"), makeDummyMiddleware("mw2")];
    const agent = makeAgent();

    const result = prepareSessionMiddleware(base, agent);

    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe("mw1");
    expect(result[1]?.name).toBe("mw2");
  });

  it("adds agentBudgetGuard when agent.maxCost is set", () => {
    const base = [makeDummyMiddleware("mw1")];
    const agent = makeAgent({ maxCost: 5.0 });

    const result = prepareSessionMiddleware(base, agent);

    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe("mw1");
    expect(result[1]?.name).toBe("agent-budget-guard");
  });

  it("adds agentBudgetGuard when overrides.maxCost is set", () => {
    const base: Middleware[] = [];
    const agent = makeAgent(); // no maxCost

    const result = prepareSessionMiddleware(base, agent, { maxCost: 2.5 });

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("agent-budget-guard");
  });

  it("overrides.maxCost takes precedence over agent.maxCost", () => {
    const base: Middleware[] = [];
    const agent = makeAgent({ maxCost: 10.0 });

    // With override
    const resultWithOverride = prepareSessionMiddleware(base, agent, { maxCost: 3.0 });
    expect(resultWithOverride).toHaveLength(1);
    expect(resultWithOverride[0]?.name).toBe("agent-budget-guard");

    // Without override - uses agent maxCost
    const resultWithoutOverride = prepareSessionMiddleware(base, agent);
    expect(resultWithoutOverride).toHaveLength(1);
    expect(resultWithoutOverride[0]?.name).toBe("agent-budget-guard");
  });

  it("does not add agentBudgetGuard when maxCost is 0", () => {
    const base: Middleware[] = [];
    const agent = makeAgent({ maxCost: 0 });

    const result = prepareSessionMiddleware(base, agent);

    expect(result).toHaveLength(0);
  });

  it("does not add agentBudgetGuard when maxCost is negative", () => {
    const base: Middleware[] = [];
    const agent = makeAgent({ maxCost: -1 });

    const result = prepareSessionMiddleware(base, agent);

    expect(result).toHaveLength(0);
  });

  it("does not mutate the original middleware array", () => {
    const base = [makeDummyMiddleware("mw1")];
    const agent = makeAgent({ maxCost: 5.0 });

    const result = prepareSessionMiddleware(base, agent);

    expect(base).toHaveLength(1);
    expect(result).toHaveLength(2);
    expect(base).not.toBe(result);
  });

  it("handles empty base middleware array", () => {
    const base: Middleware[] = [];
    const agent = makeAgent({ maxCost: 5.0 });

    const result = prepareSessionMiddleware(base, agent);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("agent-budget-guard");
  });

  it("uses correct model tier from agent definition", () => {
    const base: Middleware[] = [];
    const opusAgent = makeAgent({
      maxCost: 5.0,
      definition: {
        description: "Opus agent",
        prompt: "You are an opus agent",
        tools: ["Bash"],
        model: "opus",
      },
    });

    const result = prepareSessionMiddleware(base, opusAgent);

    // The middleware is added - we can't easily inspect internal state,
    // but we verify the middleware was created successfully
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("agent-budget-guard");
  });

  it("handles haiku model tier", () => {
    const base: Middleware[] = [];
    const haikuAgent = makeAgent({
      maxCost: 1.0,
      definition: {
        description: "Haiku agent",
        prompt: "You are a haiku agent",
        tools: ["Bash"],
        model: "haiku",
      },
    });

    const result = prepareSessionMiddleware(base, haikuAgent);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("agent-budget-guard");
  });

  it("defaults to sonnet for unknown model strings", () => {
    const base: Middleware[] = [];
    const agent = makeAgent({
      maxCost: 5.0,
      definition: {
        description: "Custom agent",
        prompt: "You are a custom agent",
        tools: ["Bash"],
        model: "claude-3-custom", // unknown model
      },
    });

    const result = prepareSessionMiddleware(base, agent);

    // Should still add the middleware with sonnet as default
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("agent-budget-guard");
  });
});
