import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isRunActive } from "@/supervisor/heartbeat";
import type { PersistedRun } from "@/types";

// Test that the blocked status is valid in the schema
describe("PersistedRun status - blocked", () => {
  const persistedRunStatusSchema = z.enum(["running", "paused", "completed", "failed", "blocked"]);

  it("accepts 'blocked' as valid status", () => {
    const result = persistedRunStatusSchema.safeParse("blocked");
    expect(result.success).toBe(true);
    expect(result.data).toBe("blocked");
  });

  it("accepts all existing statuses", () => {
    for (const status of ["running", "paused", "completed", "failed", "blocked"]) {
      const result = persistedRunStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    }
  });
});

describe("StepResult status - blocked", () => {
  const stepStatusSchema = z.enum([
    "pending",
    "running",
    "success",
    "failure",
    "skipped",
    "blocked",
  ]);

  it("accepts 'blocked' as valid status", () => {
    const result = stepStatusSchema.safeParse("blocked");
    expect(result.success).toBe(true);
    expect(result.data).toBe("blocked");
  });
});

describe("isRunActive - blocked status", () => {
  function makeRun(status: PersistedRun["status"]): PersistedRun {
    return {
      version: 1,
      runId: "test-run",
      agent: "developer",
      repo: "/tmp/test",
      prompt: "Test",
      status,
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it("treats blocked runs as active", () => {
    const run = makeRun("blocked");
    expect(isRunActive(run)).toBe(true);
  });

  it("treats paused runs as active", () => {
    const run = makeRun("paused");
    expect(isRunActive(run)).toBe(true);
  });

  it("treats completed runs as inactive", () => {
    const run = makeRun("completed");
    expect(isRunActive(run)).toBe(false);
  });

  it("treats failed runs as inactive", () => {
    const run = makeRun("failed");
    expect(isRunActive(run)).toBe(false);
  });
});
