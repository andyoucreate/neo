import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadAgentFile } from "@/agents/loader";
import { resolveAgent } from "@/agents/resolver";
import type { AgentConfig } from "@/agents/schema";
import type { ResolvedAgent } from "@/types";

export class AgentRegistry {
  private readonly builtInDir: string;
  private readonly customDir: string | undefined;
  private agents = new Map<string, ResolvedAgent>();

  constructor(builtInDir: string, customDir?: string) {
    this.builtInDir = builtInDir;
    this.customDir = customDir;
  }

  async load(): Promise<void> {
    this.agents.clear();

    // Load built-in agents
    const builtInConfigs = await loadAgentsFromDir(this.builtInDir);
    const builtInMap = new Map<string, AgentConfig>();
    for (const config of builtInConfigs) {
      builtInMap.set(config.name, config);
    }

    // Resolve built-in agents
    for (const config of builtInConfigs) {
      const resolved = resolveAgent(config, builtInMap);
      // Force built-in source for agents loaded from the built-in dir
      this.agents.set(config.name, { ...resolved, source: "built-in" });
    }

    // Load custom agents (if directory exists)
    if (this.customDir) {
      let customConfigs: AgentConfig[];
      try {
        customConfigs = await loadAgentsFromDir(this.customDir);
      } catch (err) {
        // Custom dir doesn't exist — that's fine
        // biome-ignore lint/suspicious/noConsole: debug logging for missing custom agents dir
        console.debug(
          `[registry] Custom agents dir not found: ${err instanceof Error ? err.message : String(err)}`,
        );
        customConfigs = [];
      }

      for (const config of customConfigs) {
        const resolved = resolveAgent(config, builtInMap);
        this.agents.set(config.name, resolved);
      }
    }
  }

  get(name: string): ResolvedAgent | undefined {
    return this.agents.get(name);
  }

  list(): ResolvedAgent[] {
    return [...this.agents.values()];
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }
}

async function loadAgentsFromDir(dir: string): Promise<AgentConfig[]> {
  const entries = await readdir(dir);
  const ymlFiles = entries.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  const configs: AgentConfig[] = [];
  for (const file of ymlFiles) {
    const config = await loadAgentFile(path.join(dir, file));
    configs.push(config);
  }
  return configs;
}
