import type { AgentConfig, AgentTool } from "@/agents/schema";
import type { AgentDefinition, ResolvedAgent, SubagentDefinition } from "@/types";

/**
 * Resolve an agent config into a fully-merged ResolvedAgent.
 *
 * Resolution rules:
 * 1. No `extends` → agent must define all required fields
 * 2. With `extends: "developer"` → start from built-in, apply overrides
 * 3. Same name as built-in without `extends:` → treated as `extends: <name>` implicitly
 */
export function resolveAgent(
  config: AgentConfig,
  builtIns: Map<string, AgentConfig>,
): ResolvedAgent {
  const extendsName =
    config.extends ??
    (builtIns.has(config.name) && config.extends === undefined ? config.name : undefined);

  if (extendsName !== undefined) {
    return resolveExtendedAgent(config, extendsName, builtIns);
  }

  return resolveCustomAgent(config);
}

// ─── Extended agent (inherits from built-in) ────────────

function resolveExtendedAgent(
  config: AgentConfig,
  extendsName: string,
  builtIns: Map<string, AgentConfig>,
): ResolvedAgent {
  const base = builtIns.get(extendsName);

  if (!base) {
    throw new Error(
      `Agent "${config.name}" extends "${extendsName}", but no built-in agent with that name exists.`,
    );
  }

  const tools = mergeTools(config.tools, base.tools);
  const prompt = mergePrompt(config.prompt, config.promptAppend, base.prompt);
  const mcpServers = mergeMcpServerNames(base.mcpServers, config.mcpServers);
  const agents = mergeAgents(
    base.agents as Record<string, SubagentDefinition> | undefined,
    config.agents as Record<string, SubagentDefinition> | undefined,
  );

  const definition: AgentDefinition = {
    description: config.description ?? base.description ?? "",
    prompt,
    tools,
    model: config.model ?? base.model ?? "sonnet",
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(agents ? { agents } : {}),
  };

  return {
    name: config.name,
    definition,
    sandbox: config.sandbox ?? base.sandbox ?? "readonly",
    ...(config.maxTurns !== undefined
      ? { maxTurns: config.maxTurns }
      : base.maxTurns !== undefined
        ? { maxTurns: base.maxTurns }
        : {}),
    ...(config.version !== undefined
      ? { version: config.version }
      : base.version !== undefined
        ? { version: base.version }
        : {}),
    source: config.name === extendsName && !config.extends ? "built-in" : "extended",
  };
}

// ─── Custom agent (no inheritance) ──────────────────────

function resolveCustomAgent(config: AgentConfig): ResolvedAgent {
  if (!config.description) {
    throw new Error(
      `Agent "${config.name}" has no "extends" and no "description". Add a 'description' field to the agent YAML.`,
    );
  }
  if (!config.model) {
    throw new Error(
      `Agent "${config.name}" has no "extends" and no "model". Add a 'model' field (e.g., 'claude-sonnet-4-20250514').`,
    );
  }
  if (!config.tools) {
    throw new Error(
      `Agent "${config.name}" has no "extends" and no "tools". Add a 'tools' array to the agent YAML.`,
    );
  }
  if (!config.sandbox) {
    throw new Error(
      `Agent "${config.name}" has no "extends" and no "sandbox". Add a 'sandbox' field ('full' or 'permissive').`,
    );
  }
  if (!config.prompt) {
    throw new Error(
      `Agent "${config.name}" has no "extends" and no "prompt". Add a 'prompt' field or 'promptFile' reference.`,
    );
  }

  // Filter out $inherited from tools (shouldn't be there without extends, but be safe)
  const tools = config.tools.filter((t): t is AgentTool => t !== "$inherited");

  let prompt = config.prompt;
  if (config.promptAppend) {
    prompt = `${prompt}\n\n${config.promptAppend}`;
  }

  const definition: AgentDefinition = {
    description: config.description,
    prompt,
    tools,
    model: config.model,
    ...(config.mcpServers?.length ? { mcpServers: config.mcpServers } : {}),
    ...(config.agents ? { agents: config.agents as Record<string, SubagentDefinition> } : {}),
  };

  return {
    name: config.name,
    definition,
    sandbox: config.sandbox,
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    ...(config.version !== undefined ? { version: config.version } : {}),
    source: "custom",
  };
}

// ─── Helpers ────────────────────────────────────────────

function mergeTools(configTools: AgentConfig["tools"], baseTools: AgentConfig["tools"]): string[] {
  if (!configTools) return (baseTools ?? []) as string[];
  if (configTools.includes("$inherited")) {
    const newTools = configTools.filter((t) => t !== "$inherited");
    return [...(baseTools ?? []), ...newTools] as string[];
  }
  return configTools as string[];
}

function mergePrompt(
  configPrompt: string | undefined,
  promptAppend: string | undefined,
  basePrompt: string | undefined,
): string {
  let prompt = configPrompt ?? basePrompt ?? "";
  if (promptAppend) {
    prompt = `${prompt}\n\n${promptAppend}`;
  }
  return prompt;
}

function mergeMcpServerNames(base: string[] | undefined, override: string[] | undefined): string[] {
  if (!base?.length && !override?.length) return [];
  return [...new Set([...(base ?? []), ...(override ?? [])])];
}

function mergeAgents(
  base: Record<string, SubagentDefinition> | undefined,
  override: Record<string, SubagentDefinition> | undefined,
): Record<string, SubagentDefinition> | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}
