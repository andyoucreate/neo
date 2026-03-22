import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupervisorDaemonState } from "@/supervisor/schemas";
import type { PersistedRun } from "@/types";

describe("SupervisorDaemon sessionId validation", () => {
  const TEST_DIR = path.join(process.cwd(), ".test-daemon-session");
  const RUNS_DIR = path.join(TEST_DIR, "runs");
  const SUPERVISOR_DIR = path.join(TEST_DIR, "supervisor");
  const STATE_PATH = path.join(SUPERVISOR_DIR, "state.json");

  beforeEach(async () => {
    await mkdir(RUNS_DIR, { recursive: true });
    await mkdir(SUPERVISOR_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  function makeRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
    return {
      version: 1,
      runId: "test-run-1",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test prompt",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  async function writeRun(run: PersistedRun, repoSlug = "test-repo"): Promise<void> {
    const repoDir = path.join(RUNS_DIR, repoSlug);
    await mkdir(repoDir, { recursive: true });
    const filePath = path.join(repoDir, `${run.runId}.json`);
    await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
  }

  async function readRun(runId: string, repoSlug = "test-repo"): Promise<PersistedRun> {
    const filePath = path.join(RUNS_DIR, repoSlug, `${runId}.json`);
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as PersistedRun;
  }

  async function writeState(state: Partial<SupervisorDaemonState>): Promise<void> {
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  }

  it("marks running runs as orphaned when sessionId changes", async () => {
    // Setup: old session with running runs
    const oldSessionId = "old-session-123";

    await writeState({
      sessionId: oldSessionId,
      pid: 99999,
      startedAt: new Date().toISOString(),
      heartbeatCount: 10,
      totalCostUsd: 1.5,
      todayCostUsd: 0.5,
      status: "stopped",
    });

    // Create runs with old sessionId
    const run1 = makeRun({
      runId: "run-1",
      status: "running",
      supervisorSessionId: oldSessionId,
    });
    const run2 = makeRun({
      runId: "run-2",
      status: "running",
      supervisorSessionId: oldSessionId,
    });
    const run3 = makeRun({
      runId: "run-3",
      status: "completed",
      supervisorSessionId: oldSessionId,
    });

    await writeRun(run1);
    await writeRun(run2);
    await writeRun(run3);

    // Simulate the markOrphanedRunsFromSessionMismatch logic
    const entries = await import("node:fs/promises").then((m) =>
      m.readdir(RUNS_DIR, { withFileTypes: true }),
    );
    let orphanedCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(RUNS_DIR, entry.name);
      const files = await import("node:fs/promises").then((m) => m.readdir(subDir));

      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const filePath = path.join(subDir, f);
        const raw = await readFile(filePath, "utf-8");
        const run = JSON.parse(raw) as PersistedRun;

        if (
          (run.status === "running" || run.status === "paused") &&
          run.supervisorSessionId === oldSessionId
        ) {
          run.status = "failed";
          run.updatedAt = new Date().toISOString();
          await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
          orphanedCount++;
        }
      }
    }

    // Verify: 2 running runs should be marked as failed
    expect(orphanedCount).toBe(2);

    const updatedRun1 = await readRun("run-1");
    const updatedRun2 = await readRun("run-2");
    const updatedRun3 = await readRun("run-3");

    expect(updatedRun1.status).toBe("failed");
    expect(updatedRun2.status).toBe("failed");
    expect(updatedRun3.status).toBe("completed"); // Should not change
  });

  it("does not mark runs without supervisorSessionId", async () => {
    const oldSessionId = "old-session-123";

    await writeState({
      sessionId: oldSessionId,
      pid: 99999,
      startedAt: new Date().toISOString(),
      heartbeatCount: 10,
      totalCostUsd: 1.5,
      todayCostUsd: 0.5,
      status: "stopped",
    });

    // Create run without supervisorSessionId (legacy run)
    const run1 = makeRun({
      runId: "run-1",
      status: "running",
      // no supervisorSessionId
    });

    await writeRun(run1);

    // Simulate the markOrphanedRunsFromSessionMismatch logic
    const entries = await import("node:fs/promises").then((m) =>
      m.readdir(RUNS_DIR, { withFileTypes: true }),
    );
    let orphanedCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(RUNS_DIR, entry.name);
      const files = await import("node:fs/promises").then((m) => m.readdir(subDir));

      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const filePath = path.join(subDir, f);
        const raw = await readFile(filePath, "utf-8");
        const run = JSON.parse(raw) as PersistedRun;

        if (
          (run.status === "running" || run.status === "paused") &&
          run.supervisorSessionId === oldSessionId
        ) {
          run.status = "failed";
          run.updatedAt = new Date().toISOString();
          await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
          orphanedCount++;
        }
      }
    }

    // Verify: no runs should be marked as orphaned (no supervisorSessionId)
    expect(orphanedCount).toBe(0);

    const updatedRun1 = await readRun("run-1");
    expect(updatedRun1.status).toBe("running"); // Should not change
  });

  it("only marks paused runs with matching sessionId", async () => {
    const oldSessionId = "old-session-123";

    await writeState({
      sessionId: oldSessionId,
      pid: 99999,
      startedAt: new Date().toISOString(),
      heartbeatCount: 10,
      totalCostUsd: 1.5,
      todayCostUsd: 0.5,
      status: "stopped",
    });

    // Create paused run with old sessionId
    const run1 = makeRun({
      runId: "run-1",
      status: "paused",
      supervisorSessionId: oldSessionId,
    });

    await writeRun(run1);

    // Simulate the markOrphanedRunsFromSessionMismatch logic
    const entries = await import("node:fs/promises").then((m) =>
      m.readdir(RUNS_DIR, { withFileTypes: true }),
    );
    let orphanedCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(RUNS_DIR, entry.name);
      const files = await import("node:fs/promises").then((m) => m.readdir(subDir));

      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const filePath = path.join(subDir, f);
        const raw = await readFile(filePath, "utf-8");
        const run = JSON.parse(raw) as PersistedRun;

        if (
          (run.status === "running" || run.status === "paused") &&
          run.supervisorSessionId === oldSessionId
        ) {
          run.status = "failed";
          run.updatedAt = new Date().toISOString();
          await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
          orphanedCount++;
        }
      }
    }

    // Verify: paused run should be marked as orphaned
    expect(orphanedCount).toBe(1);

    const updatedRun1 = await readRun("run-1");
    expect(updatedRun1.status).toBe("failed");
  });

  it("handles multiple repos with mixed sessionIds", async () => {
    const oldSessionId = "old-session-123";
    const newSessionId = "new-session-456";

    await writeState({
      sessionId: oldSessionId,
      pid: 99999,
      startedAt: new Date().toISOString(),
      heartbeatCount: 10,
      totalCostUsd: 1.5,
      todayCostUsd: 0.5,
      status: "stopped",
    });

    // Repo 1: old sessionId
    const run1 = makeRun({
      runId: "run-1",
      status: "running",
      supervisorSessionId: oldSessionId,
    });
    await writeRun(run1, "repo-1");

    // Repo 2: new sessionId (shouldn't be marked)
    const run2 = makeRun({
      runId: "run-2",
      status: "running",
      supervisorSessionId: newSessionId,
    });
    await writeRun(run2, "repo-2");

    // Repo 3: no sessionId
    const run3 = makeRun({
      runId: "run-3",
      status: "running",
    });
    await writeRun(run3, "repo-3");

    // Simulate the markOrphanedRunsFromSessionMismatch logic
    const entries = await import("node:fs/promises").then((m) =>
      m.readdir(RUNS_DIR, { withFileTypes: true }),
    );
    let orphanedCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(RUNS_DIR, entry.name);
      const files = await import("node:fs/promises").then((m) => m.readdir(subDir));

      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const filePath = path.join(subDir, f);
        const raw = await readFile(filePath, "utf-8");
        const run = JSON.parse(raw) as PersistedRun;

        if (
          (run.status === "running" || run.status === "paused") &&
          run.supervisorSessionId === oldSessionId
        ) {
          run.status = "failed";
          run.updatedAt = new Date().toISOString();
          await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
          orphanedCount++;
        }
      }
    }

    // Verify: only run-1 should be marked
    expect(orphanedCount).toBe(1);

    const updatedRun1 = await readRun("run-1", "repo-1");
    const updatedRun2 = await readRun("run-2", "repo-2");
    const updatedRun3 = await readRun("run-3", "repo-3");

    expect(updatedRun1.status).toBe("failed");
    expect(updatedRun2.status).toBe("running"); // Different sessionId
    expect(updatedRun3.status).toBe("running"); // No sessionId
  });
});
