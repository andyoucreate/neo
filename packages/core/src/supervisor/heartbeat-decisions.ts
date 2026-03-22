import type { ActivityLog } from "./activity-log.js";
import type { Decision, DecisionStore } from "./decisions.js";
import type { QueuedEvent } from "./schemas.js";

export interface ProcessDecisionsResult {
  pendingDecisions: Decision[];
  answeredDecisions: Decision[];
  hasExpiredDecisions: boolean;
}

/**
 * Process decision answers from inbox and expire old decisions.
 * Returns pending, answered, and expiry status for prompt context.
 */
export async function processDecisions(
  rawEvents: QueuedEvent[],
  lastHeartbeat: string | undefined,
  decisionStore: DecisionStore,
  activityLog: ActivityLog,
  autoDecide: boolean,
): Promise<ProcessDecisionsResult> {
  // Process decision answers from inbox messages
  await processDecisionAnswers(rawEvents, decisionStore, activityLog);

  // Auto-answer expired decisions
  const expiredDecisions = await decisionStore.expire();
  const hasExpiredDecisions = expiredDecisions.length > 0;

  // Get pending and recently answered decisions for prompt context (only in autoDecide mode)
  const pendingDecisions = autoDecide ? await decisionStore.pending() : [];
  const answeredDecisions = autoDecide ? await decisionStore.answered(lastHeartbeat) : [];

  return { pendingDecisions, answeredDecisions, hasExpiredDecisions };
}

/**
 * Process decision:answer events from inbox messages.
 * Expected format: "decision:answer <decisionId> <answer>"
 */
async function processDecisionAnswers(
  rawEvents: QueuedEvent[],
  store: DecisionStore,
  activityLog: ActivityLog,
): Promise<void> {
  for (const event of rawEvents) {
    if (event.kind !== "message") continue;

    const text = event.data.text.trim();
    const match = /^decision:answer\s+(\S+)\s+(.+)$/i.exec(text);
    if (!match) continue;

    const decisionId = match[1];
    const answer = match[2];
    if (!decisionId || !answer) continue;

    try {
      await store.answer(decisionId, answer);
      await activityLog.log("event", `Decision answered: ${decisionId}`, {
        decisionId,
        answer,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await activityLog.log("error", `Failed to answer decision ${decisionId}: ${msg}`, {
        decisionId,
        answer,
      });
    }
  }
}
