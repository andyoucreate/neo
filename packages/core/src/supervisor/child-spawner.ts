import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildRegistry } from "./child-registry.js";
import type { ChildHandle, ChildToParentMessage } from "./schemas.js";

export interface SpawnChildOptions {
  objective: string;
  acceptanceCriteria: string[];
  registry: ChildRegistry;
  workerPath: string;
  parentName: string;
  maxCostUsd?: number;
  depth?: number;
}

export interface SpawnChildResult {
  supervisorId: string;
  childProcess: ChildProcess;
}

/** Maximum allowed depth for child supervisors. Children cannot spawn children. */
const MAX_DEPTH = 1;

/**
 * Spawn a focused child supervisor as a forked process.
 * The child communicates via IPC and is tracked by the ChildRegistry.
 */
export async function spawnChildSupervisor(options: SpawnChildOptions): Promise<SpawnChildResult> {
  const {
    objective,
    acceptanceCriteria,
    registry,
    workerPath,
    parentName,
    maxCostUsd,
    depth = 0,
  } = options;

  // Enforce depth limit: children cannot spawn children
  if (depth > MAX_DEPTH) {
    throw new Error(`Maximum depth exceeded: ${depth} > ${MAX_DEPTH}`);
  }

  const supervisorId = randomUUID();
  const now = new Date().toISOString();

  // Fork the worker process
  const childProcess = fork(workerPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      NEO_CHILD_SUPERVISOR_ID: supervisorId,
      NEO_CHILD_OBJECTIVE: objective,
      NEO_CHILD_CRITERIA: JSON.stringify(acceptanceCriteria),
      NEO_CHILD_PARENT_NAME: parentName,
      NEO_CHILD_MAX_COST_USD: maxCostUsd?.toString() ?? "",
      NEO_CHILD_DEPTH: String(depth),
    },
  });

  // Build handle for registry
  const handle: ChildHandle = {
    supervisorId,
    objective,
    depth,
    startedAt: now,
    lastProgressAt: now,
    costUsd: 0,
    maxCostUsd,
    status: "running",
  };

  // Stop callback for budget exceeded or manual stop
  const stopCallback = () => {
    if (childProcess.connected) {
      childProcess.send({ type: "stop" });
    }
  };

  // Wire IPC message handling
  childProcess.on("message", (msg: unknown) => {
    // Validate and route to registry
    if (isChildToParentMessage(msg)) {
      registry.handleMessage(msg);
    }
  });

  childProcess.on("exit", (code) => {
    // Clean up on unexpected exit
    const currentHandle = registry.get(supervisorId);
    if (currentHandle && currentHandle.status === "running") {
      registry.handleMessage({
        type: "failed",
        supervisorId,
        error: `Process exited with code ${code}`,
      });
    }
    registry.remove(supervisorId);
  });

  // Register with the parent's ChildRegistry
  registry.register(handle, stopCallback, childProcess);

  return { supervisorId, childProcess };
}

/**
 * Type guard for IPC messages from child.
 */
function isChildToParentMessage(msg: unknown): msg is ChildToParentMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    typeof obj.type === "string" &&
    typeof obj.supervisorId === "string" &&
    ["progress", "complete", "blocked", "failed", "session"].includes(obj.type)
  );
}
