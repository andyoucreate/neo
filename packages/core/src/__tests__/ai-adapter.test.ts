import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "@/supervisor/adapters/claude";

describe("ClaudeAdapter", () => {
  it("starts with no session handle", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.getSessionHandle()).toBeUndefined();
  });

  it("restores a claude session handle", () => {
    const adapter = new ClaudeAdapter();
    const handle = { provider: "claude" as const, sessionId: "ses_abc123" };
    adapter.restoreSession(handle);
    expect(adapter.getSessionHandle()).toEqual(handle);
  });

  it("rejects non-claude session handles", () => {
    const adapter = new ClaudeAdapter();
    expect(() =>
      // @ts-expect-error intentional wrong type for testing
      adapter.restoreSession({ provider: "openai", threadId: "t_1" }),
    ).toThrow("ClaudeAdapter only accepts claude session handles");
  });
});
