import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NeoEvent, PersistedRun } from "@neotx/core";
import {
  AgentRegistry,
  getRepoRunsDir,
  getRunDispatchPath,
  loadGlobalConfig,
  Orchestrator,
  toRepoSlug,
} from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printSuccess } from "../output.js";
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
    throw new Error(`Invalid --meta JSON: ${meta}`);
  }
}

function printResult(result: import("@neotx/core").TaskResult, agentName: string): void {
  console.log("");
  console.log(`Run:      ${result.runId}`);
  console.log(`Agent:    ${agentName}`);
  console.log(`Status:   ${result.status}`);
  console.log(`Cost:     $${result.costUsd.toFixed(4)}`);
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.branch) {
    console.log(`Branch:   ${result.branch}`);
  }
  if (result.prUrl) {
    console.log(`PR:       ${result.prUrl}`);
  }

  const stepResult = Object.values(result.steps)[0];
  const output = stepResult?.output ?? result.summary;
  if (output) {
    console.log("");
    console.log(typeof output === "string" ? output : JSON.stringify(output, null, 2));
  }
}

interface DetachParams {
  agentName: string;
  repo: string;
  prompt: string;
  branch: string | undefined;
  priority: string;
  metadata: Record<string, unknown> | undefined;
  bundledAgentsDir: string;
  customAgentsDir: string | undefined;
  jsonOutput: boolean;
}

async function runDetached(params: DetachParams): Promise<void> {
  const runId = randomUUID();
  const repoSlug = toRepoSlug({ path: params.repo });
  const runsDir = getRepoRunsDir(repoSlug);
  await mkdir(runsDir, { recursive: true });

  const persistedRun: PersistedRun = {
    version: 1,
    runId,
    workflow: `_run_${params.agentName}`,
    repo: params.repo,
    prompt: params.prompt,
    status: "running",
    steps: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: params.metadata,
  };
  await writeFile(
    path.join(runsDir, `${runId}.json`),
    JSON.stringify(persistedRun, null, 2),
    "utf-8",
  );

  const dispatchPath = getRunDispatchPath(repoSlug, runId);
  await writeFile(
    dispatchPath,
    JSON.stringify({
      agentName: params.agentName,
      repo: params.repo,
      prompt: params.prompt,
      branch: params.branch,
      priority: params.priority,
      metadata: params.metadata,
      bundledAgentsDir: params.bundledAgentsDir,
      customAgentsDir: params.customAgentsDir,
    }),
    "utf-8",
  );

  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon", "worker.js");
  const child = fork(workerPath, [runId, repoSlug], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  if (params.jsonOutput) {
    printJson({ runId, status: "detached", pid: child.pid });
  } else {
    printSuccess(`Detached run started: ${runId}`);
    console.log(`  PID:  ${String(child.pid)}`);
    console.log(`  Logs: neo logs -f ${runId}`);
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
    branch: {
      type: "string",
      description: "Branch name for the worktree (required for writable agents)",
    },
    priority: {
      type: "string",
      description: "Priority level: critical, high, medium, low",
    },
    meta: {
      type: "string",
      description: "Metadata as JSON string (for traceability: ticketId, stage, etc.)",
    },
    output: {
      type: "string",
      description: "Output format: json",
    },
    detach: {
      type: "boolean",
      alias: "d",
      description: "Run in background and return immediately with the run ID",
      default: true,
    },
    sync: {
      type: "boolean",
      alias: "s",
      description: "Run in foreground (blocking) instead of detached",
      default: false,
    },
    "git-strategy": {
      type: "string",
      description: "Git strategy: pr (create PR), branch (push only, default)",
    },
  },
  async run({ args }) {
    const jsonOutput = args.output === "json";

    // Zero-config: only need global config (auto-creates ~/.neo/config.yml if absent)
    const config = await loadGlobalConfig();
    const repo = path.resolve(args.repo);

    // Load agent registry (bundled + project-local agents)
    const bundledAgentsDir = resolveAgentsDir();
    const customAgentsDir = path.resolve(".neo/agents");
    const agentRegistry = new AgentRegistry(
      bundledAgentsDir,
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
      process.exitCode = 1;
      return;
    }

    if (args.detach && !args.sync) {
      await runDetached({
        agentName: args.agent,
        repo,
        prompt: args.prompt,
        branch: args.branch,
        priority: args.priority ?? "medium",
        metadata: parseMetadata(args.meta),
        bundledAgentsDir,
        customAgentsDir: existsSync(customAgentsDir) ? customAgentsDir : undefined,
        jsonOutput,
      });
      return;
    }

    // ─── Foreground mode (default) ──────────────────────
    const orchestrator = new Orchestrator(config);
    orchestrator.registerAgent(agent);
    orchestrator.registerWorkflow({
      name: `_run_${args.agent}`,
      description: `Direct dispatch to ${args.agent}`,
      steps: {
        run: { agent: args.agent },
      },
    });

    if (!jsonOutput) {
      orchestrator.on("*", printProgress);
    }

    try {
      await orchestrator.start();

      const gitStrategy = args["git-strategy"] as "pr" | "branch" | undefined;
      const result = await orchestrator.dispatch({
        workflow: `_run_${args.agent}`,
        repo,
        prompt: args.prompt,
        ...(args.branch ? { branch: args.branch } : {}),
        priority: (args.priority as "critical" | "high" | "medium" | "low") ?? "medium",
        metadata: parseMetadata(args.meta),
        ...(gitStrategy ? { gitStrategy } : {}),
      });

      if (jsonOutput) {
        printJson(result);
      } else {
        printResult(result, args.agent);
      }

      await orchestrator.shutdown();
      if (result.status !== "success") {
        process.exitCode = 1;
      }
    } catch (error) {
      await orchestrator.shutdown();
      printError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  },
});
