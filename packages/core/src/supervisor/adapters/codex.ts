import type { AIAdapter, AIQueryOptions, SessionHandle, SupervisorMessage } from "../ai-adapter.js";

export class CodexAdapter implements AIAdapter {
  private codex: unknown;
  private threadId: string | undefined;

  private async getCodex(): Promise<unknown> {
    if (!this.codex) {
      // @ts-expect-error — @openai/codex-sdk is an optional peer dependency; the import
      // is deferred to runtime so the adapter can be constructed safely without it.
      const { Codex } = await import("@openai/codex-sdk");
      this.codex = new Codex();
    }
    return this.codex;
  }

  getSessionHandle(): SessionHandle | undefined {
    if (!this.threadId) return undefined;
    return { provider: "codex", threadId: this.threadId };
  }

  restoreSession(handle: SessionHandle): void {
    if (handle.provider !== "codex") {
      throw new Error("CodexAdapter only accepts codex session handles");
    }
    this.threadId = handle.threadId;
  }

  async *query(options: AIQueryOptions): AsyncIterable<SupervisorMessage> {
    const codex = (await this.getCodex()) as {
      startThread: (opts: Record<string, unknown>) => {
        runStreamed: (prompt: string) => AsyncIterable<unknown>;
      };
      resumeThread: (id: string) => { runStreamed: (prompt: string) => AsyncIterable<unknown> };
    };

    const thread = this.threadId
      ? codex.resumeThread(this.threadId)
      : codex.startThread({
          ...(options.model ? { model: options.model } : {}),
        });

    for await (const event of thread.runStreamed(options.prompt)) {
      const e = event as Record<string, unknown>;

      if (e.type === "item.completed") {
        const item = e.item as Record<string, unknown>;

        if (item.type === "message") {
          const content = item.content as Array<{ type: string; text?: string }>;
          for (const block of content) {
            if (block.type === "text" && block.text) {
              yield { kind: "text", text: block.text };
            }
          }
        }

        if (item.type === "function_call") {
          const name = item.name as string;
          let input: unknown;
          try {
            input = JSON.parse(item.arguments as string);
          } catch {
            input = item.arguments;
          }
          yield { kind: "tool_use", toolName: name, toolInput: input };
        }
      }

      if (e.type === "turn.completed") {
        const usage = e.usage as { total_cost_usd?: number; turn_count?: number } | undefined;
        yield {
          kind: "end",
          metadata: {
            costUsd: usage?.total_cost_usd ?? 0,
            turnCount: usage?.turn_count ?? 0,
          },
        };
      }
    }
  }
}
