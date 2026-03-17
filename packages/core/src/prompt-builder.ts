import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GitStrategy } from "@/config";
import type { ResolvedAgent } from "@/types";

// ─── Constants ─────────────────────────────────────────

const INSTRUCTIONS_PATH = ".neo/INSTRUCTIONS.md";

// ─── Types ─────────────────────────────────────────────

export interface GitInstructionsInput {
  strategy: GitStrategy;
  agent: ResolvedAgent;
  branch: string;
  baseBranch: string;
  remote: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface FullPromptInput {
  agentPrompt: string | undefined;
  repoInstructions: string | undefined;
  gitInstructions: string | null;
  taskPrompt: string;
  memoryContext?: string | undefined;
  cwdInstructions?: string | undefined;
  reportingInstructions?: string | undefined;
}

// ─── Repo instructions loader ──────────────────────────

/**
 * Load repository-specific instructions from .neo/INSTRUCTIONS.md.
 * Returns undefined if the file does not exist.
 */
export async function loadRepoInstructions(repoPath: string): Promise<string | undefined> {
  const filePath = path.join(repoPath, INSTRUCTIONS_PATH);
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

// ─── Git strategy prompt builder ───────────────────────

/**
 * Build git workflow instructions based on strategy and agent sandbox mode.
 * Returns null if no git instructions are needed.
 */
export function buildGitStrategyInstructions(input: GitInstructionsInput): string | null {
  const { strategy, agent, branch, baseBranch, remote, metadata } = input;
  const prNumber = metadata?.prNumber as number | undefined;

  // Readonly agents: only inject PR comment instruction if a PR exists
  if (agent.sandbox !== "writable") {
    if (prNumber) {
      return `## Pull Request\n\nPR #${String(prNumber)} is open for this task. After your review, leave your findings as a comment: \`gh pr comment ${String(prNumber)} --body "..."\`.`;
    }
    return null;
  }

  // Writable agents: inject git workflow context
  if (strategy === "pr") {
    if (prNumber) {
      return `## Git workflow\n\nYou are on branch \`${branch}\`.\nAn open PR exists: #${String(prNumber)}.\nAfter committing, push your changes to the branch. The PR will be updated automatically.\nLeave a review comment on the PR summarizing what you did: \`gh pr comment ${String(prNumber)} --body "..."\`.`;
    }
    return `## Git workflow\n\nYou are on branch \`${branch}\` (base: \`${baseBranch}\`).\nAfter committing:\n1. Push: \`git push -u ${remote} ${branch}\`\n2. Create a PR against \`${baseBranch}\` — choose a title and description that reflect the work you completed. End the PR body with: \`🤖 Generated with [neo](https://neotx.dev)\`\n3. Output the PR URL on a dedicated line: \`PR_URL: <url>\``;
  }

  // strategy === "branch"
  return `## Git workflow\n\nYou are on branch \`${branch}\` (base: \`${baseBranch}\`).\nCommit your changes. The branch will be pushed automatically.`;
}

// ─── Reporting instructions for agents ──────────────────

/**
 * Build reporting instructions that tell agents how to use neo log and memory.
 */
export function buildReportingInstructions(_runId: string): string {
  return `## Reporting & Memory

### Progress reporting (real-time, visible in TUI)
Chain \`neo log\` with the command that triggered it — never standalone:
\`\`\`bash
pnpm test && neo log milestone "all tests passing" || neo log blocker "tests failing"
git push origin HEAD && neo log action "pushed to branch"
neo log decision "chose JWT over sessions — simpler for MVP"
\`\`\`

### Memory (persistent, injected into future agent prompts)
Write discoveries so the next agent on this repo starts smarter:
\`\`\`bash
# Stable facts — describe clearly for semantic search
neo memory write --type fact --scope $NEO_REPOSITORY "Uses Prisma ORM with PostgreSQL, migrations in prisma/migrations/"
neo memory write --type fact --scope $NEO_REPOSITORY "Biome for lint+format, config in biome.json"

# How-to procedures — non-obvious workflows
neo memory write --type procedure --scope $NEO_REPOSITORY "Integration tests require DATABASE_URL env var"
neo memory write --type procedure --scope $NEO_REPOSITORY "Always run pnpm build before push — CI doesn't rebuild"
\`\`\`

Write at key moments: after discovering conventions, after resolving a non-obvious issue, before finishing.`;
}

// ─── Working directory instructions ─────────────────────

/**
 * Build working directory instructions for isolated clones.
 */
export function buildCwdInstructions(sessionPath: string): string {
  return `## Working directory

You are working in an isolated clone at: \`${sessionPath}\`
ALWAYS run commands from this directory. NEVER cd to or operate on any other repository.`;
}

// ─── Full prompt assembler ─────────────────────────────

/**
 * Assemble the full prompt from all sections.
 * Sections are joined with horizontal rule separators.
 */
export function buildFullPrompt(input: FullPromptInput): string {
  const {
    agentPrompt,
    repoInstructions,
    gitInstructions,
    taskPrompt,
    memoryContext,
    cwdInstructions,
    reportingInstructions,
  } = input;

  const sections: string[] = [];

  if (agentPrompt) sections.push(agentPrompt);
  if (cwdInstructions) sections.push(cwdInstructions);
  if (memoryContext) sections.push(memoryContext);
  if (repoInstructions) sections.push(`## Repository instructions\n\n${repoInstructions}`);
  if (gitInstructions) sections.push(gitInstructions);
  if (reportingInstructions) sections.push(reportingInstructions);
  sections.push(`## Task\n\n${taskPrompt}`);

  return sections.join("\n\n---\n\n");
}
