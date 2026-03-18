import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActivityEntry,
  ActivityQueryOptions,
  SupervisorDaemonState,
  SupervisorStatus,
} from "./schemas.js";
import { activityEntrySchema, supervisorDaemonStateSchema } from "./schemas.js";

const STATE_FILE = "state.json";
const ACTIVITY_FILE = "activity.jsonl";

/**
 * Reads supervisor status from the daemon state file.
 * Returns null if the supervisor is not running or state file doesn't exist.
 */
export class StatusReader {
  readonly dataDir: string;
  private readonly statePath: string;
  private readonly activityPath: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, STATE_FILE);
    this.activityPath = path.join(dataDir, ACTIVITY_FILE);
  }

  /**
   * Read and parse supervisor status from disk.
   * Returns null if the state file doesn't exist (supervisor not running).
   */
  async getStatus(): Promise<SupervisorStatus | null> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf-8");
    } catch {
      // File not found — supervisor not running
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed JSON — treat as not running
      return null;
    }

    const result = supervisorDaemonStateSchema.safeParse(parsed);
    if (!result.success) {
      // Schema validation failed — state file is incompatible
      return null;
    }

    const daemon = result.data;

    // Map daemon status to API status
    const statusMap: Record<SupervisorDaemonState["status"], SupervisorStatus["status"]> = {
      running: "running",
      draining: "stopping",
      stopped: "idle",
    };

    // Read recent activity for summary
    const recentActivity = this.queryActivity({ limit: 5 });

    return {
      pid: daemon.pid,
      sessionId: daemon.sessionId,
      startedAt: daemon.startedAt,
      heartbeatCount: daemon.heartbeatCount,
      totalCostUsd: daemon.totalCostUsd,
      todayCostUsd: daemon.todayCostUsd,
      status: statusMap[daemon.status],
      lastHeartbeat: daemon.lastHeartbeat ?? daemon.startedAt,
      activeRunCount: 0, // TODO: count active runs from .neo/runs/
      recentActivitySummary: recentActivity.map((e) => `[${e.type}] ${e.summary}`),
    };
  }

  /**
   * Query activity entries with optional filtering.
   * Returns empty array if the activity file doesn't exist or is empty.
   */
  queryActivity(options: ActivityQueryOptions = {}): ActivityEntry[] {
    const { limit = 50, offset = 0, type, since, until } = options;

    let content: string;
    try {
      content = readFileSync(this.activityPath, "utf-8");
    } catch {
      // File not found — no activity yet
      return [];
    }

    const lines = content.trim().split("\n").filter(Boolean);
    let entries: ActivityEntry[] = [];

    // Parse all valid entries
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const result = activityEntrySchema.safeParse(parsed);
        if (result.success) {
          entries.push(result.data);
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Apply type filter
    if (type) {
      entries = entries.filter((e) => e.type === type);
    }

    // Apply date range filters
    if (since) {
      const sinceDate = new Date(since);
      entries = entries.filter((e) => new Date(e.timestamp) >= sinceDate);
    }

    if (until) {
      const untilDate = new Date(until);
      entries = entries.filter((e) => new Date(e.timestamp) <= untilDate);
    }

    // Apply offset and limit
    return entries.slice(offset, offset + limit);
  }
}
