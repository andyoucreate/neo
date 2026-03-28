import { z } from "zod";

// ─── Schemas ─────────────────────────────────────────────

export const criteriaResultSchema = z.object({
  criterion: z.string(),
  met: z.boolean(),
  evidence: z.string(),
});

export const supervisorCompleteSchema = z.object({
  summary: z.string(),
  evidence: z.array(z.string()).min(1, "At least one piece of evidence required"),
  branch: z.string().optional(),
  criteriaResults: z.array(criteriaResultSchema),
});

export const supervisorBlockedSchema = z.object({
  reason: z.string(),
  question: z.string(),
  context: z.string(),
  urgency: z.enum(["low", "high"]),
});

// ─── Types ───────────────────────────────────────────────

export type SupervisorCompleteInput = z.infer<typeof supervisorCompleteSchema>;
export type SupervisorBlockedInput = z.infer<typeof supervisorBlockedSchema>;
export type CriteriaResult = z.infer<typeof criteriaResultSchema>;

// ─── Tool definitions (passed to AIAdapter) ──────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const SUPERVISOR_COMPLETE_TOOL: ToolDefinition = {
  name: "supervisor_complete",
  description:
    "Call this when ALL acceptance criteria are met and you have objective evidence. " +
    "Do NOT call this speculatively — provide real evidence (PR URL, CI status, test output).",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "What was accomplished" },
      evidence: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "PR URLs, CI links, test output snippets",
      },
      branch: { type: "string", description: "Branch name if applicable" },
      criteriaResults: {
        type: "array",
        items: {
          type: "object",
          properties: {
            criterion: { type: "string" },
            met: { type: "boolean" },
            evidence: { type: "string" },
          },
          required: ["criterion", "met", "evidence"],
        },
        description: "Result for each acceptance criterion",
      },
    },
    required: ["summary", "evidence", "criteriaResults"],
  },
};

export const SUPERVISOR_BLOCKED_TOOL: ToolDefinition = {
  name: "supervisor_blocked",
  description:
    "Call this when you cannot proceed without a decision from the parent supervisor. " +
    "Only call when genuinely blocked — not when uncertain.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why you cannot proceed" },
      question: { type: "string", description: "The specific decision needed" },
      context: { type: "string", description: "Relevant context for the decision" },
      urgency: { type: "string", enum: ["low", "high"] },
    },
    required: ["reason", "question", "context", "urgency"],
  },
};
