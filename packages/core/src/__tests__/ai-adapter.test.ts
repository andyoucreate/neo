import { describe, expect, it } from "vitest";
import type { SDKStreamMessage } from "@/sdk-types";
import type { AgentRunner, AgentRunOptions } from "@/supervisor/ai-adapter";

describe("AgentRunner interface", () => {
  it("can be implemented with a mock", async () => {
    const mockRunner: AgentRunner = {
      async *run(_options: AgentRunOptions): AsyncIterable<SDKStreamMessage> {
        yield { type: "system", subtype: "init", session_id: "test" } as SDKStreamMessage;
        yield { type: "result", subtype: "success" } as SDKStreamMessage;
      },
    };

    const messages: SDKStreamMessage[] = [];
    for await (const msg of mockRunner.run({
      prompt: "test",
      cwd: "/tmp",
      sandboxConfig: { writable: true, paths: { readable: [], writable: [] } },
    })) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(messages[1]).toMatchObject({ type: "result", subtype: "success" });
  });
});
