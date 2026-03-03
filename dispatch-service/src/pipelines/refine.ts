import { agents } from "../agents.js";
import { logger } from "../logger.js";
import type { RefineRequest, RefineResult, SubTicket } from "../types.js";
import { executePipeline } from "./run-pipeline.js";

/**
 * Build the prompt for a refine pipeline.
 * Instructs the refiner agent to read the codebase and evaluate the ticket.
 */
function buildRefinePrompt(ticket: RefineRequest): string {
  return `You are evaluating a ticket for clarity and completeness.
Your job is to read the target codebase and determine if this ticket is precise enough
for a developer agent to implement on the first try.

## Ticket to Evaluate
- **ID**: ${ticket.ticketId}
- **Title**: ${ticket.title}
- **Type**: ${ticket.type}
- **Priority**: ${ticket.priority}
${ticket.size ? `- **Size**: ${ticket.size}` : ""}

### Acceptance Criteria
${ticket.criteria || "_No criteria provided_"}

### Description
${ticket.description || "_No description provided_"}

## Your Task

1. **Read the codebase first**:
   - Use Glob to map the project structure (\`src/**/*.ts\`, \`src/**/*.tsx\`)
   - Read \`package.json\` to understand tech stack, scripts, and dependencies
   - Read key files related to the ticket domain
   - Read existing patterns (similar features already implemented)
   - Read type definitions, schemas, and config files

2. **Score the ticket clarity** (1-5) based on:
   - Does it specify which files/modules are affected?
   - Are acceptance criteria testable and unambiguous?
   - Is the scope clear (not "add user management" but "add CRUD endpoints for users")?
   - Can you infer exact file paths from the codebase?

3. **Take action based on score**:
   - Score >= 4: Return \`"action": "pass_through"\` with enriched context
   - Score 2-3: Return \`"action": "decompose"\` with precise sub-tickets
   - Score 1: Return \`"action": "escalate"\` with clarifying questions

4. **Output structured JSON** following the format in your instructions.

IMPORTANT: Each sub-ticket must have EXACT file paths (from your codebase analysis),
testable acceptance criteria, and a rich description referencing existing patterns.
Sub-ticket sizes must be XS or S only.`;
}

/**
 * Parse the refiner agent's output into a structured RefineResult.
 */
function parseRefineOutput(
  raw: string | undefined,
  ticketId: string,
  sessionId: string,
  costUsd: number,
  durationMs: number,
): RefineResult {
  const base = {
    ticketId,
    sessionId,
    pipeline: "refine" as const,
    costUsd,
    durationMs,
    timestamp: new Date().toISOString(),
  };

  if (!raw) {
    return {
      ...base,
      status: "failure",
      score: 0,
      reason: "No output from refiner agent",
      action: "escalate",
    };
  }

  try {
    // Extract JSON from the agent's response (may be wrapped in markdown code blocks)
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch?.[1] ?? raw;
    const parsed = JSON.parse(jsonStr.trim()) as Record<string, unknown>;

    const score = typeof parsed.score === "number" ? parsed.score : 0;
    const reason =
      typeof parsed.reason === "string" ? parsed.reason : "Unknown";
    const action =
      parsed.action === "pass_through" || parsed.action === "decompose" || parsed.action === "escalate"
        ? parsed.action
        : "escalate";

    const result: RefineResult = {
      ...base,
      status: "success",
      score,
      reason,
      action,
    };

    if (action === "pass_through" && parsed.enriched_context) {
      result.enrichedContext = parsed.enriched_context as Record<string, unknown>;
    }

    if (action === "decompose" && Array.isArray(parsed.sub_tickets)) {
      result.subTickets = (parsed.sub_tickets as Record<string, unknown>[]).map(
        (st) => ({
          id: typeof st.id === "string" ? st.id : "",
          title: typeof st.title === "string" ? st.title : "",
          type: st.type as SubTicket["type"],
          priority: st.priority as SubTicket["priority"],
          size: (st.size === "xs" ? "xs" : "s") satisfies SubTicket["size"],
          files: Array.isArray(st.files) ? st.files.map((f) => typeof f === "string" ? f : "") : [],
          criteria: Array.isArray(st.criteria) ? st.criteria.map((c) => typeof c === "string" ? c : "") : [],
          depends_on: Array.isArray(st.depends_on) ? st.depends_on.map((d) => typeof d === "string" ? d : "") : [],
          description: typeof st.description === "string" ? st.description : "",
        }),
      );
    }

    if (action === "escalate" && Array.isArray(parsed.questions)) {
      result.questions = (parsed.questions as unknown[]).map(String);
    }

    return result;
  } catch (error) {
    logger.warn("Failed to parse refiner output as JSON", error);
    return {
      ...base,
      status: "failure",
      score: 0,
      reason: `Failed to parse refiner output: ${raw.slice(0, 200)}`,
      action: "escalate",
    };
  }
}

/**
 * Run the refine pipeline for a ticket.
 * The refiner reads the codebase (read-only) and evaluates ticket clarity.
 */
export async function runRefinePipeline(
  request: RefineRequest,
  repoDir: string,
): Promise<RefineResult> {
  try {
    const exec = await executePipeline({
      pipeline: "refine",
      prompt: buildRefinePrompt(request),
      repoDir,
      agents: { refiner: agents.refiner },
      maxTurns: 50,
      sandbox: "readonly",
    });

    return parseRefineOutput(
      exec.output,
      request.ticketId,
      exec.sessionId,
      exec.costUsd,
      exec.durationMs,
    );
  } catch (error) {
    logger.error(`Refine pipeline failed for ${request.ticketId}`, error);
    return {
      ticketId: request.ticketId,
      sessionId: "",
      pipeline: "refine",
      status: "failure",
      score: 0,
      reason: error instanceof Error ? error.message : "Unknown error",
      action: "escalate",
      costUsd: 0,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    };
  }
}
