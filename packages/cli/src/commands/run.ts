import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NeoEvent, PersistedRun } from "@neotx/core";
import {
  AgentRegistry,
  getRepoRunsDir,
  getRunDispatchPath,
  getWorkerStartedPath,
  loadGlobalConfig,
  Orchestrator,
  toRepoSlug,
} from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printJson, printSuccess } from "../output.js";
import { resolveAgentsDir } from "../resolve.js";
import { spawnWithConfirmation } from "../spawn-utils.js";

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
  } catch (err) {
    // Expected error: invalid JSON provided by user
    throw new Error(
      `Invalid --meta JSON: ${meta}. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
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

/**
 * Time in milliseconds to wait for worker startup confirmation.
 * The worker writes a .started file immediately after spawning.
 * If this file doesn't appear within the timeout, the worker likely crashed.
 */
const WORKER_STARTUP_TIMEOUT_MS = 5000;

/**
 * Polling interval for checking if the worker has started.
 */
const WORKER_STARTUP_POLL_MS = 100;

/**
 * Wait for the worker to write its startup confirmation file.
 * Returns true if the worker started successfully, false if it timed out.
 */
async function waitForWorkerStartup(startedPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(startedPath)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, WORKER_STARTUP_POLL_MS));
  }
  return false;
}

async function runDetached(params: DetachParams): Promise<void> {
  const runId = randomUUID();
  const repoSlug = toRepoSlug({ path: params.repo });
  const runsDir = getRepoRunsDir(repoSlug);
  await mkdir(runsDir, { recursive: true });

  const persistedRun: PersistedRun = {
    version: 1,
    runId,
    agent: params.agentName,
    repo: params.repo,
    prompt: params.prompt,
    status: "running",
    steps: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: params.metadata,
  };
  const runFilePath = path.join(runsDir, `${runId}.json`);
  await writeFile(runFilePath, JSON.stringify(persistedRun, null, 2), "utf-8");

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

  // Wait for spawn confirmation before persisting PID
  // This prevents ghost runs where spawn fails silently
  const spawnResult = await spawnWithConfirmation(process.execPath, [workerPath, runId, repoSlug]);

  if ("error" in spawnResult) {
    // Mark run as failed if spawn failed
    try {
      const raw = await readFile(runFilePath, "utf-8");
      const run = JSON.parse(raw) as PersistedRun;
      run.status = "failed";
      run.updatedAt = new Date().toISOString();
      await writeFile(runFilePath, JSON.stringify(run, null, 2), "utf-8");
    } catch (err) {
      // Best effort - run file update failed
      console.debug(
        `[run] Failed to update run file on spawn failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    printError(`Failed to spawn worker: ${spawnResult.error}`);
    process.exitCode = 1;
    return;
  }

  // Wait for worker to confirm startup by writing .started file
  // This catches early crashes between spawn() and actual worker initialization
  const startedPath = getWorkerStartedPath(repoSlug, runId);
  const workerStarted = await waitForWorkerStartup(startedPath, WORKER_STARTUP_TIMEOUT_MS);

  if (!workerStarted) {
    // Worker failed to start - mark run as failed
    try {
      const raw = await readFile(runFilePath, "utf-8");
      const run = JSON.parse(raw) as PersistedRun;
      run.status = "failed";
      run.updatedAt = new Date().toISOString();
      await writeFile(runFilePath, JSON.stringify(run, null, 2), "utf-8");
    } catch {
      // Best effort - run file update failed
    }

    printError(
      `Worker failed to start within ${WORKER_STARTUP_TIMEOUT_MS / 1000}s. The process may have crashed before initialization.`,
    );
    process.exitCode = 1;
    return;
  }

  // Write PID to persisted run AFTER spawn confirmation
  // This ensures PID in run.json corresponds to an actually running process
  try {
    const raw = await readFile(runFilePath, "utf-8");
    const run = JSON.parse(raw) as PersistedRun;
    run.pid = spawnResult.pid;
    await writeFile(runFilePath, JSON.stringify(run, null, 2), "utf-8");
  } catch (err) {
    // Non-critical — worker will write PID on startup anyway
    console.debug(
      `[run] Failed to update run file with PID: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (params.jsonOutput) {
    printJson({ runId, status: "detached", pid: spawnResult.pid });
  } else {
    printSuccess(`Detached run started: ${runId}`);
    console.log(`  PID:  ${String(spawnResult.pid)}`);
    console.log(`  Logs: neo logs -f ${runId}`);
  }
}

export default defineCommand({
  meta: {
    name: "run",
    description: "Dispatch an agent to execute a task in an isolated clone",
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
      description: "Branch name for the session clone (required for writable agents)",
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
    const orchestrator = new Orchestrator(config, { skipOrphanRecovery: true });
    orchestrator.registerAgent(agent);

    if (!jsonOutput) {
      orchestrator.on("*", printProgress);
    }

    try {
      await orchestrator.start();

      const gitStrategy = args["git-strategy"] as "pr" | "branch" | undefined;
      const result = await orchestrator.dispatch({
        agent: args.agent,
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
