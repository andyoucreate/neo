import { agents } from "../agents.js";
import type { HotfixRequest, PipelineResult } from "../types.js";
import { runPipeline } from "./run-pipeline.js";

/**
 * Run the hotfix pipeline for critical/high bugs.
 * Fast-tracked: developer agent only, no architect.
 */
export async function runHotfixPipeline(
  request: HotfixRequest,
  repoDir: string,
  branch: string,
  _baseBranch: string,
): Promise<PipelineResult> {
  const prompt = `HOTFIX — Priority: ${request.priority.toUpperCase()}

## Git Branch

You are working on branch \`${branch}\`. All commits go on this branch.
The PR will target \`main\`.

## Bug Report
- **ID**: ${request.ticketId}
- **Title**: ${request.title}

## Description
${request.description}

## Instructions
This is a hotfix — speed is critical but correctness is paramount.
1. Identify the root cause of the bug
2. Implement the minimal fix
3. Write a regression test that would have caught this bug
4. Run the full test suite
5. Create a conventional commit: fix(scope): description
6. Push and create a pull request:

\`\`\`bash
git push -u origin ${branch}
gh pr create --base main --head ${branch} \\
  --title "fix(${request.ticketId}): ${request.title.slice(0, 60)}" \\
  --body "Hotfix for ${request.ticketId}

${request.description.slice(0, 200).replace(/"/g, '\\"')}"
\`\`\`

After creating the PR, output the PR URL on a line by itself:
\`\`\`
PR_URL: <the full GitHub PR URL>
\`\`\``;

  return runPipeline(
    {
      pipeline: "hotfix",
      prompt,
      repoDir,
      agents: { developer: agents.developer },
      maxTurns: 75,
      branch,
    },
    { ticketId: request.ticketId, repository: request.repository },
  );
}
