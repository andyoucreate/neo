import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "@/orchestrator/run-store";
import type { PersistedRun } from "@/types";

describe("RunStore - blocking", () => {
  let testDir: string;
  let store: RunStore;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "neo-test-"));
    store = new RunStore({ runsDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("getRunById returns null for non-existent run", async () => {
    const result = await store.getRunById("non-existent");
    expect(result).toBeNull();
  });

  it("getRunById returns persisted run", async () => {
    const run: PersistedRun = {
      version: 1,
      runId: "test-run-123",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test prompt",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run);

    const result = await store.getRunById("test-run-123");
    expect(result).not.toBeNull();
    expect(result?.runId).toBe("test-run-123");
  });

  it("getAllRuns returns all persisted runs", async () => {
    const run1: PersistedRun = {
      version: 1,
      runId: "run-1",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test 1",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run2: PersistedRun = {
      version: 1,
      runId: "run-2",
      agent: "reviewer",
      repo: "/tmp/test-repo",
      prompt: "Test 2",
      status: "completed",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run1);
    await store.persistRun(run2);

    const result = await store.getAllRuns();
    expect(result).toHaveLength(2);
  });

  it("markBlocked updates run status to blocked", async () => {
    const run: PersistedRun = {
      version: 1,
      runId: "test-run-block",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test prompt",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run);

    await store.markBlocked("test-run-block", "Max retries exceeded");

    const updated = await store.getRunById("test-run-block");
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockedReason).toBe("Max retries exceeded");
    expect(updated?.blockedAt).toBeDefined();
  });

  it("getBlockedRuns returns only blocked runs", async () => {
    const run1: PersistedRun = {
      version: 1,
      runId: "run-blocked",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test 1",
      status: "blocked",
      blockedReason: "Test block",
      blockedAt: new Date().toISOString(),
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run2: PersistedRun = {
      version: 1,
      runId: "run-running",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test 2",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run1);
    await store.persistRun(run2);

    const blocked = await store.getBlockedRuns();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.runId).toBe("run-blocked");
  });

  it("unblock restores run to running status", async () => {
    const run: PersistedRun = {
      version: 1,
      runId: "test-unblock",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test prompt",
      status: "blocked",
      blockedReason: "Test block",
      blockedAt: new Date().toISOString(),
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run);

    await store.unblock("test-unblock");

    const updated = await store.getRunById("test-unblock");
    expect(updated?.status).toBe("running");
    expect(updated?.blockedReason).toBeUndefined();
    expect(updated?.blockedAt).toBeUndefined();
  });
});

describe("Blocked run detection", () => {
  it("identifies blocked runs separately from failed runs", () => {
    const blockedRun: Partial<PersistedRun> = {
      status: "blocked",
      blockedReason: "Max retries exceeded",
      blockedAt: new Date().toISOString(),
    };

    const failedRun: Partial<PersistedRun> = {
      status: "failed",
    };

    expect(blockedRun.status).toBe("blocked");
    expect(failedRun.status).toBe("failed");
    expect(blockedRun.blockedReason).toBeDefined();
  });
});

describe("RunStore - error handling", () => {
  let testDir: string;
  let store: RunStore;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "neo-test-"));
    store = new RunStore({ runsDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("markBlocked throws when run not found", async () => {
    await expect(store.markBlocked("non-existent", "reason")).rejects.toThrow(
      "Run not found: non-existent",
    );
  });

  it("unblock throws when run not found", async () => {
    await expect(store.unblock("non-existent")).rejects.toThrow("Run not found: non-existent");
  });

  it("unblock throws when run is not blocked", async () => {
    const run: PersistedRun = {
      version: 1,
      runId: "running-run",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run);

    await expect(store.unblock("running-run")).rejects.toThrow("is not blocked");
  });
});
