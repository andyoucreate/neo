import type { AgentConfig } from "@/agents/schema";
import type { AgentDefinition, ResolvedAgent } from "@/types";

export function resolveAgent(config: AgentConfig): ResolvedAgent {
  if (!config.description) {
    throw new Error(
      `Agent "${config.name}" is missing "description". Add a 'description' field to the agent YAML.`,
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
    ...(config.model ? { model: config.model } : {}),
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
