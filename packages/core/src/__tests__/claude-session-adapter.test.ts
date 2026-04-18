import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(function* () {
    yield { type: "system", subtype: "init", session_id: "test-session-123" };
    yield {
      type: "result",
      subtype: "success",
      session_id: "test-session-123",
      result: "done",
      total_cost_usd: 0.05,
      num_turns: 2,
    };
  }),
}));

import { ClaudeAgentRunner } from "@/runner/adapters/claude-session";
import type { SDKStreamMessage } from "@/sdk-types";

describe("ClaudeAgentRunner", () => {
  it("yields SDKStreamMessages from Claude SDK", async () => {
    const runner = new ClaudeAgentRunner();
    const messages: SDKStreamMessage[] = [];

    const stream = runner.run({
      prompt: "test prompt",
      cwd: "/tmp/test",
      sandboxConfig: {
        writable: false,
        paths: { readable: [], writable: [] },
      },
    });

    for await (const msg of stream) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(messages[1]).toMatchObject({ type: "result", subtype: "success" });
  });
});
