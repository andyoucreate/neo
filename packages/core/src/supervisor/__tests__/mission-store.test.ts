import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionStore } from "../mission-store.js";
import type { MissionRequest } from "../mission-types.js";

describe("MissionStore", () => {
  let testDir: string;
  let store: MissionStore;

  beforeEach(() => {
    testDir = join(tmpdir(), `mission-store-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    store = new MissionStore(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("createMission", () => {
    it("creates a mission and returns a run", async () => {
      const request: MissionRequest = {
        id: "mission-1",
        objective: "Test objective",
        acceptanceCriteria: ["Criterion 1"],
        priority: "normal",
        createdAt: new Date().toISOString(),
      };

      const run = await store.createMission(request, "default");

      expect(run.missionId).toBe("mission-1");
      expect(run.status).toBe("pending");
      expect(run.supervisorProfile).toBe("default");
    });
  });

  describe("getMission", () => {
    it("returns null for non-existent mission", async () => {
      const run = await store.getMission("non-existent");
      expect(run).toBeNull();
    });

    it("returns the mission after creation", async () => {
      const request: MissionRequest = {
        id: "mission-2",
        objective: "Another objective",
        acceptanceCriteria: ["Criterion"],
        priority: "high",
        createdAt: new Date().toISOString(),
      };

      await store.createMission(request, "default");
      const run = await store.getMission("mission-2");

      expect(run).not.toBeNull();
      expect(run?.missionId).toBe("mission-2");
    });
  });

  describe("updateMission", () => {
    it("updates mission status", async () => {
      const request: MissionRequest = {
        id: "mission-3",
        objective: "Update test",
        acceptanceCriteria: ["Done"],
        priority: "normal",
        createdAt: new Date().toISOString(),
      };

      const run = await store.createMission(request, "default");
      await store.updateMission(run.id, { status: "in_progress" });

      const updated = await store.getMission("mission-3");
      expect(updated?.status).toBe("in_progress");
    });
  });

  describe("listMissions", () => {
    it("lists all missions", async () => {
      await store.createMission(
        {
          id: "m1",
          objective: "First",
          acceptanceCriteria: ["A"],
          priority: "normal",
          createdAt: new Date().toISOString(),
        },
        "default",
      );

      await store.createMission(
        {
          id: "m2",
          objective: "Second",
          acceptanceCriteria: ["B"],
          priority: "high",
          createdAt: new Date().toISOString(),
        },
        "default",
      );

      const missions = await store.listMissions();
      expect(missions).toHaveLength(2);
    });

    it("filters by status", async () => {
      const run1 = await store.createMission(
        {
          id: "m1",
          objective: "First",
          acceptanceCriteria: ["A"],
          priority: "normal",
          createdAt: new Date().toISOString(),
        },
        "default",
      );

      await store.createMission(
        {
          id: "m2",
          objective: "Second",
          acceptanceCriteria: ["B"],
          priority: "high",
          createdAt: new Date().toISOString(),
        },
        "default",
      );

      await store.updateMission(run1.id, { status: "completed" });

      const pending = await store.listMissions({ status: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.missionId).toBe("m2");
    });
  });
});
