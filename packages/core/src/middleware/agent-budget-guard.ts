import type { AgentModel } from "@/agents/schema";
import type { Middleware } from "@/types";

/**
 * Per-turn cost estimates by model tier (in USD).
 * These are rough estimates based on typical tool call complexity.
 *
 * Cost estimates are derived from Anthropic's pricing model (as of 2024):
 * - opus:   $15/1M input tokens, $75/1M output tokens → ~$0.15/turn (1k in, 1k out)
 * - sonnet: $3/1M input tokens, $15/1M output tokens → ~$0.05/turn (1k in, 1k out)
 * - haiku:  $0.25/1M input tokens, $1.25/1M output tokens → ~$0.01/turn (1k in, 1k out)
 *
 * These are conservative estimates assuming moderate tool call complexity.
 * Actual costs may vary based on prompt size and tool usage patterns.
 */
const MODEL_COST_PER_TURN: Record<AgentModel, number> = {
  opus: 0.15,
  sonnet: 0.05,
  haiku: 0.01,
};

export interface AgentBudgetGuardOptions {
  /** Maximum cost budget for this agent session in USD. */
  maxCost: number;
  /** The model tier used by this agent. Defaults to "sonnet". */
  model?: AgentModel;
}

/**
 * Agent budget guard middleware.
 *
 * Tracks estimated cost per session based on tool calls and blocks
 * the session when the estimated cost exceeds the configured maxCost.
 *
 * Cost estimation is based on model tier:
 * - opus: $0.15 per turn
 * - sonnet: $0.05 per turn
 * - haiku: $0.01 per turn
 *
 * Uses the middleware context's `estimatedCost` to track cumulative cost.
 */
export function agentBudgetGuard(options: AgentBudgetGuardOptions): Middleware {
  const { maxCost, model = "sonnet" } = options;
  const costPerTurn = MODEL_COST_PER_TURN[model];

  return {
    name: "agent-budget-guard",
    on: "PreToolUse",
    async handler(_event, context) {
      // Get current estimated cost or initialize to 0
      const currentCost: number = (context.get("estimatedCost") as number | undefined) ?? 0;

      // Increment cost for this tool call
      const newCost = currentCost + costPerTurn;
      context.set("estimatedCost", newCost);

      // Check if budget exceeded
      if (newCost > maxCost) {
        return {
          decision: "block",
          reason: `Agent budget exceeded: estimated $${newCost.toFixed(2)} > limit $${maxCost.toFixed(2)}`,
        };
      }

      return { decision: "pass" };
    },
  };
}
