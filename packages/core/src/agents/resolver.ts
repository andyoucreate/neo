import type { AgentConfig } from "@/agents/schema";
import type { AgentDefinition, ResolvedAgent } from "@/types";

/**
 * Resolve an agent config into a ResolvedAgent.
 * All fields must be defined — no inheritance.
 * TODO(Task 2): update resolver logic for provider-agnostic schema (no tools, no model enum)
 */
export function resolveAgent(config: AgentConfig): ResolvedAgent {
  let prompt = config.prompt;
  if (config.promptAppend) {
    prompt = `${prompt}\n\n${config.promptAppend}`;
  }

  const definition: AgentDefinition = {
    description: config.description,
    prompt,
    tools: [],
    model: config.model ?? "",
    ...(config.mcpServers?.length ? { mcpServers: config.mcpServers } : {}),
  };

  return {
    name: config.name,
    definition,
    sandbox: config.sandbox,
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    ...(config.maxCost !== undefined ? { maxCost: config.maxCost } : {}),
    ...(config.version !== undefined ? { version: config.version } : {}),
    source: "custom",
  };
}
