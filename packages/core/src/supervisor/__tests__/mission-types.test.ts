import { describe, expect, it } from "vitest";
import {
  type MissionRequest,
  type MissionRun,
  missionRequestSchema,
  missionRunSchema,
  type SupervisorProfile,
  supervisorProfileSchema,
} from "../mission-types.js";

describe("mission-types", () => {
  describe("MissionRequest", () => {
    it("validates a complete mission request", () => {
      const request: MissionRequest = {
        id: "mission-123",
        objective: "Implement CSV export feature",
        acceptanceCriteria: ["PR open", "CI green", "Reviewer approved"],
        maxCostUsd: 5.0,
        priority: "high",
        createdAt: new Date().toISOString(),
      };
      expect(missionRequestSchema.safeParse(request).success).toBe(true);
    });

    it("rejects request without objective", () => {
      const request = {
        id: "mission-123",
        acceptanceCriteria: ["PR open"],
        createdAt: new Date().toISOString(),
      };
      expect(missionRequestSchema.safeParse(request).success).toBe(false);
    });
  });

  describe("MissionRun", () => {
    it("validates a mission run", () => {
      const run: MissionRun = {
        id: "run-456",
        missionId: "mission-123",
        status: "in_progress",
        supervisorProfile: "default",
        startedAt: new Date().toISOString(),
        costUsd: 1.25,
        runIds: ["run-1", "run-2"],
      };
      expect(missionRunSchema.safeParse(run).success).toBe(true);
    });

    it("validates completed run with evidence", () => {
      const run: MissionRun = {
        id: "run-456",
        missionId: "mission-123",
        status: "completed",
        supervisorProfile: "default",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        costUsd: 2.5,
        runIds: ["run-1"],
        evidence: ["PR #42 merged", "All tests passing"],
      };
      expect(missionRunSchema.safeParse(run).success).toBe(true);
    });
  });

  describe("SupervisorProfile", () => {
    it("validates a supervisor profile", () => {
      const profile: SupervisorProfile = {
        name: "strict",
        description: "High-validation mode with mandatory reviews",
        autoDecide: false,
        maxConcurrentRuns: 2,
      };
      expect(supervisorProfileSchema.safeParse(profile).success).toBe(true);
    });
  });
});
