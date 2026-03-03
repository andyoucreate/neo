import type { AgentDefinition, Options } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { agents } from "../agents.js";
import { CLAUDE_CODE_PATH } from "../config.js";
import { hooks } from "../hooks.js";
import { logger } from "../logger.js";
import { runWithRecovery } from "../recovery.js";
import { createSandboxConfig } from "../sandbox.js";
import type { FeatureRequest, PipelineResult } from "../types.js";

/**
 * Detect project context from package.json and common config files.
 */
function detectProjectContext(repoDir: string): string {
  try {
    const raw = readFileSync(`${repoDir}/package.json`, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;

    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };

    const language = deps.typescript ? "TypeScript" : "JavaScript";
    const framework = detectFramework(deps);
    const packageManager = detectPackageManager(repoDir);
    const testRunner = detectTestRunner(deps, pkg.scripts as Record<string, string> | undefined);
    const scripts = pkg.scripts as Record<string, string> | undefined;

    const lines = [
      `- **Language**: ${language}`,
      `- **Framework**: ${framework}`,
      `- **Package manager**: ${packageManager}`,
      `- **Test runner**: ${testRunner}`,
    ];

    if (scripts?.typecheck) lines.push(`- **Typecheck**: \`${packageManager} typecheck\``);
    if (scripts?.lint) lines.push(`- **Lint**: \`${packageManager} lint\``);
    if (scripts?.test) lines.push(`- **Test**: \`${packageManager} test\``);
    if (scripts?.build) lines.push(`- **Build**: \`${packageManager} build\``);

    return lines.join("\n");
  } catch {
    return "- _Could not detect project context (no package.json found)_";
  }
}

function detectFramework(deps: Record<string, string>): string {
  if (deps["next"]) return "Next.js";
  if (deps["@nestjs/core"]) return "NestJS";
  if (deps["express"]) return "Express";
  if (deps["fastify"]) return "Fastify";
  if (deps["hono"]) return "Hono";
  if (deps["react"]) return "React";
  if (deps["vue"]) return "Vue";
  if (deps["svelte"]) return "Svelte";
  return "Unknown";
}

function detectPackageManager(repoDir: string): string {
  try {
    readFileSync(`${repoDir}/pnpm-lock.yaml`, "utf-8");
    return "pnpm";
  } catch { /* not pnpm */ }
  try {
    readFileSync(`${repoDir}/yarn.lock`, "utf-8");
    return "yarn";
  } catch { /* not yarn */ }
  try {
    readFileSync(`${repoDir}/bun.lockb`, "utf-8");
    return "bun";
  } catch { /* not bun */ }
  return "npm";
}

function detectTestRunner(
  deps: Record<string, string>,
  scripts?: Record<string, string>,
): string {
  if (deps["vitest"]) return "Vitest";
  if (deps["jest"]) return "Jest";
  if (deps["mocha"]) return "Mocha";
  if (scripts && "test" in scripts && scripts.test.includes("vitest")) return "Vitest";
  if (scripts && "test" in scripts && scripts.test.includes("jest")) return "Jest";
  return "Unknown";
}

/**
 * Build the prompt for a feature pipeline.
 * Includes project context and explicit orchestration instructions.
 */
function buildFeaturePrompt(
  ticket: FeatureRequest,
  repoDir: string,
  hasArchitect: boolean,
): string {
  const projectContext = detectProjectContext(repoDir);

  const orchestrationInstructions = hasArchitect
    ? `## Orchestration

You have access to two subagents: **architect** and **developer**.

Follow this sequence:

1. **Use the architect agent** to analyze the codebase and decompose the feature into atomic tasks.
   The architect will produce a structured plan with milestones and ordered tasks.
2. **Review the architect's plan** — verify it makes sense given the codebase.
3. **For each task in order**, use the **developer agent** to implement it.
   Pass the full task spec (files, criteria, patterns) to the developer.
4. **After all tasks are done**, run the full verification suite:
   - Type checking
   - Full test suite
   - Linting
5. **If any verification fails**, use the developer agent to fix the issue.
6. **Create a pull request** summarizing all changes.`
    : `## Execution

You are implementing this feature directly. Follow these steps:

1. **Read the codebase first** — understand the project structure, patterns, and conventions.
   Use Glob to map the directory tree. Read package.json, tsconfig.json, and key source files.
2. **Read existing similar features** — find patterns to replicate.
3. **Plan your changes** before writing code. Identify all files to create/modify.
4. **Implement changes** in order: types → implementation → exports → tests → config.
5. **Run verification** after each change:
   - Type checking
   - Relevant test file, then full test suite
   - Linting
6. **Commit** with a conventional commit message.
7. **Create a pull request** with a summary of changes.`;

  return `You are implementing a feature for this project.

## Project Context
${projectContext}

## Ticket
- **ID**: ${ticket.ticketId}
- **Title**: ${ticket.title}
- **Type**: ${ticket.type}
- **Priority**: ${ticket.priority}
- **Size**: ${ticket.size}

## Acceptance Criteria
${ticket.criteria || "_No specific criteria provided — infer from the title and description._"}

## Description
${ticket.description || "_No description provided — analyze the codebase to determine the best approach._"}

${orchestrationInstructions}

## Important Rules
- **Bootstrap first**: Run the package manager install command before any work.
- **Read before writing**: Always read files before editing them.
- **Follow existing patterns**: Match the codebase's conventions exactly.
- **Test everything**: Never commit with failing tests.
- **Conventional commits**: Use feat/fix/refactor/test/chore(scope): message format.
- **No scope creep**: Implement only what the ticket asks for.`;
}

/**
 * Run the feature pipeline for a ticket.
 */
export async function runFeaturePipeline(
  ticket: FeatureRequest,
  repoDir: string,
): Promise<PipelineResult> {
  const startTime = Date.now();

  const hasArchitect = ticket.size !== "xs" && ticket.size !== "s";
  const prompt = buildFeaturePrompt(ticket, repoDir, hasArchitect);

  // Select agents based on ticket size
  const selectedAgents: Record<string, AgentDefinition> =
    ticket.size === "xs" || ticket.size === "s"
      ? { developer: agents.developer }
      : {
          architect: agents.architect,
          developer: agents.developer,
        };

  const options: Options = {
    pathToClaudeCodeExecutable: CLAUDE_CODE_PATH,
    permissionMode: "acceptEdits",
    settingSources: ["user", "project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    hooks,
    sandbox: createSandboxConfig(repoDir),
    agents: selectedAgents,
    tools: { type: "preset", preset: "claude_code" },
    cwd: repoDir,
    maxTurns: ticket.size === "xs" || ticket.size === "s" ? 50 : 150,
  };

  let sessionId = "";
  let costUsd = 0;

  try {
    const result = await runWithRecovery("feature", prompt, options, {
      onSessionId: (id) => {
        sessionId = id;
      },
      onCostRecord: (msg) => {
        costUsd = msg.total_cost_usd;
      },
    });

    return {
      ticketId: ticket.ticketId,
      sessionId,
      pipeline: "feature",
      status: result.subtype === "success" ? "success" : "failure",
      summary: result.subtype === "success" ? result.result : undefined,
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Feature pipeline failed for ${ticket.ticketId}`, error);
    return {
      ticketId: ticket.ticketId,
      sessionId,
      pipeline: "feature",
      status: "failure",
      costUsd,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }
}
