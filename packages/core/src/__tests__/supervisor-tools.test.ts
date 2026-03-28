import { describe, expect, it } from "vitest";
import {
  SUPERVISOR_BLOCKED_TOOL,
  SUPERVISOR_COMPLETE_TOOL,
  supervisorBlockedSchema,
  supervisorCompleteSchema,
} from "@/supervisor/supervisor-tools";

describe("supervisorCompleteSchema", () => {
  it("accepts valid complete payload", () => {
    const result = supervisorCompleteSchema.safeParse({
      summary: "Implemented auth feature",
      evidence: ["https://github.com/org/repo/pull/42"],
      criteriaResults: [{ criterion: "PR open", met: true, evidence: "PR #42 opened" }],
    });
    expect(result.success).toBe(true);
  });

  it("requires at least one evidence item", () => {
    const result = supervisorCompleteSchema.safeParse({
      summary: "Done",
      evidence: [],
      criteriaResults: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional branch field", () => {
    const result = supervisorCompleteSchema.safeParse({
      summary: "Done",
      evidence: ["PR #42"],
      branch: "feat/auth",
      criteriaResults: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("supervisorBlockedSchema", () => {
  it("accepts valid blocked payload", () => {
    const result = supervisorBlockedSchema.safeParse({
      reason: "Cannot determine correct migration strategy",
      question: "Should we use addColumn or createTable?",
      context: "The existing schema has a users table with 2M rows",
      urgency: "high",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid urgency", () => {
    const result = supervisorBlockedSchema.safeParse({
      reason: "r",
      question: "q",
      context: "c",
      urgency: "critical",
    });
    expect(result.success).toBe(false);
  });

  it("accepts low urgency", () => {
    const result = supervisorBlockedSchema.safeParse({
      reason: "r",
      question: "q",
      context: "c",
      urgency: "low",
    });
    expect(result.success).toBe(true);
  });
});

describe("tool definitions", () => {
  it("SUPERVISOR_COMPLETE_TOOL has correct name", () => {
    expect(SUPERVISOR_COMPLETE_TOOL.name).toBe("supervisor_complete");
  });

  it("SUPERVISOR_BLOCKED_TOOL has correct name", () => {
    expect(SUPERVISOR_BLOCKED_TOOL.name).toBe("supervisor_blocked");
  });

  it("SUPERVISOR_COMPLETE_TOOL has inputSchema with required fields", () => {
    expect(SUPERVISOR_COMPLETE_TOOL.inputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["summary", "evidence", "criteriaResults"]),
    });
  });
});
