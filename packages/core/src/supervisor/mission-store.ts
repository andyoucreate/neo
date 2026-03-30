import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type MissionRequest,
  type MissionRun,
  type MissionStatus,
  missionRunSchema,
} from "./mission-types.js";

export interface MissionQuery {
  status?: MissionStatus;
  limit?: number;
}

/**
 * JSONL-based store for mission runs.
 * Follows the same pattern as JsonlSupervisorStore.
 */
export class MissionStore {
  private readonly filePath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(supervisorDir: string) {
    this.filePath = join(supervisorDir, "missions.jsonl");
  }

  /**
   * Acquire the write lock and execute a callback.
   * Serializes all write operations to prevent race conditions.
   */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.writeLock;
    let releaseLock: () => void = () => {};
    this.writeLock = new Promise((r) => {
      releaseLock = r;
    });

    try {
      await release;
      return await fn();
    } finally {
      releaseLock();
    }
  }

  /**
   * Create a new mission run from a request.
   */
  async createMission(request: MissionRequest, profile: string): Promise<MissionRun> {
    await this.ensureDir();

    const run: MissionRun = {
      id: `mrun-${randomUUID().slice(0, 8)}`,
      missionId: request.id,
      status: "pending",
      supervisorProfile: profile,
      startedAt: new Date().toISOString(),
      costUsd: 0,
      runIds: [],
    };

    await this.appendRun(run);
    return run;
  }

  /**
   * Get the latest state of a mission by missionId.
   */
  async getMission(missionId: string): Promise<MissionRun | null> {
    const runs = await this.readAllRuns();
    // Return the latest run for this mission
    const matching = runs.filter((r) => r.missionId === missionId);
    if (matching.length === 0) {
      return null;
    }
    const latest = matching[matching.length - 1];
    return latest ?? null;
  }

  /**
   * Get a mission run by its run ID.
   */
  async getMissionRun(runId: string): Promise<MissionRun | null> {
    const runs = await this.readAllRuns();
    const run = runs.find((r) => r.id === runId);
    return run ?? null;
  }

  /**
   * Update a mission run.
   */
  async updateMission(runId: string, updates: Partial<MissionRun>): Promise<void> {
    const run = await this.getMissionRun(runId);
    if (!run) {
      throw new Error(`Mission run not found: ${runId}`);
    }

    const updated: MissionRun = {
      ...run,
      ...updates,
      lastActivityAt: new Date().toISOString(),
    };

    await this.appendRun(updated);
  }

  /**
   * List mission runs with optional filtering.
   */
  async listMissions(query?: MissionQuery): Promise<MissionRun[]> {
    const runs = await this.readAllRuns();

    // Group by missionId and get latest for each
    const latestByMission = new Map<string, MissionRun>();
    for (const run of runs) {
      latestByMission.set(run.missionId, run);
    }

    let result = Array.from(latestByMission.values());

    if (query?.status) {
      result = result.filter((r) => r.status === query.status);
    }

    // Sort by startedAt descending
    result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (query?.limit) {
      result = result.slice(0, query.limit);
    }

    return result;
  }

  // ─── Private ─────────────────────────────────────────────

  private async ensureDir(): Promise<void> {
    const dir = join(this.filePath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  private async appendRun(run: MissionRun): Promise<void> {
    await this.withWriteLock(async () => {
      const line = `${JSON.stringify(run)}\n`;
      writeFileSync(this.filePath, line, { flag: "a" });
    });
  }

  private async readAllRuns(): Promise<MissionRun[]> {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const content = readFileSync(this.filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    const runs: MissionRun[] = [];
    for (const line of lines) {
      try {
        const parsed = missionRunSchema.parse(JSON.parse(line));
        runs.push(parsed);
      } catch {
        // Skip invalid lines
      }
    }

    return runs;
  }
}
