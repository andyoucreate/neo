import type { RepoConfig } from "@/config";
import type { QueuedEvent } from "./schemas.js";

export interface HeartbeatPromptOptions {
  repos: RepoConfig[];
  memory: string;
  memorySizeKB: number;
  events: QueuedEvent[];
  budgetStatus: {
    todayUsd: number;
    capUsd: number;
    remainingPct: number;
  };
  activeRuns: string[];
  heartbeatCount: number;
  mcpServerNames: string[];
  customInstructions?: string | undefined;
}

/**
 * Build the prompt sent to Claude at each heartbeat.
 *
 * Includes: role definition, current memory, pending events,
 * budget status, active runs, and available integrations.
 */
export function buildHeartbeatPrompt(opts: HeartbeatPromptOptions): string {
  const sections: string[] = [];

  // ─── Role ──────────────────────────────────────────────
  sections.push(`You are the neo autonomous supervisor (heartbeat #${opts.heartbeatCount}).
You orchestrate developer agents across repositories. You make decisions autonomously.

Your job:
1. Process any incoming events (webhooks, user messages, run completions)
2. Decide what actions to take (dispatch agents, check status, respond to users)
3. Update your memory with relevant context for future heartbeats
4. If nothing to do, simply acknowledge and wait

Available commands (via bash):
  neo run <agent> --prompt "..." [--repo <path>]   dispatch an agent
  neo runs --short [--all]                         check recent runs
  neo cost --short [--all]                         check budget
  neo agents                                       list available agents

IMPORTANT: Always include a <memory>...</memory> block at the end of your response with your updated memory.`);

  // ─── Custom instructions (SUPERVISOR.md) ─────────────
  if (opts.customInstructions) {
    sections.push(`## Custom instructions\n${opts.customInstructions}`);
  }

  // ─── Repos ─────────────────────────────────────────────
  if (opts.repos.length > 0) {
    const repoList = opts.repos.map((r) => `- ${r.path} (branch: ${r.defaultBranch})`).join("\n");
    sections.push(`## Registered repositories\n${repoList}`);
  } else {
    sections.push("## Registered repositories\n(none — run 'neo init' in a repo to register it)");
  }

  // ─── MCP Integrations ─────────────────────────────────
  if (opts.mcpServerNames.length > 0) {
    const mcpList = opts.mcpServerNames.map((n) => `- ${n}`).join("\n");

    sections.push(
      `## Available integrations (MCP)\n${mcpList}\n\nYou can use these tools directly to query external systems.`,
    );
  }

  // ─── Budget ────────────────────────────────────────────
  sections.push(
    `## Budget status\n- Today: $${opts.budgetStatus.todayUsd.toFixed(2)} / $${opts.budgetStatus.capUsd.toFixed(2)} (${opts.budgetStatus.remainingPct.toFixed(0)}% remaining)`,
  );

  // ─── Active runs ───────────────────────────────────────
  if (opts.activeRuns.length > 0) {
    sections.push(`## Active runs\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  // ─── Events ────────────────────────────────────────────
  if (opts.events.length > 0) {
    const eventDescriptions = opts.events.map(formatEvent);
    sections.push(`## Pending events (${opts.events.length})\n${eventDescriptions.join("\n\n")}`);
  } else {
    sections.push(
      "## Pending events\nNo new events. This is an idle heartbeat — check on active runs if any, or wait.",
    );
  }

  // ─── Memory ────────────────────────────────────────────
  sections.push(buildMemorySection(opts.memory, opts.memorySizeKB));

  return sections.join("\n\n---\n\n");
}

function buildMemorySection(memory: string, memorySizeKB: number): string {
  const schema = `{
  "activeWork": ["description of current task 1", ...],
  "blockers": ["what is stuck and why", ...],
  "repoNotes": { "/path/to/repo": "relevant context about this repo" },
  "recentDecisions": [{ "date": "YYYY-MM-DD", "decision": "what you decided", "outcome": "result" }],
  "trackerSync": { "ticket-id": "last known status" },
  "notes": "free-form context that doesn't fit elsewhere"
}`;

  if (!memory) {
    return `## Your current memory
(empty — this is your first heartbeat, initialize your memory)

Your memory MUST be a JSON object inside \`<memory>...</memory>\` tags:
\`\`\`
${schema}
\`\`\`
Keep under 8KB. Prune old decisions (keep last 10).`;
  }

  const sizeWarning =
    memorySizeKB > 8
      ? "\n\n**Memory is over 8KB — condense it. Remove old decisions, summarize notes.**"
      : "";

  return `## Your current memory (${memorySizeKB}KB)${sizeWarning}
${memory}

Remember: update your memory as a JSON object inside \`<memory>...</memory>\` tags.
Schema: ${schema}`;
}

function formatEvent(event: QueuedEvent): string {
  switch (event.kind) {
    case "webhook":
      return `**Webhook** [${event.data.source ?? "unknown"}] ${event.data.event ?? ""}
\`\`\`json
${JSON.stringify(event.data.payload ?? {}, null, 2)}
\`\`\``;

    case "message":
      return `**Message from ${event.data.from}**: ${event.data.text}`;

    case "run_complete":
      return `**Run completed**: ${event.runId} (check with \`neo runs\`)`;
  }
}
