import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentConfig } from "./schema.js";
import { agentConfigSchema } from "./schema.js";

/**
 * Load a single agent definition from a YAML file.
 * If the `prompt` field points to a .md file, resolve it relative
 * to the YAML file's directory and read its content.
 */
export async function loadAgentFile(filePath: string): Promise<AgentConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
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
    } catch {
      throw new Error(`Prompt file not found: ${promptPath} (referenced in ${filePath})`);
    }
  }

  return config;
}
