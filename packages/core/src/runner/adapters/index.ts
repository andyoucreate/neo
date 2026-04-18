import type { ProviderConfig } from "@/config";
import type { AgentRunner } from "@/supervisor/ai-adapter";
import { ClaudeAgentRunner } from "./claude-session.js";
import { CodexAgentRunner } from "./codex-session.js";

export interface AgentRunnerFactory {
  create(config: ProviderConfig): AgentRunner;
}

const registry = new Map<string, AgentRunnerFactory>();

registry.set("claude", {
  create: () => new ClaudeAgentRunner(),
});

registry.set("codex", {
  create: () => new CodexAgentRunner(),
});

export function createAgentRunner(config: ProviderConfig): AgentRunner {
  const factory = registry.get(config.adapter);
  if (!factory) {
    throw new Error(
      `Unknown adapter "${config.adapter}". Available: ${[...registry.keys()].join(", ")}`,
    );
  }
  return factory.create(config);
}

export function registerAdapter(name: string, factory: AgentRunnerFactory): void {
  registry.set(name, factory);
}

export { ClaudeAgentRunner } from "./claude-session.js";
export { CodexAgentRunner } from "./codex-session.js";
