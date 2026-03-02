import { describe, it, expect, vi } from "vitest";
import type { PreToolUseHookInput, NotificationHookInput } from "@anthropic-ai/claude-agent-sdk";
import { auditLogger, notificationForwarder } from "../hooks.js";

vi.mock("../event-journal.js", () => ({
  appendEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../callback.js", () => ({
  forwardAgentNotification: vi.fn(),
}));

function makePreToolUseInput(
  toolName: string,
  toolInput: Record<string, unknown>,
): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "test-session",
    transcript_path: "/tmp/test",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "test-tool-use",
  };
}

describe("auditLogger", () => {
  it("should return async output", async () => {
    const input = makePreToolUseInput("Bash", { command: "ls" });
    const result = await auditLogger(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result).toHaveProperty("async", true);
    expect(result).toHaveProperty("asyncTimeout", 5_000);
  });
});

describe("notificationForwarder", () => {
  it("should return empty for non-Notification events", async () => {
    const input = makePreToolUseInput("Bash", { command: "ls" });
    const result = await notificationForwarder(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result).toEqual({});
  });

  it("should forward notification events", async () => {
    const input: NotificationHookInput = {
      hook_event_name: "Notification",
      session_id: "test-session",
      transcript_path: "/tmp/test",
      cwd: "/tmp",
      message: "Task completed",
    };
    const result = await notificationForwarder(
      input,
      "test",
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result).toHaveProperty("async", true);
  });
});
