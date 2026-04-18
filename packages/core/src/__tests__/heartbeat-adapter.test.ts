import { describe, expect, it } from "vitest";
import type { SDKStreamMessage } from "@/sdk-types";
import type { AgentRunner, AgentRunOptions } from "@/supervisor/ai-adapter";

class MockAgentRunner implements AgentRunner {
  public lastPrompt = "";
  public callCount = 0;

  async *run(options: AgentRunOptions): AsyncIterable<SDKStreamMessage> {
    this.lastPrompt = options.prompt;
    this.callCount++;
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "mock response" }] },
    } as SDKStreamMessage;
    yield {
      type: "result",
      subtype: "success",
      session_id: "mock",
      result: "",
      total_cost_usd: 0.01,
      num_turns: 1,
    } as SDKStreamMessage;
  }
}

describe("HeartbeatLoop AgentRunner integration", () => {
  it("MockAgentRunner yields SDKStreamMessages", async () => {
    const runner = new MockAgentRunner();
    const messages: SDKStreamMessage[] = [];
    for await (const msg of runner.run({
      prompt: "test",
      cwd: "/tmp",
      sandboxConfig: { writable: true, paths: { readable: [], writable: [] } },
    })) {
      messages.push(msg);
    }
    expect(runner.callCount).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: "assistant" });
    expect(messages[1]).toMatchObject({ type: "result", subtype: "success" });
  });
});
