/**
 * Entry point for child supervisor worker process.
 * Spawned by parent supervisor via fork(), communicates via IPC.
 *
 * Required environment variables:
 * - NEO_CHILD_SUPERVISOR_ID: unique ID for this child
 * - NEO_CHILD_OBJECTIVE: the objective to accomplish
 * - NEO_CHILD_CRITERIA: JSON-encoded acceptance criteria array
 * - NEO_CHILD_PARENT_NAME: name of parent supervisor
 * - NEO_CHILD_MAX_COST_USD: optional budget cap
 * - NEO_CHILD_DEPTH: depth level (0 or 1)
 */

import { mkdir } from "node:fs/promises";
import {
  ClaudeAdapter,
  FocusedLoop,
  getFocusedSupervisorDir,
  JsonlSupervisorStore,
  loadGlobalConfig,
  type ParentToChildMessage,
} from "@neotx/core";

async function main(): Promise<void> {
  const supervisorId = process.env.NEO_CHILD_SUPERVISOR_ID;
  const objective = process.env.NEO_CHILD_OBJECTIVE;
  const criteriaRaw = process.env.NEO_CHILD_CRITERIA;
  const parentName = process.env.NEO_CHILD_PARENT_NAME;
  const maxCostUsdRaw = process.env.NEO_CHILD_MAX_COST_USD;

  if (!supervisorId || !objective || !criteriaRaw || !parentName) {
    console.error("[child-supervisor-worker] Missing required environment variables");
    process.exit(1);
  }

  let acceptanceCriteria: string[];
  try {
    acceptanceCriteria = JSON.parse(criteriaRaw) as string[];
  } catch (err) {
    console.debug(
      `[child-supervisor-worker] Criteria parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("[child-supervisor-worker] Invalid NEO_CHILD_CRITERIA JSON");
    process.exit(1);
  }

  const maxCostUsd = maxCostUsdRaw ? Number.parseFloat(maxCostUsdRaw) : undefined;

  // Create supervisor directory
  const supervisorDir = getFocusedSupervisorDir(supervisorId);
  await mkdir(supervisorDir, { recursive: true });

  // Load config (for any future config needs)
  await loadGlobalConfig();

  // Create AI adapter (ClaudeAdapter wraps the SDK)
  const adapter = new ClaudeAdapter();

  // Create store for session persistence using existing JsonlSupervisorStore
  const store = new JsonlSupervisorStore(supervisorDir);

  // Track cumulative cost
  let totalCostUsd = 0;

  // Create FocusedLoop
  const loop = new FocusedLoop({
    supervisorId,
    objective,
    acceptanceCriteria,
    adapter,
    store,
    onComplete: async (result) => {
      sendToParent({
        type: "complete",
        supervisorId,
        summary: result.summary,
        evidence: result.evidence,
      });
      process.exit(0);
    },
    onBlocked: async (blocked) => {
      sendToParent({
        type: "blocked",
        supervisorId,
        reason: blocked.reason,
        question: blocked.question,
        urgency: blocked.urgency,
      });
    },
    onProgress: async (summary, costDelta) => {
      totalCostUsd += costDelta;
      sendToParent({
        type: "progress",
        supervisorId,
        summary,
        costDelta,
      });

      // Check budget locally as well (defense in depth)
      if (maxCostUsd !== undefined && totalCostUsd >= maxCostUsd) {
        sendToParent({
          type: "failed",
          supervisorId,
          error: `Budget exceeded: $${totalCostUsd.toFixed(2)} >= $${maxCostUsd.toFixed(2)}`,
        });
        process.exit(1);
      }
    },
  });

  // Handle messages from parent
  process.on("message", (msg: ParentToChildMessage) => {
    switch (msg.type) {
      case "stop":
        loop.stop();
        sendToParent({
          type: "failed",
          supervisorId,
          error: "Stopped by parent",
        });
        process.exit(0);
        break;
      case "inject":
        loop.injectContext(msg.context);
        break;
      case "unblock":
        loop.injectContext(`Parent answer: ${msg.answer}`);
        break;
    }
  });

  // Report session ID once available
  const reportSession = () => {
    const handle = adapter.getSessionHandle();
    if (handle?.provider === "claude") {
      sendToParent({
        type: "session",
        supervisorId,
        sessionId: handle.sessionId,
      });
    }
  };

  // Run the focused loop
  try {
    // Initial progress to indicate we started
    sendToParent({
      type: "progress",
      supervisorId,
      summary: "Child supervisor started",
      costDelta: 0,
    });

    await loop.run();

    // Report session after first turn if available
    reportSession();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    sendToParent({
      type: "failed",
      supervisorId,
      error: errMsg,
    });
    process.exit(1);
  }
}

function sendToParent(msg: Record<string, unknown>): void {
  if (process.send) {
    process.send(msg);
  }
}

// Only run main() when executed directly (not when imported for testing)
// Use process.argv[1] check for ESM entry point detection
const isDirectExecution =
  process.argv[1]?.endsWith("child-supervisor-worker.js") ||
  process.argv[1]?.endsWith("child-supervisor-worker.ts");

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[child-supervisor-worker] Fatal error:", err);
    process.exit(1);
  });
}
