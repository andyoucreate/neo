import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { getSupervisorInboxPath } from "@neotx/core";
import { printSuccess } from "./output.js";

export interface ChildModeOptions {
  parentName: string;
  objective: string;
  acceptanceCriteria: string[];
  maxCostUsd?: number;
}

/**
 * Request the parent supervisor to spawn a child via inbox message.
 * The HeartbeatLoop will read this and call spawnChildSupervisor.
 */
export async function spawnChildFromCli(options: ChildModeOptions): Promise<void> {
  const { parentName, objective, acceptanceCriteria, maxCostUsd } = options;

  const id = randomUUID();
  const timestamp = new Date().toISOString();

  // Send a message to parent's inbox that triggers spawn
  const payload: { objective: string; acceptanceCriteria: string[]; maxCostUsd?: number } = {
    objective,
    acceptanceCriteria,
  };
  if (maxCostUsd !== undefined) {
    payload.maxCostUsd = maxCostUsd;
  }

  const message = {
    id,
    from: "api" as const,
    text: `child:spawn ${JSON.stringify(payload)}`,
    timestamp,
  };

  const inboxPath = getSupervisorInboxPath(parentName);
  await appendFile(inboxPath, `${JSON.stringify(message)}\n`, "utf-8");

  printSuccess(`Child supervisor spawn requested for parent "${parentName}"`);
  console.log(`  Objective: ${objective}`);
  console.log(`  Criteria:  ${acceptanceCriteria.join(", ")}`);
  if (maxCostUsd !== undefined) {
    console.log(`  Budget:    $${maxCostUsd.toFixed(2)}`);
  }
  console.log("");
  console.log("  The parent supervisor will spawn the child on its next heartbeat.");
  console.log("  Monitor via: neo supervise");
}
