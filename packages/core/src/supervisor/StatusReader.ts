import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getRunsDir } from "@/paths";
import type { PersistedRun } from "@/types";
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
    } catch (err) {
      // File not found — supervisor not running
      console.debug(
        `[StatusReader] State file not found: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Malformed JSON — treat as not running
      console.debug(
        `[StatusReader] Malformed state JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
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

    // Count active runs from .neo/runs/
    const activeRunCount = await this.countActiveRuns();

    return {
      pid: daemon.pid,
      sessionId: daemon.sessionId,
      startedAt: daemon.startedAt,
      heartbeatCount: daemon.heartbeatCount,
      totalCostUsd: daemon.totalCostUsd,
      todayCostUsd: daemon.todayCostUsd,
      status: statusMap[daemon.status],
      lastHeartbeat: daemon.lastHeartbeat ?? daemon.startedAt,
      activeRunCount,
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
    } catch (err) {
      // File not found — no activity yet
      console.debug(
        `[StatusReader] Activity file not found: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      } catch (err) {
        // Skip malformed JSONL line
        console.debug(
          `[StatusReader] Skipping malformed activity line: ${err instanceof Error ? err.message : String(err)}`,
        );
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

  /**
   * Count runs with status "running" from .neo/runs/.
   * Fails silently — returns 0 if the runs directory doesn't exist.
   */
  private async countActiveRuns(): Promise<number> {
    const runsDir = getRunsDir();
    if (!existsSync(runsDir)) return 0;

    try {
      const runFiles = await this.collectRunFiles(runsDir);
      let count = 0;
      for (const filePath of runFiles) {
        if (await this.isRunning(filePath)) count++;
      }
      return count;
    } catch (err) {
      // Runs directory unreadable or corrupted
      console.debug(
        `[StatusReader] Failed to count active runs: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Collect all run JSON files from the runs directory tree.
   * Searches both top-level and repo subdirectories.
   */
  private async collectRunFiles(runsDir: string): Promise<string[]> {
    const entries = await readdir(runsDir, { withFileTypes: true });
    const jsonFiles: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(runsDir, entry.name);
        const subFiles = await readdir(subDir);
        for (const f of subFiles) {
          if (this.isRunFile(f)) {
            jsonFiles.push(path.join(subDir, f));
          }
        }
      } else if (this.isRunFile(entry.name)) {
        jsonFiles.push(path.join(runsDir, entry.name));
      }
    }

    return jsonFiles;
  }

  /**
   * Check if a filename is a run file (JSON but not dispatch).
   */
  private isRunFile(filename: string): boolean {
    return filename.endsWith(".json") && !filename.endsWith(".dispatch.json");
  }

  /**
   * Check if a run file represents an active (running) run.
   */
  private async isRunning(filePath: string): Promise<boolean> {
    try {
      const content = await readFile(filePath, "utf-8");
      const run = JSON.parse(content) as PersistedRun;
      return run.status === "running";
    } catch (err) {
      // Run file corrupted or unreadable
      console.debug(
        `[StatusReader] Failed to read run file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
