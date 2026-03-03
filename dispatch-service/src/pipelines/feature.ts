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
): string {
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
  const hasArchitect = ticket.size !== "xs" && ticket.size !== "s";

  const selectedAgents: Record<string, AgentDefinition> = hasArchitect
    ? { architect: agents.architect, developer: agents.developer }
    : { developer: agents.developer };

  return runPipeline(
    {
      pipeline: "feature",
      prompt: buildFeaturePrompt(ticket, hasArchitect),
      repoDir,
      agents: selectedAgents,
      maxTurns: hasArchitect ? 150 : 50,
    },
    { ticketId: ticket.ticketId },
  );
}
