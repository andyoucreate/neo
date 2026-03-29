import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry } from "../schemas.js";
import type { FocusedSupervisorState, SupervisorStore } from "../store.js";

/**
 * JSONL-backed SupervisorStore implementation.
 * Zero dependencies beyond Node.js built-ins.
 * Default implementation for CLI usage (zero-infra).
 *
 * Layout per supervisor:
 *   <baseDir>/<supervisorId>/session.json    — SDK session ID
 *   <baseDir>/<supervisorId>/activity.jsonl  — activity log
 *   <baseDir>/<supervisorId>/state.json      — current state
 *   <baseDir>/<supervisorId>/cost.json       — accumulated cost
 */
export class JsonlSupervisorStore implements SupervisorStore {
  private readonly baseDir: string;
  /** Promise-based mutex to serialize write operations */
  private writeLock: Promise<void> = Promise.resolve();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Acquire the write lock and execute a callback.
   * Serializes all write operations to prevent race conditions.
   */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the existing lock
    const release = this.writeLock;
    let releaseLock: () => void = () => {};
    this.writeLock = new Promise((r) => {
      releaseLock = r;
    });

    try {
      // Wait for previous operation to complete
      await release;
      return await fn();
    } finally {
      // Release the lock for the next operation
      releaseLock();
    }
  }

  private supervisorDir(supervisorId: string): string {
    return path.join(this.baseDir, supervisorId);
  }

  private async ensureDir(supervisorId: string): Promise<string> {
    const dir = this.supervisorDir(supervisorId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  // ─── Session ───────────────────────────────────────────

  async getSessionId(supervisorId: string): Promise<string | undefined> {
    const sessionPath = path.join(this.supervisorDir(supervisorId), "session.json");
    try {
      const raw = await readFile(sessionPath, "utf-8");
      const parsed = JSON.parse(raw) as { sessionId: string };
      return parsed.sessionId;
    } catch {
      return undefined;
    }
  }

  async saveSessionId(supervisorId: string, sessionId: string): Promise<void> {
    const dir = await this.ensureDir(supervisorId);
    await writeFile(path.join(dir, "session.json"), JSON.stringify({ sessionId }), "utf-8");
  }

  // ─── Activity ──────────────────────────────────────────

  async appendActivity(supervisorId: string, entry: ActivityEntry): Promise<void> {
    const dir = await this.ensureDir(supervisorId);
    await appendFile(path.join(dir, "activity.jsonl"), `${JSON.stringify(entry)}\n`, "utf-8");
  }

  async getRecentActivity(supervisorId: string, limit = 50): Promise<ActivityEntry[]> {
    const activityPath = path.join(this.supervisorDir(supervisorId), "activity.jsonl");
    try {
      const raw = await readFile(activityPath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const last = lines.slice(-limit);
      return last.flatMap((line) => {
        try {
          return [JSON.parse(line) as ActivityEntry];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  // ─── State ─────────────────────────────────────────────

  async getState(supervisorId: string): Promise<FocusedSupervisorState | null> {
    const statePath = path.join(this.supervisorDir(supervisorId), "state.json");
    try {
      const raw = await readFile(statePath, "utf-8");
      return JSON.parse(raw) as FocusedSupervisorState;
    } catch {
      return null;
    }
  }

  async saveState(supervisorId: string, state: FocusedSupervisorState): Promise<void> {
    const dir = await this.ensureDir(supervisorId);
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
  }

  // ─── Cost ──────────────────────────────────────────────

  async recordCost(supervisorId: string, costUsd: number): Promise<void> {
    await this.withWriteLock(async () => {
      const current = await this.getTotalCost(supervisorId);
      const dir = await this.ensureDir(supervisorId);
      await writeFile(
        path.join(dir, "cost.json"),
        JSON.stringify({ totalCostUsd: current + costUsd }),
        "utf-8",
      );
    });
  }

  async getTotalCost(supervisorId: string): Promise<number> {
    const costPath = path.join(this.supervisorDir(supervisorId), "cost.json");
    try {
      const raw = await readFile(costPath, "utf-8");
      const parsed = JSON.parse(raw) as { totalCostUsd: number };
      return parsed.totalCostUsd;
    } catch {
      return 0;
    }
  }
}
