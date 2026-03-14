import { existsSync } from "node:fs";
import path from "node:path";
import { AgentRegistry } from "@neo-cli/core";
import { printError, printJson, printTable } from "../output.js";
import { resolveAgentsDir } from "../resolve.js";

export async function runAgents(jsonOutput: boolean): Promise<void> {
  const builtInDir = resolveAgentsDir();
  const customDir = path.resolve(".neo/agents");

  if (!existsSync(builtInDir)) {
    printError("Agent definitions not found. Is @neo-cli/agents installed?");
    process.exit(1);
  }

  const registry = new AgentRegistry(builtInDir, existsSync(customDir) ? customDir : undefined);
  await registry.load();

  const agents = registry.list();

  if (jsonOutput) {
    printJson(
      agents.map((a) => ({
        name: a.name,
        model: a.definition.model,
        sandbox: a.sandbox,
        source: a.source,
      })),
    );
    return;
  }

  printTable(
    ["NAME", "MODEL", "SANDBOX", "SOURCE"],
    agents.map((a) => [a.name, a.definition.model, a.sandbox, a.source]),
  );
}
