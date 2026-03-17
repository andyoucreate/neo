import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GitStrategy } from "@/config";
import type { ResolvedAgent } from "@/types";

// ─── Constants ─────────────────────────────────────────

const INSTRUCTIONS_PATH = ".neo/INSTRUCTIONS.md";

// ─── Repo instructions loader ──────────────────────────

export async function loadRepoInstructions(repoPath: string): Promise<string | undefined> {
  const filePath = path.join(repoPath, INSTRUCTIONS_PATH);
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

// ─── Git strategy prompt builder ───────────────────────

export function buildGitStrategyInstructions(
  strategy: GitStrategy,
  agent: ResolvedAgent,
  branch: string,
  baseBranch: string,
  remote: string,
  metadata?: Record<string, unknown>,
): string | null {
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
# Stable facts — things the next agent shouldn't have to rediscover
neo memory write --type fact --scope $NEO_REPOSITORY "Monorepo uses pnpm workspaces — run commands from package dir, not root"
neo memory write --type fact --scope $NEO_REPOSITORY "Auth tokens stored in HTTP-only cookies, not localStorage — see src/auth/session.ts"

# How-to procedures — non-obvious workflows that failed before being understood
neo memory write --type procedure --scope $NEO_REPOSITORY "Run pnpm db:generate after any schema.prisma change — TypeScript types won't update otherwise"
neo memory write --type procedure --scope $NEO_REPOSITORY "E2E tests need STRIPE_TEST_KEY in .env.test — tests hang silently without it"
\`\`\`

Write at key moments: after discovering a convention not in docs, after resolving a non-obvious issue, before finishing.`;
}

// ─── Full prompt assembler ─────────────────────────────

export function buildFullPrompt(
  agentPrompt: string | undefined,
  repoInstructions: string | undefined,
  gitInstructions: string | null,
  taskPrompt: string,
  memoryContext?: string | undefined,
  cwdInstructions?: string | undefined,
  reportingInstructions?: string | undefined,
): string {
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
