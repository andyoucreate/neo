import { agents } from "../agents.js";
import type { FixerRequest, PipelineResult } from "../types.js";
import { runPipeline } from "./run-pipeline.js";

/**
 * Run the fixer pipeline to auto-correct review issues.
 */
export async function runFixerPipeline(
  request: FixerRequest,
  repoDir: string,
  onInit?: () => void,
): Promise<PipelineResult> {
  const issuesJson = JSON.stringify(request.issues, null, 2);

  const prompt = `You are the Fixer agent. Fix the following issues found by reviewers on PR #${request.prNumber}.

## Issues to Fix
\`\`\`json
${issuesJson}
\`\`\`

## Rules
1. Fix ROOT CAUSES, never symptoms
2. Maximum 6 fix attempts
3. Run full test suite before committing
4. Auto-fix formatting before committing: \`pnpm lint --fix\` (or \`pnpm format\` / \`pnpm biome check --write .\` if available)
5. If you cannot fix after 6 attempts, STOP and report "ESCALATED"
6. Add regression tests for every fix
7. After committing, PUSH your changes: git push origin HEAD

## Output
Report what was fixed and what was not, in structured JSON.`;

  return runPipeline(
    {
      pipeline: "fixer",
      prompt,
      repoDir,
      agents: { fixer: agents.fixer },
      // No maxTurns — unlimited (SESSION_MAX_DURATION_MS is the safety net)
    },
    { prNumber: request.prNumber, repository: request.repository },
    onInit,
  );
}
