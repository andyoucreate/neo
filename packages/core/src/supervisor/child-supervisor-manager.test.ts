import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildSupervisorConfig } from "@/config/child-supervisor-schema.js";
import { ChildSupervisorManager } from "./child-supervisor-manager.js";
import { writeChildHeartbeat, writeChildState } from "./child-supervisor-protocol.js";

describe("ChildSupervisorManager", () => {
  const testDir = "/tmp/neo-child-manager-test";
  let manager: ChildSupervisorManager;

  const mockConfig: ChildSupervisorConfig = {
    name: "cleanup-neo",
    type: "cleanup",
    repo: "/path/to/neo",
    enabled: true,
    budget: { dailyCapUsd: 10, maxCostPerTaskUsd: 1 },
    heartbeatIntervalMs: 60_000,
    autoStart: true,
  };

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    manager = new ChildSupervisorManager({
      parentName: "supervisor",
      childrenDir: testDir,
    });
  });

  afterEach(async () => {
    await manager.stopAll();
    await rm(testDir, { recursive: true, force: true });
  });

  it("starts with no children", () => {
    expect(manager.list()).toHaveLength(0);
  });

  it("registers a child config", async () => {
    await manager.register(mockConfig);
    expect(manager.list()).toHaveLength(1);
    expect(manager.get("cleanup-neo")).toEqual(mockConfig);
  });

  it("unregisters a child", async () => {
    await manager.register(mockConfig);
    await manager.unregister("cleanup-neo");
    expect(manager.list()).toHaveLength(0);
  });

  it("detects stalled child when heartbeat is old", async () => {
    await manager.register(mockConfig);
    const childDir = path.join(testDir, "cleanup-neo");
    await mkdir(childDir, { recursive: true });

    // Write old heartbeat (5 minutes ago)
    const oldTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await writeChildHeartbeat(childDir, {
      timestamp: oldTimestamp,
      status: "running",
      costSinceLastUsd: 0,
    });

    // Write state with running status
    await writeChildState(childDir, {
      name: "cleanup-neo",
      pid: 99999, // Non-existent PID
      status: "running",
      startedAt: oldTimestamp,
      lastHeartbeatAt: oldTimestamp,
      costTodayUsd: 0,
      taskCount: 0,
    });

    const health = await manager.checkHealth("cleanup-neo", { stallThresholdMs: 60_000 });
    expect(health.isStalled).toBe(true);
  });

  it("reports healthy child with recent heartbeat", async () => {
    await manager.register(mockConfig);
    const childDir = path.join(testDir, "cleanup-neo");
    await mkdir(childDir, { recursive: true });

    // Write recent heartbeat
    const recentTimestamp = new Date().toISOString();
    await writeChildHeartbeat(childDir, {
      timestamp: recentTimestamp,
      status: "running",
      costSinceLastUsd: 0,
    });

    // Write state with running status and current process PID (known alive)
    await writeChildState(childDir, {
      name: "cleanup-neo",
      pid: process.pid, // Current process is always alive
      status: "running",
      startedAt: recentTimestamp,
      lastHeartbeatAt: recentTimestamp,
      costTodayUsd: 0,
      taskCount: 0,
    });

    const health = await manager.checkHealth("cleanup-neo", { stallThresholdMs: 60_000 });
    expect(health.isStalled).toBe(false);
    expect(health.status).toBe("running");
  });
});
