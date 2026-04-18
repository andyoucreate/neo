import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentConfig } from "@/agents/schema";
import { agentConfigSchema } from "@/agents/schema";

/**
 * Load a single agent definition from a YAML file.
 * If the `prompt` field points to a .md file, resolve it relative
 * to the YAML file's directory and read its content.
 */
export async function loadAgentFile(filePath: string): Promise<AgentConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    console.debug(
      `[agents/loader] Failed to read agent file: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw new Error(`Agent file not found: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Invalid YAML in agent file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = agentConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid agent config in ${filePath}:\n${issues}`);
  }

  const config = result.data;

  // If prompt points to a .md file, read it
  if (config.prompt?.endsWith(".md")) {
    const promptPath = path.resolve(path.dirname(filePath), config.prompt);
    try {
      config.prompt = await readFile(promptPath, "utf-8");
    } catch (err) {
      // Expected error: prompt file not found
      throw new Error(
        `Prompt file not found: ${promptPath} (referenced in ${filePath}). Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return config;
}
