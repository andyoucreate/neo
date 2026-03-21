import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusReader } from "@/supervisor/StatusReader";
import type { ActivityEntry, SupervisorDaemonState } from "@/supervisor/schemas";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_status_reader_test__");

/**
 * Creates a valid SupervisorDaemonState fixture.
 * StatusReader.getStatus() validates against supervisorDaemonStateSchema,
 * not SupervisorStatus, so we must provide all required daemon fields.
 */
function makeDaemonState(overrides?: Partial<SupervisorDaemonState>): SupervisorDaemonState {
  return {
    pid: 12345,
    sessionId: "sess-123",
    port: 3000,
    cwd: "/tmp/test",
    status: "running",
    startedAt: "2026-03-15T10:00:00.000Z",
    lastHeartbeat: "2026-03-15T10:30:00.000Z",
    heartbeatCount: 10,
    todayCostUsd: 1.5,
    totalCostUsd: 25.0,
    idleSkipCount: 0,
    activeWorkSkipCount: 0,
    lastConsolidationHeartbeat: 0,
    lastCompactionHeartbeat: 0,
    ...overrides,
  };
}

function makeActivity(overrides?: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: `act-${Math.random().toString(36).slice(2, 8)}`,
    type: "action",
    summary: "Did something",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("StatusReader.getStatus", () => {
  it("returns null for missing state file", async () => {
    const reader = new StatusReader(TMP_DIR);
    const result = await reader.getStatus();
    expect(result).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    await writeFile(path.join(TMP_DIR, "state.json"), "not-valid-json", "utf-8");
    const reader = new StatusReader(TMP_DIR);
    const result = await reader.getStatus();
    expect(result).toBeNull();
  });

  it("returns null for invalid schema", async () => {
    await writeFile(path.join(TMP_DIR, "state.json"), JSON.stringify({ invalid: "data" }), "utf-8");
    const reader = new StatusReader(TMP_DIR);
    const result = await reader.getStatus();
    expect(result).toBeNull();
  });

  it("returns parsed status for valid state file", async () => {
    const daemonState = makeDaemonState({ pid: 99999 });
    await writeFile(path.join(TMP_DIR, "state.json"), JSON.stringify(daemonState), "utf-8");
    const reader = new StatusReader(TMP_DIR);
    const result = await reader.getStatus();
    expect(result).not.toBeNull();
    expect(result?.pid).toBe(99999);
    expect(result?.status).toBe("running");
  });

  it("includes activeRunCount as a number in status", async () => {
    const daemonState = makeDaemonState();
    await writeFile(path.join(TMP_DIR, "state.json"), JSON.stringify(daemonState), "utf-8");
    const reader = new StatusReader(TMP_DIR);
    const result = await reader.getStatus();

    expect(result).not.toBeNull();
    // activeRunCount should be a number (actual count depends on global ~/.neo/runs state)
    expect(typeof result?.activeRunCount).toBe("number");
    expect(result?.activeRunCount).toBeGreaterThanOrEqual(0);
  });
});

describe("StatusReader.queryActivity", () => {
  it("returns empty array for missing activity file", () => {
    const reader = new StatusReader(TMP_DIR);
    const result = reader.queryActivity();
    expect(result).toEqual([]);
  });

  it("returns empty array for empty file", async () => {
    await writeFile(path.join(TMP_DIR, "activity.jsonl"), "", "utf-8");
    const reader = new StatusReader(TMP_DIR);
    const result = reader.queryActivity();
    expect(result).toEqual([]);
  });

  it("skips malformed JSON lines", async () => {
    const lines = [
      JSON.stringify(makeActivity({ id: "good-1" })),
      "not-json",
      JSON.stringify(makeActivity({ id: "good-2" })),
    ].join("\n");
    await writeFile(path.join(TMP_DIR, "activity.jsonl"), lines, "utf-8");

    const reader = new StatusReader(TMP_DIR);
    const result = reader.queryActivity();
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("good-1");
    expect(result[1]?.id).toBe("good-2");
  });

  it("skips entries that fail schema validation", async () => {
    const lines = [
      JSON.stringify(makeActivity({ id: "valid" })),
      JSON.stringify({ id: "invalid", type: "not-a-real-type", summary: "test" }),
    ].join("\n");
    await writeFile(path.join(TMP_DIR, "activity.jsonl"), lines, "utf-8");

    const reader = new StatusReader(TMP_DIR);
    const result = reader.queryActivity();
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("valid");
  });

  it("filters by type", async () => {
    const lines = [
      JSON.stringify(makeActivity({ id: "action-1", type: "action" })),
      JSON.stringify(makeActivity({ id: "error-1", type: "error" })),
      JSON.stringify(makeActivity({ id: "action-2", type: "action" })),
    ].join("\n");
    await writeFile(path.join(TMP_DIR, "activity.jsonl"), lines, "utf-8");

    const reader = new StatusReader(TMP_DIR);
    const result = reader.queryActivity({ type: "error" });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("error-1");
  });

  it("filters by since timestamp", async () => {
    const lines = [
      JSON.stringify(makeActivity({ id: "old", timestamp: "2026-03-01T00:00:00.000Z" })),
      JSON.stringify(makeActivity({ id: "new", timestamp: "2026-03-15T00:00:00.000Z" })),
    ].join("\n");
    await writeFile(path.join(TMP_DIR, "activity.jsonl"), lines, "utf-8");

    const reader = new StatusReader(TMP_DIR);
    const result = reader.queryActivity({ since: "2026-03-10T00:00:00.000Z" });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("new");
  });

  it("filters by until timestamp", async () => {
    const lines = [
      JSON.stringify(makeActivity({ id: "old", timestamp: "2026-03-01T00:00:00.000Z" })),
      JSON.stringify(makeActivity({ id: "new", timestamp: "2026-03-15T00:00:00.000Z" })),
    ].join("\n");
    await writeFile(path.join(TMP_DIR, "activity.jsonl"), lines, "utf-8");

    const reader = new StatusReader(TMP_DIR);
    const result = reader.queryActivity({ until: "2026-03-10T00:00:00.000Z" });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("old");
  });

  it("applies offset and limit pagination", async () => {
    const lines = [
      JSON.stringify(makeActivity({ id: "a" })),
      JSON.stringify(makeActivity({ id: "b" })),
      JSON.stringify(makeActivity({ id: "c" })),
      JSON.stringify(makeActivity({ id: "d" })),
      JSON.stringify(makeActivity({ id: "e" })),
    ].join("\n");
    await writeFile(path.join(TMP_DIR, "activity.jsonl"), lines, "utf-8");

    const reader = new StatusReader(TMP_DIR);
    const result = reader.queryActivity({ offset: 1, limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("b");
    expect(result[1]?.id).toBe("c");
  });

  it("combines type filter with pagination", async () => {
    const lines = [
      JSON.stringify(makeActivity({ id: "a1", type: "action" })),
      JSON.stringify(makeActivity({ id: "e1", type: "error" })),
      JSON.stringify(makeActivity({ id: "a2", type: "action" })),
      JSON.stringify(makeActivity({ id: "a3", type: "action" })),
      JSON.stringify(makeActivity({ id: "e2", type: "error" })),
    ].join("\n");
    await writeFile(path.join(TMP_DIR, "activity.jsonl"), lines, "utf-8");

    const reader = new StatusReader(TMP_DIR);
    const result = reader.queryActivity({ type: "action", offset: 1, limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("a2");
    expect(result[1]?.id).toBe("a3");
  });

  it("uses default limit of 50", async () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify(makeActivity({ id: `entry-${i}` })),
    ).join("\n");
    await writeFile(path.join(TMP_DIR, "activity.jsonl"), entries, "utf-8");

    const reader = new StatusReader(TMP_DIR);
    const result = reader.queryActivity();
    expect(result).toHaveLength(50);
  });
});
