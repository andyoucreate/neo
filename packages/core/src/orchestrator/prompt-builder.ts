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
  } catch (err) {
    console.debug(
      `[prompt-builder] Failed to load repo instructions: ${err instanceof Error ? err.message : String(err)}`,
    );
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

You have two tools to communicate what you learn and do: \`neo log\` (real-time visibility) and \`neo memory\` (persistent knowledge for future agents). Use both deliberately throughout your work.

### Progress reporting — \`neo log\`

Chain \`neo log\` with the command that triggered the event — never call it standalone.

<log-types>
| Type | When to use | Example |
|------|------------|---------|
| \`milestone\` | A meaningful goal is achieved (tests pass, build succeeds, feature complete) | \`neo log milestone "auth middleware passing all tests"\` |
| \`action\` | You performed a significant action (push, PR, deploy) | \`neo log action "pushed 3 commits to feat/auth"\` |
| \`decision\` | You made a non-obvious choice — record WHY | \`neo log decision "chose JWT over sessions — stateless, simpler for MVP"\` |
| \`blocker\` | Something is preventing progress | \`neo log blocker "CI fails: missing DATABASE_URL in test env"\` |
| \`discovery\` | You found something surprising or important about the codebase | \`neo log discovery "API rate limiter is disabled in dev — tests hit real endpoints"\` |
| \`progress\` | General progress update | \`neo log progress "3/5 endpoints migrated"\` |
</log-types>

<log-rules>
- **Chain with commands**: \`pnpm test && neo log milestone "tests passing" || neo log blocker "tests failing"\`
- **Log decisions with reasoning**: the "why" is more valuable than the "what"
- **Log blockers immediately**: do not continue silently — surface problems so the supervisor can act
- **Log at natural boundaries**: after completing a subtask, before switching context, when hitting an obstacle
</log-rules>

### Memory — \`neo memory\`

Memory is persistent knowledge injected into future agent prompts. Write a memory when you learn something that would change HOW the next agent approaches work on this repo.

<memory-types>
| Type | When to write | Example |
|------|--------------|---------|
| \`fact\` | Stable truth that affects workflow decisions | Build quirks, CI config, auth patterns, deployment constraints |
| \`procedure\` | Non-obvious multi-step workflow learned from failure | "Run X before Y otherwise Z breaks" |
</memory-types>

<memory-decision-tree>
Before writing a memory, apply this test:
1. Can \`cat package.json\`, \`ls\`, or reading the README answer this? → Do NOT memorize.
2. Would knowing this change how you approach the task? → Write a \`fact\`.
3. Did you fail before discovering this workflow? → Write a \`procedure\`.
4. Is this just a detail about what you did (file counts, line numbers, component names)? → Do NOT memorize.
</memory-decision-tree>

<memory-examples type="good">
# Affects workflow — non-obvious build/CI constraints
neo memory write --type fact --scope $NEO_REPOSITORY "CI requires pnpm build before push — no auto-rebuild in pipeline"
neo memory write --type fact --scope $NEO_REPOSITORY "Biome enforces complexity max 20 — extract helpers for large functions"

# Learned from failure — save the next agent from the same mistake
neo memory write --type procedure --scope $NEO_REPOSITORY "Run pnpm db:generate after any schema.prisma change — TypeScript types won't update otherwise"
neo memory write --type procedure --scope $NEO_REPOSITORY "E2E tests need STRIPE_TEST_KEY in .env.test — tests hang silently without it"
</memory-examples>

<memory-examples type="bad">
# NEVER write these — trivial or derivable
# "packages/core has 71 files" → derivable from ls
# "Uses React 19" → visible in package.json
# "Main entry is src/index.ts" → visible in package.json
# "Tests use vitest" → visible in config files
</memory-examples>

<when-to-write>
Write memories at these key moments:
- **After resolving a non-obvious issue**: the fix revealed a constraint future agents should know
- **After discovering a build/CI/deploy quirk**: the next agent will hit the same wall without this
- **Before finishing your task**: review what you learned — anything that would save the next agent 10+ minutes?
- **After a failed attempt**: if you tried something that seemed right but failed, document why
</when-to-write>`;
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
