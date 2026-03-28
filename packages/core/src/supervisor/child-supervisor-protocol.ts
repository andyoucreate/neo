import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// ─── Child Supervisor State ──────────────────────────────

export const childSupervisorStatusSchema = z.enum([
  "running",
  "idle",
  "stopped",
  "failed",
  "stalled",
]);

export type ChildSupervisorStatus = z.infer<typeof childSupervisorStatusSchema>;

export const childSupervisorStateSchema = z.object({
  /** Name of the child supervisor */
  name: z.string(),
  /** Process ID of the child supervisor */
  pid: z.number(),
  /** Current status */
  status: childSupervisorStatusSchema,
  /** When the child was started */
  startedAt: z.string(),
  /** Last heartbeat timestamp */
  lastHeartbeatAt: z.string(),
  /** Cost accumulated today */
  costTodayUsd: z.number(),
  /** Number of tasks completed this session */
  taskCount: z.number(),
  /** Current objective (if any) */
  currentObjective: z.string().optional(),
  /** Last error message (if failed) */
  lastError: z.string().optional(),
});

export type ChildSupervisorState = z.infer<typeof childSupervisorStateSchema>;

// ─── Child Heartbeat (written by child, read by parent) ──

export const childHeartbeatSchema = z.object({
  /** When this heartbeat was sent */
  timestamp: z.string(),
  /** Current status */
  status: childSupervisorStatusSchema,
  /** What the child is currently doing */
  currentTask: z.string().optional(),
  /** Cost since last heartbeat */
  costSinceLastUsd: z.number().default(0),
  /** Any blocking issues */
  blockedReason: z.string().optional(),
});

export type ChildHeartbeat = z.infer<typeof childHeartbeatSchema>;

// ─── File Protocol Helpers ───────────────────────────────

const STATE_FILE = "state.json";
const HEARTBEAT_FILE = "heartbeat.json";

/**
 * Write child supervisor state to its directory.
 */
export async function writeChildState(
  childDir: string,
  state: ChildSupervisorState,
): Promise<void> {
  const filePath = path.join(childDir, STATE_FILE);
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Read child supervisor state from its directory.
 * Returns null if the state file does not exist or is invalid.
 */
export async function readChildState(childDir: string): Promise<ChildSupervisorState | null> {
  try {
    const filePath = path.join(childDir, STATE_FILE);
    const raw = await readFile(filePath, "utf-8");
    return childSupervisorStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Write heartbeat from child (child calls this periodically).
 */
export async function writeChildHeartbeat(
  childDir: string,
  heartbeat: ChildHeartbeat,
): Promise<void> {
  const filePath = path.join(childDir, HEARTBEAT_FILE);
  await writeFile(filePath, JSON.stringify(heartbeat, null, 2), "utf-8");
}

/**
 * Read heartbeat from child (parent calls this to check health).
 * Returns null if the heartbeat file does not exist or is invalid.
 */
export async function readChildHeartbeat(childDir: string): Promise<ChildHeartbeat | null> {
  try {
    const filePath = path.join(childDir, HEARTBEAT_FILE);
    const raw = await readFile(filePath, "utf-8");
    return childHeartbeatSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
