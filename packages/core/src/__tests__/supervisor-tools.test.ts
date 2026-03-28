import { describe, expect, it } from "vitest";
import { childToParentMessageSchema, parentToChildMessageSchema } from "@/supervisor/schemas";
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

describe("childToParentMessageSchema", () => {
  it("parses progress message", () => {
    const result = childToParentMessageSchema.safeParse({
      type: "progress",
      supervisorId: "sup_1",
      summary: "Opened PR #42",
      costDelta: 0.05,
    });
    expect(result.success).toBe(true);
  });

  it("parses complete message", () => {
    const result = childToParentMessageSchema.safeParse({
      type: "complete",
      supervisorId: "sup_1",
      summary: "Done",
      evidence: ["https://github.com/org/repo/pull/42"],
    });
    expect(result.success).toBe(true);
  });

  it("parses blocked message", () => {
    const result = childToParentMessageSchema.safeParse({
      type: "blocked",
      supervisorId: "sup_1",
      reason: "Cannot decide",
      question: "Which approach?",
      urgency: "high",
    });
    expect(result.success).toBe(true);
  });

  it("parses failed message", () => {
    const result = childToParentMessageSchema.safeParse({
      type: "failed",
      supervisorId: "sup_1",
      error: "Process crashed",
    });
    expect(result.success).toBe(true);
  });

  it("parses session message", () => {
    const result = childToParentMessageSchema.safeParse({
      type: "session",
      supervisorId: "sup_1",
      sessionId: "ses_abc123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown type", () => {
    const result = childToParentMessageSchema.safeParse({
      type: "unknown",
      supervisorId: "sup_1",
    });
    expect(result.success).toBe(false);
  });
});

describe("parentToChildMessageSchema", () => {
  it("parses unblock message", () => {
    const result = parentToChildMessageSchema.safeParse({
      type: "unblock",
      answer: "Use addColumn approach",
    });
    expect(result.success).toBe(true);
  });

  it("parses stop message", () => {
    const result = parentToChildMessageSchema.safeParse({ type: "stop" });
    expect(result.success).toBe(true);
  });

  it("parses inject message", () => {
    const result = parentToChildMessageSchema.safeParse({
      type: "inject",
      context: "Mission B modified auth.ts — be aware when running tests",
    });
    expect(result.success).toBe(true);
  });
});
