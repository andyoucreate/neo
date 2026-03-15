/**
 * Detached worker process for `neo run -d`.
 *
 * Launched via child_process.fork() from the run command.
 * Reads dispatch parameters from a .dispatch.json file, runs the orchestrator,
 * and persists results. Stdout/stderr are redirected to a log file.
 *
 * Usage: node worker.js <runId> <repoSlug>
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedRun } from "@neotx/core";
import {
  AgentRegistry,
  getRepoRunsDir,
  getRunDispatchPath,
  getRunLogPath,
  loadGlobalConfig,
  Orchestrator,
} from "@neotx/core";

interface DispatchRequest {
  agentName: string;
  repo: string;
  prompt: string;
  branch?: string;
  priority?: "critical" | "high" | "medium" | "low";
  metadata?: Record<string, unknown>;
  bundledAgentsDir: string;
  customAgentsDir?: string;
}

async function main(): Promise<void> {
  const [runId, repoSlug] = process.argv.slice(2);
  if (!runId || !repoSlug) {
    process.stderr.write("Usage: worker.js <runId> <repoSlug>\n");
    process.exit(1);
  }

  // Redirect stdout/stderr to log file
  const logPath = getRunLogPath(repoSlug, runId);
  await mkdir(path.dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "a" });
  process.stdout.write = logStream.write.bind(logStream);
  process.stderr.write = logStream.write.bind(logStream);

  const dispatchPath = getRunDispatchPath(repoSlug, runId);
  const runPath = path.join(getRepoRunsDir(repoSlug), `${runId}.json`);

  try {
    // Read dispatch request
    const raw = await readFile(dispatchPath, "utf-8");
    const request = JSON.parse(raw) as DispatchRequest;

    // Clean up dispatch file
    await unlink(dispatchPath).catch(() => {});

    // Load config and agents
    const config = await loadGlobalConfig();
    const agentRegistry = new AgentRegistry(
      request.bundledAgentsDir,
      request.customAgentsDir && existsSync(request.customAgentsDir)
        ? request.customAgentsDir
        : undefined,
    );
    await agentRegistry.load();

    const agent = agentRegistry.get(request.agentName);
    if (!agent) {
      throw new Error(`Agent "${request.agentName}" not found`);
    }

    // Create orchestrator
    const orchestrator = new Orchestrator(config);
    orchestrator.registerAgent(agent);
    orchestrator.registerWorkflow({
      name: `_run_${request.agentName}`,
      description: `Detached dispatch to ${request.agentName}`,
      steps: {
        run: { agent: request.agentName },
      },
    });

    // Update persisted run with PID
    await updatePersistedRun(runPath, { pid: process.pid });

    // Safety timeout — ensure the process eventually exits
    const safetyTimeout = setTimeout(() => {
      console.error("[worker] Safety timeout reached, forcing exit");
      process.exit(1);
    }, config.sessions.maxDurationMs + 60_000);
    safetyTimeout.unref();

    await orchestrator.start();

    // Re-assert running status — orchestrator.start() calls recoverOrphanedRuns()
    // which marks any "running" persisted runs as "failed"
    await updatePersistedRun(runPath, { status: "running", pid: process.pid });

    const result = await orchestrator.dispatch({
      runId,
      workflow: `_run_${request.agentName}`,
      repo: request.repo,
      prompt: request.prompt,
      ...(request.branch ? { branch: request.branch } : {}),
      priority: request.priority ?? "medium",
      metadata: request.metadata,
    });

    await orchestrator.shutdown();

    console.log(`[worker] Run ${runId} completed: ${result.status}`);
    console.log(`[worker] Cost: $${result.costUsd.toFixed(4)}`);
    if (result.branch) {
      console.log(`[worker] Branch: ${result.branch}`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[worker] Run ${runId} failed: ${errorMsg}`);

    // Update persisted run to failed status
    await updatePersistedRun(runPath, {
      status: "failed",
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
  } finally {
    logStream.end();
    process.exit(0);
  }
}

async function updatePersistedRun(runPath: string, updates: Partial<PersistedRun>): Promise<void> {
  try {
    const raw = await readFile(runPath, "utf-8");
    const run = JSON.parse(raw) as PersistedRun;
    Object.assign(run, updates);
    await writeFile(runPath, JSON.stringify(run, null, 2), "utf-8");
  } catch {
    // Non-critical
  }
}

main();
