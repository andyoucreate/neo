import { mkdir, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ChildHeartbeat,
  type ChildSupervisorState,
  childSupervisorStateSchema,
  readChildHeartbeat,
  readChildState,
  writeChildHeartbeat,
  writeChildState,
} from "./child-supervisor-protocol.js";

describe("childSupervisorStateSchema", () => {
  it("parses valid state", () => {
    const input = {
      name: "cleanup-neo",
      pid: 12345,
      status: "running",
      startedAt: "2024-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2024-01-01T00:01:00.000Z",
      costTodayUsd: 0.5,
      taskCount: 3,
    };
    const result = childSupervisorStateSchema.parse(input);
    expect(result.status).toBe("running");
  });

  it("accepts all valid statuses", () => {
    for (const status of ["running", "idle", "stopped", "failed", "stalled"]) {
      const input = {
        name: "test",
        pid: 1,
        status,
        startedAt: "2024-01-01T00:00:00.000Z",
        lastHeartbeatAt: "2024-01-01T00:00:00.000Z",
        costTodayUsd: 0,
        taskCount: 0,
      };
      expect(() => childSupervisorStateSchema.parse(input)).not.toThrow();
    }
  });
});

describe("file protocol helpers", () => {
  const testDir = "/tmp/neo-child-protocol-test";

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("writes and reads child state", async () => {
    const state: ChildSupervisorState = {
      name: "cleanup-neo",
      pid: 12345,
      status: "running",
      startedAt: "2024-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2024-01-01T00:01:00.000Z",
      costTodayUsd: 0.5,
      taskCount: 3,
    };

    await writeChildState(testDir, state);
    const result = await readChildState(testDir);

    expect(result).toEqual(state);
  });

  it("returns null for missing state file", async () => {
    const result = await readChildState(testDir);
    expect(result).toBeNull();
  });

  it("writes and reads heartbeat", async () => {
    const heartbeat: ChildHeartbeat = {
      timestamp: "2024-01-01T00:01:00.000Z",
      status: "running",
      currentTask: "Running lint",
      costSinceLastUsd: 0.05,
    };

    await writeChildHeartbeat(testDir, heartbeat);
    const result = await readChildHeartbeat(testDir);

    expect(result).toEqual(heartbeat);
  });
});
