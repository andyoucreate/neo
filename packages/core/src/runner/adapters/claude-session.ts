import type { SDKStreamMessage } from "@/sdk-types";
import type { AgentRunner, AgentRunOptions } from "@/supervisor/ai-adapter";

export class ClaudeAgentRunner implements AgentRunner {
  async *run(options: AgentRunOptions): AsyncIterable<SDKStreamMessage> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    const queryOptions: Record<string, unknown> = {
      cwd: options.cwd,
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
      // Workers run detached without a TTY — bypass interactive permission prompts.
      // Required pair: permissionMode alone is not enough, SDK also needs the flag.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Load project-level CLAUDE.md so agents inherit project rules and conventions.
      settingSources: ["user", "project", "local"],
      // Don't persist agent sessions — they are ephemeral clones.
      persistSession: false,
    };

    if (options.resumeSessionId) {
      queryOptions.resume = options.resumeSessionId;
    }

    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      queryOptions.mcpServers = options.mcpServers;
    }

    if (options.env && Object.keys(options.env).length > 0) {
      // Merge with process.env so PATH, HOME, etc. are preserved.
      // Custom vars override process.env if there's a conflict.
      queryOptions.env = { ...process.env, ...options.env };
    }

    if (options.model) {
      queryOptions.model = options.model;
    }

    const stream = sdk.query({ prompt: options.prompt, options: queryOptions as never });

    for await (const message of stream) {
      yield message as SDKStreamMessage;
    }
  }
}
