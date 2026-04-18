import { existsSync } from "node:fs";
import path from "node:path";
import { AgentRegistry } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printTable } from "../output.js";
import { resolveAgentsDir } from "../resolve.js";

export default defineCommand({
  meta: {
    name: "agents",
    description: "List available agents (built-in and custom from .neo/agents/)",
  },
  args: {
    output: {
      type: "string",
      description: "Output format: json",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";
    const builtInDir = resolveAgentsDir();
    const customDir = path.resolve(".neo/agents");

    if (!existsSync(builtInDir)) {
      printError("Agent definitions not found. Is @neotx/agents installed?");
      process.exitCode = 1;
      return;
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
      agents.map((a) => [a.name, a.definition.model ?? "(default)", a.sandbox, a.source]),
    );
  },
});
