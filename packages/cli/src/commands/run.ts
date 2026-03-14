import { existsSync } from "node:fs";
import path from "node:path";
import type { NeoEvent } from "@neo-cli/core";
import { AgentRegistry, loadConfig, Orchestrator } from "@neo-cli/core";
import { printError, printJson } from "../output.js";
import { resolveAgentsDir, resolveWorkflowsDir } from "../resolve.js";

interface RunOptions {
  workflow: string;
  repo: string;
  prompt: string;
  priority?: string | undefined;
  meta?: string | undefined;
  config?: string | undefined;
  jsonOutput: boolean;
}

function printProgress(event: NeoEvent): void {
  const ts = event.timestamp.slice(11, 19);
  switch (event.type) {
    case "session:start":
      console.log(`[${ts}] ${event.agent}: starting (${event.step})`);
      break;
    case "session:complete":
      console.log(`[${ts}] session complete: $${event.costUsd.toFixed(4)}`);
      break;
    case "session:fail":
      console.log(`[${ts}] session failed: ${event.error}`);
      break;
    case "cost:update":
      // Quiet — shown in final summary
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

export async function runWorkflow(options: RunOptions): Promise<void> {
  const configPath = options.config ?? path.resolve(".neo/config.yml");
  if (!existsSync(configPath)) {
    printError(".neo/config.yml not found. Run 'neo init' first.");
    process.exit(1);
  }

  const config = await loadConfig(configPath);
  const repo = path.resolve(options.repo);

  // Load agent registry
  const customAgentsDir = path.resolve(".neo/agents");
  const agentRegistry = new AgentRegistry(
    resolveAgentsDir(),
    existsSync(customAgentsDir) ? customAgentsDir : undefined,
  );
  await agentRegistry.load();

  // Load workflow registry
  const customWorkflowsDir = path.resolve(".neo/workflows");

  const orchestrator = new Orchestrator(config, {
    builtInWorkflowDir: resolveWorkflowsDir(),
    customWorkflowDir: existsSync(customWorkflowsDir) ? customWorkflowsDir : undefined,
    journalDir: ".neo/journals",
  });

  // Register agents
  for (const agent of agentRegistry.list()) {
    orchestrator.registerAgent(agent);
  }

  // Subscribe to events for progress display
  if (!options.jsonOutput) {
    orchestrator.on("*", printProgress);
  }

  try {
    await orchestrator.start();

    const result = await orchestrator.dispatch({
      workflow: options.workflow,
      repo,
      prompt: options.prompt,
      priority: (options.priority as "critical" | "high" | "medium" | "low") ?? "medium",
      metadata: parseMetadata(options.meta),
    });

    if (options.jsonOutput) {
      printJson(result);
    } else {
      console.log("");
      console.log(`Run:      ${result.runId}`);
      console.log(`Workflow: ${result.workflow}`);
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
}
