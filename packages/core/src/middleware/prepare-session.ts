import { agentBudgetGuard } from "@/middleware/agent-budget-guard";
import type { DispatchInput, Middleware, ResolvedAgent } from "@/types";

/**
 * Prepares the middleware array for a session by injecting automatic middleware
 * based on agent configuration and dispatch overrides.
 *
 * Currently injects:
 * - agentBudgetGuard: when maxCost is configured (overrides take precedence over agent config)
 */
export function prepareSessionMiddleware(
  baseMiddleware: Middleware[],
  agent: ResolvedAgent,
  overrides?: DispatchInput["overrides"],
): Middleware[] {
  const result = [...baseMiddleware];

  // Determine effective maxCost: overrides take precedence over agent config
  const maxCost = overrides?.maxCost ?? agent.maxCost;

  if (maxCost !== undefined && maxCost > 0) {
    const model = agent.definition.model;
    // Map SDK model strings to our tier type
    const modelTier = model === "opus" ? "opus" : model === "haiku" ? "haiku" : "sonnet";

    result.push(agentBudgetGuard({ maxCost, model: modelTier }));
  }

  return result;
}
