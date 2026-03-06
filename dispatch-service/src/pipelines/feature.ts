import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { agents } from "../agents.js";
import type { FeatureRequest, PipelineResult } from "../types.js";
import { runPipeline } from "./run-pipeline.js";

/**
 * Build the prompt for a feature pipeline.
 */
function buildFeaturePrompt(
  ticket: FeatureRequest,
  hasArchitect: boolean,
  branch: string,
  baseBranch: string,
): string {
  const prInstructions = `
## Push and Create PR

After all verification passes, push your changes and create a pull request:

\`\`\`bash
git push -u origin ${branch}
gh pr create --base ${baseBranch} --head ${branch} \\
  --title "feat(${ticket.ticketId}): ${ticket.title.slice(0, 60)}" \\
  --body "Implements ${ticket.ticketId}

## Changes
<summarize your changes here>

## Acceptance Criteria
${(ticket.criteria || "See ticket description.").replace(/"/g, '\\"')}"
\`\`\`

After creating the PR, output the PR URL on a line by itself:
\`\`\`
PR_URL: <the full GitHub PR URL>
\`\`\``;

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
   - Auto-fix formatting: \`pnpm lint --fix\` (or \`pnpm format\` / \`pnpm biome check --write .\` if available)
   - Linting
5. **If any verification fails**, use the developer agent to fix the issue.
6. **Push and create a pull request** following the instructions below.
${prInstructions}`
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
   - Auto-fix formatting: \`pnpm lint --fix\` (or \`pnpm format\` / \`pnpm biome check --write .\` if available)
   - Linting
6. **Commit** with a conventional commit message.
7. **Push and create a pull request** following the instructions below.
${prInstructions}`;

  return `You are implementing a feature for this project.

## Git Branch

You are working on branch \`${branch}\`. All commits go on this branch.
The PR will target \`${baseBranch}\`.

## Ticket
- **ID**: ${ticket.ticketId}
- **Title**: ${ticket.title}
- **Type**: ${ticket.type}
- **Priority**: ${ticket.priority}
- **Complexity**: ${ticket.complexity} points

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
  branch: string,
  baseBranch: string,
): Promise<PipelineResult> {
  const hasArchitect = ticket.complexity >= 5;

  const selectedAgents: Record<string, AgentDefinition> = hasArchitect
    ? { architect: agents.architect, developer: agents.developer }
    : { developer: agents.developer };

  return runPipeline(
    {
      pipeline: "feature",
      prompt: buildFeaturePrompt(ticket, hasArchitect, branch, baseBranch),
      repoDir,
      agents: selectedAgents,
      maxTurns: hasArchitect ? 150 : 50,
      branch,
    },
    { ticketId: ticket.ticketId, repository: ticket.repository },
  );
}
