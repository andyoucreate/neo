import { readUnconsolidated } from "./log-buffer.js";
import type { LogBufferEntry, SupervisorDaemonState } from "./schemas.js";

/** Consolidation runs every N heartbeats */
const DEFAULT_CONSOLIDATION_INTERVAL = 5;

/**
 * Determine whether this heartbeat should be a consolidation cycle.
 * Consolidation runs every `consolidationInterval` heartbeats,
 * or earlier if there are pending unconsolidated entries (after at least 2 heartbeats).
 */
export function shouldConsolidate(
  heartbeatCount: number,
  lastConsolidationHeartbeat: number,
  consolidationInterval: number,
  hasPendingEntries: boolean,
): boolean {
  const since = heartbeatCount - lastConsolidationHeartbeat;
  if (since >= consolidationInterval) return true;
  if (hasPendingEntries && since >= 2) return true;
  return false;
}

/**
 * Determine whether this heartbeat should run compaction.
 * Compaction is a deep cleanup pass that runs every ~50 heartbeats.
 */
export function shouldCompact(
  heartbeatCount: number,
  lastCompactionHeartbeat: number,
  compactionInterval = 50,
): boolean {
  const since = heartbeatCount - lastCompactionHeartbeat;
  return since >= compactionInterval;
}

export interface HeartbeatModeResult {
  isConsolidation: boolean;
  isCompaction: boolean;
  unconsolidated: LogBufferEntry[];
  heartbeatCount: number;
  lastConsolidationTs: string | undefined;
}

/**
 * Determine heartbeat mode: compaction > consolidation > standard.
 */
export async function determineHeartbeatMode(
  supervisorDir: string,
  state: SupervisorDaemonState | null,
): Promise<HeartbeatModeResult> {
  const heartbeatCount = state?.heartbeatCount ?? 0;
  const lastConsolidation = state?.lastConsolidationHeartbeat ?? 0;
  const lastCompaction = state?.lastCompactionHeartbeat ?? 0;
  const lastConsolidationTs = state?.lastConsolidationTimestamp;
  const unconsolidated = await readUnconsolidated(supervisorDir);

  const hasNewEntriesSinceLastConsolidation = lastConsolidationTs
    ? unconsolidated.some((e) => e.timestamp > lastConsolidationTs)
    : unconsolidated.length > 0;

  const hasPendingEntries = unconsolidated.length > 0;
  const isCompaction = shouldCompact(heartbeatCount, lastCompaction);
  const wouldConsolidate = shouldConsolidate(
    heartbeatCount,
    lastConsolidation,
    DEFAULT_CONSOLIDATION_INTERVAL,
    hasPendingEntries,
  );
  const isConsolidation = isCompaction || (wouldConsolidate && hasNewEntriesSinceLastConsolidation);

  return {
    isConsolidation,
    isCompaction,
    unconsolidated,
    heartbeatCount,
    lastConsolidationTs,
  };
}
