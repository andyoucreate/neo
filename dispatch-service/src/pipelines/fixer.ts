import { agents } from "../agents.js";
import type { FixerRequest, PipelineResult } from "../types.js";
import { runPipeline } from "./run-pipeline.js";

/**
 * Run the fixer pipeline to auto-correct review issues.
 */
export async function runFixerPipeline(
  request: FixerRequest,
  repoDir: string,
): Promise<PipelineResult> {
  const issuesJson = JSON.stringify(request.issues, null, 2);

  const prompt = `You are the Fixer agent. Fix the following issues found by reviewers on PR #${request.prNumber}.

## Issues to Fix
\`\`\`json
${issuesJson}
\`\`\`

## Rules
1. Fix ROOT CAUSES, never symptoms
2. Maximum 3 files modified
3. Maximum 3 fix attempts
4. Maximum 100 lines changed
5. Run full test suite before committing
6. If scope exceeds limits, STOP and report "ESCALATED"
7. Add regression tests for every fix
8. After committing, PUSH your changes: git push origin HEAD

## Output
Report what was fixed and what was not, in structured JSON.`;

  return runPipeline(
    {
      pipeline: "fixer",
      prompt,
      repoDir,
      agents: { fixer: agents.fixer },
      maxTurns: 50,
    },
    { prNumber: request.prNumber, repository: request.repository },
  );
}
