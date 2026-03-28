import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlSupervisorStore } from "@/supervisor/stores/jsonl";

let dir: string;
let store: JsonlSupervisorStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "neo-store-test-"));
  store = new JsonlSupervisorStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("session", () => {
  it("returns undefined when no session saved", async () => {
    expect(await store.getSessionId("sup_1")).toBeUndefined();
  });

  it("saves and retrieves session id", async () => {
    await store.saveSessionId("sup_1", "ses_abc");
    expect(await store.getSessionId("sup_1")).toBe("ses_abc");
  });

  it("overwrites previous session id", async () => {
    await store.saveSessionId("sup_1", "ses_old");
    await store.saveSessionId("sup_1", "ses_new");
    expect(await store.getSessionId("sup_1")).toBe("ses_new");
  });
});

describe("activity", () => {
  it("returns empty array when no activity", async () => {
    expect(await store.getRecentActivity("sup_1")).toEqual([]);
  });

  it("appends and retrieves activity entries", async () => {
    await store.appendActivity("sup_1", {
      id: "act_1",
      type: "action",
      summary: "Dispatched developer",
      timestamp: new Date().toISOString(),
    });
    const entries = await store.getRecentActivity("sup_1");
    expect(entries).toHaveLength(1);
    expect(entries.at(0)?.summary).toBe("Dispatched developer");
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await store.appendActivity("sup_1", {
        id: `act_${i}`,
        type: "action",
        summary: `Action ${i}`,
        timestamp: new Date().toISOString(),
      });
    }
    const entries = await store.getRecentActivity("sup_1", 3);
    expect(entries).toHaveLength(3);
  });

  it("returns entries for different supervisors independently", async () => {
    await store.appendActivity("sup_1", {
      id: "a1",
      type: "action",
      summary: "sup1",
      timestamp: new Date().toISOString(),
    });
    await store.appendActivity("sup_2", {
      id: "a2",
      type: "action",
      summary: "sup2",
      timestamp: new Date().toISOString(),
    });
    expect(await store.getRecentActivity("sup_1")).toHaveLength(1);
    expect(await store.getRecentActivity("sup_2")).toHaveLength(1);
  });
});

describe("cost tracking", () => {
  it("returns 0 when no cost recorded", async () => {
    expect(await store.getTotalCost("sup_1")).toBe(0);
  });

  it("accumulates cost", async () => {
    await store.recordCost("sup_1", 0.05);
    await store.recordCost("sup_1", 0.03);
    expect(await store.getTotalCost("sup_1")).toBeCloseTo(0.08);
  });

  it("tracks cost independently per supervisor", async () => {
    await store.recordCost("sup_1", 0.1);
    await store.recordCost("sup_2", 0.2);
    expect(await store.getTotalCost("sup_1")).toBeCloseTo(0.1);
    expect(await store.getTotalCost("sup_2")).toBeCloseTo(0.2);
  });
});

describe("state", () => {
  it("returns null when no state", async () => {
    expect(await store.getState("sup_1")).toBeNull();
  });

  it("saves and retrieves state", async () => {
    const state = {
      supervisorId: "sup_1",
      status: "running" as const,
      startedAt: new Date().toISOString(),
      costUsd: 0,
    };
    await store.saveState("sup_1", state);
    expect(await store.getState("sup_1")).toEqual(state);
  });

  it("overwrites previous state", async () => {
    const state1 = {
      supervisorId: "sup_1",
      status: "running" as const,
      startedAt: new Date().toISOString(),
      costUsd: 0,
    };
    const state2 = {
      supervisorId: "sup_1",
      status: "complete" as const,
      startedAt: new Date().toISOString(),
      costUsd: 0.5,
    };
    await store.saveState("sup_1", state1);
    await store.saveState("sup_1", state2);
    const result = await store.getState("sup_1");
    expect(result?.status).toBe("complete");
  });
});
