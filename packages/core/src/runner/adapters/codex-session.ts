import type {
  Codex as CodexClass,
  ItemCompletedEvent,
  ThreadEvent,
  TurnCompletedEvent,
  Usage,
} from "@openai/codex-sdk";
import type { SDKStreamMessage } from "@/sdk-types";
import type { AgentRunner, AgentRunOptions } from "@/supervisor/ai-adapter";

function estimateCost(usage: Usage): number {
  const inputCost = (usage.input_tokens - usage.cached_input_tokens) * 0.0000015;
  const cachedCost = usage.cached_input_tokens * 0.00000075;
  const outputCost = usage.output_tokens * 0.000006;
  return inputCost + cachedCost + outputCost;
}

function mapThreadEvent(event: ThreadEvent): SDKStreamMessage | null {
  switch (event.type) {
    case "thread.started":
      return {
        type: "system",
        subtype: "init",
        session_id: event.thread_id,
      } as SDKStreamMessage;

    case "item.completed": {
      const item = (event as ItemCompletedEvent).item;

      if (item.type === "agent_message") {
        return {
          type: "assistant",
          message: { content: [{ type: "text", text: item.text }] },
        } as SDKStreamMessage;
      }

      if (item.type === "command_execution") {
        return {
          type: "assistant",
          subtype: "tool_use",
          tool: "Bash",
          input: { command: item.command },
        } as SDKStreamMessage;
      }

      if (item.type === "mcp_tool_call") {
        return {
          type: "assistant",
          subtype: "tool_use",
          tool: `${item.server}/${item.tool}`,
          input: item.arguments,
        } as SDKStreamMessage;
      }

      return null;
    }

    case "turn.completed": {
      const usage = (event as TurnCompletedEvent).usage;
      return {
        type: "result",
        subtype: "success",
        session_id: "codex",
        result: "",
        total_cost_usd: estimateCost(usage),
        num_turns: 1,
      } as SDKStreamMessage;
    }

    case "turn.failed":
      return {
        type: "result",
        subtype: "error",
        session_id: "codex",
        result: event.error.message,
        total_cost_usd: 0,
        num_turns: 0,
      } as SDKStreamMessage;

    default:
      return null;
  }
}

export class CodexAgentRunner implements AgentRunner {
  private codex: CodexClass | undefined;

  private async getCodex(): Promise<CodexClass> {
    if (!this.codex) {
      const { Codex } = await import("@openai/codex-sdk");
      this.codex = new Codex();
    }
    return this.codex;
  }

  async *run(options: AgentRunOptions): AsyncIterable<SDKStreamMessage> {
    const codex = await this.getCodex();

    const thread = codex.startThread({
      ...(options.model ? { model: options.model } : {}),
      workingDirectory: options.cwd,
      sandboxMode: options.sandboxConfig.writable ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      webSearchEnabled: true,
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
      ...(options.providerConfig?.args?.length
        ? { additionalDirectories: options.providerConfig.args }
        : {}),
    });

    const { events } = await thread.runStreamed(options.prompt);

    for await (const event of events) {
      const mapped = mapThreadEvent(event as ThreadEvent);
      if (mapped) yield mapped;
    }
  }
}
