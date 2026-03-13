import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ResolvedAgent } from "../types.js";
import { loadAgentFile } from "./loader.js";
import { resolveAgent } from "./resolver.js";
import type { AgentConfig } from "./schema.js";

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
      } catch {
        // Custom dir doesn't exist — that's fine
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
  const ymlFiles = entries.filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  const configs: AgentConfig[] = [];
  for (const file of ymlFiles) {
    const config = await loadAgentFile(path.join(dir, file));
    configs.push(config);
  }
  return configs;
}
