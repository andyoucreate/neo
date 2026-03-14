import type { AgentConfig, AgentTool } from "@/agents/schema";
import type { AgentDefinition, ResolvedAgent } from "@/types";

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
  const isExtending = extendsName !== undefined;

  if (isExtending) {
    const base = builtIns.get(extendsName);
    if (!base) {
      throw new Error(
        `Agent "${config.name}" extends "${extendsName}", but no built-in agent with that name exists.`,
      );
    }

    // Merge tools
    let tools: string[];
    if (config.tools) {
      if (config.tools.includes("$inherited")) {
        // Keep inherited tools + add new ones
        const baseTols = base.tools ?? [];
        const newTools = config.tools.filter((t) => t !== "$inherited");
        tools = [...baseTols, ...newTools] as string[];
      } else {
        // Full replacement
        tools = config.tools as string[];
      }
    } else {
      tools = (base.tools ?? []) as string[];
    }

    // Merge prompt
    let prompt: string;
    if (config.prompt) {
      prompt = config.prompt;
    } else {
      prompt = base.prompt ?? "";
    }
    if (config.promptAppend) {
      prompt = `${prompt}\n\n${config.promptAppend}`;
    }

    const definition: AgentDefinition = {
      description: config.description ?? base.description ?? "",
      prompt,
      tools,
      model: config.model ?? base.model ?? "sonnet",
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
      source: config.name === extendsName && !config.extends ? "built-in" : "extended",
    };
  }

  // No extends — fully custom agent
  if (!config.description) {
    throw new Error(
      `Agent "${config.name}" has no "extends" and no "description". Custom agents must define all required fields.`,
    );
  }
  if (!config.model) {
    throw new Error(
      `Agent "${config.name}" has no "extends" and no "model". Custom agents must define all required fields.`,
    );
  }
  if (!config.tools) {
    throw new Error(
      `Agent "${config.name}" has no "extends" and no "tools". Custom agents must define all required fields.`,
    );
  }
  if (!config.sandbox) {
    throw new Error(
      `Agent "${config.name}" has no "extends" and no "sandbox". Custom agents must define all required fields.`,
    );
  }
  if (!config.prompt) {
    throw new Error(
      `Agent "${config.name}" has no "extends" and no "prompt". Custom agents must define all required fields.`,
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
  };

  return {
    name: config.name,
    definition,
    sandbox: config.sandbox,
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    source: "custom",
  };
}
