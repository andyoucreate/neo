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
): Promise<PipelineResult> {
  const prompt = `HOTFIX — Priority: ${request.priority.toUpperCase()}

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
6. Create a PR targeting the main branch`;

  return runPipeline(
    {
      pipeline: "hotfix",
      prompt,
      repoDir,
      agents: { developer: agents.developer },
      maxTurns: 75,
    },
    { ticketId: request.ticketId },
  );
}
