import type { Middleware } from "../types.js";

/**
 * Budget guard middleware.
 *
 * Checks daily cost against budget cap on every tool call.
 * If over budget, blocks with reason "Daily budget exceeded".
 * Uses the middleware context's `get("costToday")` and `get("budgetCapUsd")`.
 */
export function budgetGuard(): Middleware {
  return {
    name: "budget-guard",
    on: "PreToolUse",
    async handler(_event, context) {
      const costToday = context.get("costToday");
      const budgetCapUsd = context.get("budgetCapUsd");

      if (
        typeof costToday === "number" &&
        typeof budgetCapUsd === "number" &&
        costToday >= budgetCapUsd
      ) {
        return {
          decision: "block",
          reason: "Daily budget exceeded",
        };
      }

      return {};
    },
  };
}
