import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunStreamed = vi.fn();
const mockStartThread = vi.fn(() => ({ runStreamed: mockRunStreamed }));
const mockResumeThread = vi.fn(() => ({ runStreamed: mockRunStreamed }));

vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn(() => ({
    startThread: mockStartThread,
    resumeThread: mockResumeThread,
  })),
}));

import { CodexAdapter } from "@/supervisor/adapters/codex";
import type { SupervisorMessage } from "@/supervisor/ai-adapter";

describe("CodexAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("yields text messages from Codex stream", async () => {
    mockRunStreamed.mockReturnValue(
      (async function* () {
        yield {
          type: "item.completed",
          item: { type: "message", content: [{ type: "text", text: "hello" }] },
        };
        yield {
          type: "turn.completed",
          usage: { total_cost_usd: 0.02, turn_count: 1 },
        };
      })(),
    );

    const adapter = new CodexAdapter();
    const messages: SupervisorMessage[] = [];
    for await (const msg of adapter.query({ prompt: "test", tools: [] })) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ kind: "text", text: "hello" });
    expect(messages[1]).toEqual({ kind: "end", metadata: { costUsd: 0.02, turnCount: 1 } });
  });

  it("yields tool_use messages", async () => {
    mockRunStreamed.mockReturnValue(
      (async function* () {
        yield {
          type: "item.completed",
          item: {
            type: "function_call",
            name: "dispatch_agent",
            arguments: '{"agent":"coder","prompt":"fix bug"}',
          },
        };
        yield { type: "turn.completed", usage: { total_cost_usd: 0, turn_count: 1 } };
      })(),
    );

    const adapter = new CodexAdapter();
    const messages: SupervisorMessage[] = [];
    for await (const msg of adapter.query({ prompt: "test", tools: [] })) {
      messages.push(msg);
    }

    expect(messages[0]).toEqual({
      kind: "tool_use",
      toolName: "dispatch_agent",
      toolInput: { agent: "coder", prompt: "fix bug" },
    });
  });

  it("starts a new thread on first query", async () => {
    mockRunStreamed.mockReturnValue(
      (async function* () {
        yield { type: "turn.completed", usage: { total_cost_usd: 0, turn_count: 0 } };
      })(),
    );

    const adapter = new CodexAdapter();
    for await (const _ of adapter.query({ prompt: "test", tools: [] })) {
      /* drain */
    }

    expect(mockStartThread).toHaveBeenCalled();
    expect(mockResumeThread).not.toHaveBeenCalled();
  });

  it("resumes thread when session is restored", async () => {
    mockRunStreamed.mockReturnValue(
      (async function* () {
        yield { type: "turn.completed", usage: { total_cost_usd: 0, turn_count: 0 } };
      })(),
    );

    const adapter = new CodexAdapter();
    adapter.restoreSession({ provider: "codex", threadId: "thread_abc" });
    for await (const _ of adapter.query({ prompt: "test", tools: [] })) {
      /* drain */
    }

    expect(mockResumeThread).toHaveBeenCalledWith("thread_abc");
    expect(mockStartThread).not.toHaveBeenCalled();
  });

  it("rejects non-codex session handles", () => {
    const adapter = new CodexAdapter();
    expect(() => adapter.restoreSession({ provider: "claude", sessionId: "abc" })).toThrow(
      "CodexAdapter only accepts codex session handles",
    );
  });
});
