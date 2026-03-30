import type { AgentConfig, AgentTool } from "@/agents/schema";
import type { AgentDefinition, ResolvedAgent, SubagentDefinition } from "@/types";

/**
 * Resolve an agent config into a ResolvedAgent.
 * All fields must be defined — no inheritance.
 */
export function resolveAgent(config: AgentConfig): ResolvedAgent {
  if (!config.description) {
    throw new Error(
      `Agent "${config.name}" is missing "description". Add a 'description' field to the agent YAML.`,
    );
  }
  if (!config.model) {
    throw new Error(
      `Agent "${config.name}" is missing "model". Add a 'model' field (e.g., 'sonnet').`,
    );
  }
  if (!config.tools || config.tools.length === 0) {
    throw new Error(
      `Agent "${config.name}" is missing "tools". Add a 'tools' array to the agent YAML.`,
    );
  }
  if (!config.sandbox) {
    throw new Error(
      `Agent "${config.name}" is missing "sandbox". Add a 'sandbox' field ('writable' or 'readonly').`,
    );
  }
  if (!config.prompt) {
    throw new Error(
      `Agent "${config.name}" is missing "prompt". Add a 'prompt' field or 'promptFile' reference.`,
    );
  }

  let prompt = config.prompt;
  if (config.promptAppend) {
    prompt = `${prompt}\n\n${config.promptAppend}`;
  }

  const definition: AgentDefinition = {
    description: config.description,
    prompt,
    tools: config.tools as AgentTool[],
    model: config.model,
    ...(config.mcpServers?.length ? { mcpServers: config.mcpServers } : {}),
    ...(config.agents ? { agents: config.agents as Record<string, SubagentDefinition> } : {}),
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
