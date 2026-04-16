import { describe, expect, it } from "vitest";
import type {
  AIAdapter,
  AIQueryOptions,
  SessionHandle,
  SupervisorMessage,
} from "@/supervisor/ai-adapter";

class MockAdapter implements AIAdapter {
  public lastPrompt = "";
  public callCount = 0;
  private handle: SessionHandle | undefined;

  getSessionHandle(): SessionHandle | undefined {
    return this.handle;
  }
  restoreSession(handle: SessionHandle): void {
    this.handle = handle;
  }

  async *query(options: AIQueryOptions): AsyncIterable<SupervisorMessage> {
    this.lastPrompt = options.prompt;
    this.callCount++;
    yield { kind: "text", text: "mock response" };
    yield { kind: "end", metadata: { costUsd: 0.01, turnCount: 1 } };
  }
}

describe("HeartbeatLoop adapter integration", () => {
  it("MockAdapter yields structured messages", async () => {
    const adapter = new MockAdapter();
    const messages: SupervisorMessage[] = [];
    for await (const msg of adapter.query({ prompt: "test", tools: [] })) {
      messages.push(msg);
    }
    expect(adapter.callCount).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ kind: "text", text: "mock response" });
    expect(messages[1]).toEqual({ kind: "end", metadata: { costUsd: 0.01, turnCount: 1 } });
  });
});
