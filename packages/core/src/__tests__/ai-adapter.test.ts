import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "@/supervisor/adapters/claude";
import type { SessionHandle, SupervisorMessage } from "@/supervisor/ai-adapter";

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

describe("ai-adapter types", () => {
  it("SessionHandle accepts claude provider", () => {
    const handle: SessionHandle = { provider: "claude", sessionId: "abc" };
    expect(handle.provider).toBe("claude");
  });

  it("SessionHandle accepts codex provider", () => {
    const handle: SessionHandle = { provider: "codex", threadId: "thread_123" };
    expect(handle.provider).toBe("codex");
  });

  it("SupervisorMessage supports metadata on end kind", () => {
    const msg: SupervisorMessage = {
      kind: "end",
      metadata: { costUsd: 0.05, turnCount: 3 },
    };
    expect(msg.metadata?.costUsd).toBe(0.05);
    expect(msg.metadata?.turnCount).toBe(3);
  });

  it("SupervisorMessage metadata is optional", () => {
    const msg: SupervisorMessage = { kind: "end" };
    expect(msg.metadata).toBeUndefined();
  });
});
