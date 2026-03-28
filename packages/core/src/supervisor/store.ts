import type { ActivityEntry } from "./schemas.js";

// ─── Focused supervisor state ─────────────────────────────

export interface FocusedSupervisorState {
  supervisorId: string;
  status: "running" | "blocked" | "complete" | "failed";
  startedAt: string;
  costUsd: number;
  objective?: string;
  lastProgressAt?: string;
}

// ─── Interface ────────────────────────────────────────────

/**
 * Pluggable persistence interface for focused supervisor state.
 * Default implementation: JsonlSupervisorStore (zero-infra, CLI use case).
 * Future: SqliteSupervisorStore, PostgresSupervisorStore.
 */
export interface SupervisorStore {
  // Session
  getSessionId(supervisorId: string): Promise<string | undefined>;
  saveSessionId(supervisorId: string, sessionId: string): Promise<void>;

  // Activity
  appendActivity(supervisorId: string, entry: ActivityEntry): Promise<void>;
  getRecentActivity(supervisorId: string, limit?: number): Promise<ActivityEntry[]>;

  // State
  getState(supervisorId: string): Promise<FocusedSupervisorState | null>;
  saveState(supervisorId: string, state: FocusedSupervisorState): Promise<void>;

  // Cost tracking
  recordCost(supervisorId: string, costUsd: number): Promise<void>;
  getTotalCost(supervisorId: string): Promise<number>;
}
