import { existsSync } from "node:fs";
import path from "node:path";
import type { NeoEvent } from "@neo-cli/core";
import { AgentRegistry, loadConfig, Orchestrator } from "@neo-cli/core";
import { defineCommand } from "citty";
import { printError, printJson } from "../output.js";
import { resolveAgentsDir } from "../resolve.js";

function printProgress(event: NeoEvent): void {
  const ts = event.timestamp.slice(11, 19);
  switch (event.type) {
    case "session:start":
      console.log(`[${ts}] ${event.agent}: starting`);
      break;
    case "session:complete":
      console.log(`[${ts}] session complete: $${event.costUsd.toFixed(4)}`);
      break;
    case "session:fail":
      console.log(`[${ts}] session failed: ${event.error}`);
      break;
    case "cost:update":
      break;
    case "budget:alert":
      console.log(`[${ts}] ⚠ Budget alert: ${event.utilizationPct.toFixed(0)}% used`);
      break;
  }
}

function parseMetadata(meta: string | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch {
    printError(`Invalid --meta JSON: ${meta}`);
    process.exit(1);
  }
}

export default defineCommand({
  meta: {
    name: "run",
    description: "Dispatch an agent to execute a task in an isolated worktree",
  },
  args: {
    agent: {
      type: "positional",
      description: "Agent name to run (e.g. developer, architect, reviewer-quality)",
      required: true,
    },
    repo: {
      type: "string",
      description: "Target repository path",
      default: ".",
    },
    prompt: {
      type: "string",
      description: "Task description for the agent",
      required: true,
    },
    priority: {
      type: "string",
      description: "Priority level: critical, high, medium, low",
    },
    meta: {
      type: "string",
      description: "Metadata as JSON string",
    },
    config: {
      type: "string",
      description: "Config file path",
    },
    output: {
      type: "string",
      description: "Output format: json",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";
    const configPath = args.config ?? path.resolve(".neo/config.yml");

    if (!existsSync(configPath)) {
      printError(".neo/config.yml not found. Run 'neo init' first.");
      process.exit(1);
    }

    const config = await loadConfig(configPath);
    const repo = path.resolve(args.repo);

    // Load agent registry
    const customAgentsDir = path.resolve(".neo/agents");
    const agentRegistry = new AgentRegistry(
      resolveAgentsDir(),
      existsSync(customAgentsDir) ? customAgentsDir : undefined,
    );
    await agentRegistry.load();

    // Validate agent exists
    const agent = agentRegistry.get(args.agent);
    if (!agent) {
      const available = agentRegistry
        .list()
        .map((a) => a.name)
        .join(", ");
      printError(`Agent "${args.agent}" not found. Available: ${available}`);
      process.exit(1);
    }

    // Create orchestrator — no workflow dirs, we register an inline single-step workflow
    const orchestrator = new Orchestrator(config, {
      journalDir: ".neo/journals",
    });

    // Register the requested agent
    orchestrator.registerAgent(agent);

    // Register an inline single-step workflow for this agent
    orchestrator.registerWorkflow({
      name: `_run_${args.agent}`,
      description: `Direct dispatch to ${args.agent}`,
      steps: {
        run: { agent: args.agent },
      },
    });

    // Subscribe to events for progress display
    if (!jsonOutput) {
      orchestrator.on("*", printProgress);
    }

    try {
      await orchestrator.start();

      const result = await orchestrator.dispatch({
        workflow: `_run_${args.agent}`,
        repo,
        prompt: args.prompt,
        priority: (args.priority as "critical" | "high" | "medium" | "low") ?? "medium",
        metadata: parseMetadata(args.meta),
      });

      if (jsonOutput) {
        printJson(result);
      } else {
        console.log("");
        console.log(`Run:      ${result.runId}`);
        console.log(`Agent:    ${args.agent}`);
        console.log(`Status:   ${result.status}`);
        console.log(`Cost:     $${result.costUsd.toFixed(4)}`);
        console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
        if (result.branch) {
          console.log(`Branch:   ${result.branch}`);
        }
      }

      await orchestrator.shutdown();
      process.exit(result.status === "success" ? 0 : 1);
    } catch (error) {
      await orchestrator.shutdown();
      printError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  },
});
