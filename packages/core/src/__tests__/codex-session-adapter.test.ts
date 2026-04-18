import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEvents = vi.fn();
const mockRunStreamed = vi.fn(() => Promise.resolve({ events: mockEvents() }));
const mockThread = { runStreamed: mockRunStreamed, id: "thread_123" };
const mockStartThread = vi.fn(() => mockThread);

vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn(() => ({ startThread: mockStartThread })),
}));

import { CodexAgentRunner } from "@/runner/adapters/codex-session";
import type { SDKStreamMessage } from "@/sdk-types";

describe("CodexAgentRunner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps SDK ThreadEvents to SDKStreamMessages", async () => {
    mockEvents.mockReturnValue(
      (async function* () {
        yield { type: "thread.started", thread_id: "t_1" };
        yield {
          type: "item.completed",
          item: { id: "i_0", type: "agent_message", text: "hello" },
        };
        yield {
          type: "turn.completed",
          usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
        };
      })(),
    );

    const runner = new CodexAgentRunner();
    const messages: SDKStreamMessage[] = [];

    for await (const msg of runner.run({
      prompt: "test",
      cwd: "/tmp",
      sandboxConfig: { writable: true, paths: { readable: [], writable: [] } },
    })) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ type: "system", subtype: "init", session_id: "t_1" });
    expect(messages[1]).toMatchObject({ type: "assistant" });
    expect(messages[2]).toMatchObject({ type: "result", subtype: "success" });
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxMode: "workspace-write", approvalPolicy: "never" }),
    );
  });
});
