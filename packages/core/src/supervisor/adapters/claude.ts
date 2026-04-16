import { query } from "@anthropic-ai/claude-agent-sdk";
import { isAssistantMessage, isInitMessage, isResultMessage, isToolUseMessage } from "@/sdk-types";
import type { AIAdapter, AIQueryOptions, SessionHandle, SupervisorMessage } from "../ai-adapter.js";

export class ClaudeAdapter implements AIAdapter {
  private sessionHandle: SessionHandle | undefined;

  getSessionHandle(): SessionHandle | undefined {
    return this.sessionHandle;
  }

  restoreSession(handle: SessionHandle): void {
    if (handle.provider !== "claude") {
      throw new Error("ClaudeAdapter only accepts claude session handles");
    }
    this.sessionHandle = handle;
  }

  async *query(options: AIQueryOptions): AsyncIterable<SupervisorMessage> {
    const sdkTools = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Record<string, unknown>,
    }));

    // Use `as never` to bypass SDK's strict tools type — the SDK runtime accepts
    // JSON Schema tool definitions even though the TypeScript types only expose
    // built-in tool names. This mirrors the pattern used in heartbeat.ts.
    const queryOptions = {
      prompt: options.prompt,
      options: {
        tools: sdkTools,
        ...(options.model ? { model: options.model } : {}),
        ...(this.sessionHandle?.provider === "claude"
          ? { resume: this.sessionHandle.sessionId }
          : {}),
      },
    };

    for await (const message of query(queryOptions as never)) {
      if (isInitMessage(message)) {
        this.sessionHandle = { provider: "claude", sessionId: message.session_id };
        continue;
      }

      if (isToolUseMessage(message)) {
        yield {
          kind: "tool_use",
          toolName: message.tool,
          toolInput: message.input,
        };
        continue;
      }

      if (isAssistantMessage(message)) {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && block.text !== undefined) {
            yield { kind: "text", text: block.text };
          }
        }
        continue;
      }

      if (isResultMessage(message)) {
        yield {
          kind: "end",
          metadata: {
            costUsd: message.total_cost_usd ?? 0,
            turnCount: message.num_turns ?? 0,
          },
        };
      }
    }
  }
}
