import type { RepoConfig } from "@/config";
import type { GroupedEvents } from "./event-queue.js";
import type { QueuedEvent } from "./schemas.js";

export interface HeartbeatPromptOptions {
  repos: RepoConfig[];
  memory: string;
  knowledge: string;
  memorySizeKB: number;
  grouped: GroupedEvents;
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
1. Process incoming events (webhooks, user messages, run completions)
2. Dispatch agents, check status, or respond to users
3. Update your memory with context for future heartbeats
4. If nothing to do, acknowledge and wait

## Commands

### Dispatching agents
\`\`\`bash
neo run <agent> --prompt "..." --repo <path> [--priority critical|high|medium|low] [--meta '<json>']
\`\`\`

The \`--meta\` flag accepts a JSON object attached to the run and all its events. It serves two purposes:
1. **Traceability**: links every run to its source (ticket, PR, branch) for cost tracking and audit.
2. **Idempotency**: neo deduplicates dispatches by metadata — same \`--meta\` twice is rejected.

Always pass \`--meta\` when dispatching. Include at minimum the source identifier and pipeline stage. See your custom instructions for the exact fields required by your workflow.

**Standard metadata fields:**

| Field | When | Description |
|-------|------|-------------|
| \`ticketId\` | always | Source ticket identifier for traceability |
| \`stage\` | always | Pipeline stage: \`refine\`, \`develop\`, \`review\`, \`fix\` |
| \`branch\` | if exists | Git branch the agent should work on |
| \`prNumber\` | if exists | GitHub PR number |
| \`cycle\` | fix stage | Fixer→review cycle count (for anti-loop guards) |

**Branch & PR rules:**
- First dispatch (develop): no branch/PR yet — instruct the agent in \`--prompt\` to create a feature branch and open a PR. Omit \`branch\` and \`prNumber\` from \`--meta\`.
- Subsequent dispatches (review/fix): branch and PR exist — pass \`branch\` and \`prNumber\` in \`--meta\` and reference them in \`--prompt\`.

Examples:
\`\`\`bash
# First dispatch — instruct agent to create branch + PR
neo run developer --prompt "Implement feature X. Criteria: ... Create branch feat/PROJ-42-feature-x and open a PR when done." \\
  --repo /path/to/repo \\
  --meta '{"ticketId":"PROJ-42","stage":"develop"}'

# Review — reference existing branch and PR
neo run reviewer-quality --prompt "Review PR #73 on branch feat/PROJ-42-feature-x." \\
  --repo /path/to/repo \\
  --meta '{"ticketId":"PROJ-42","stage":"review","branch":"feat/PROJ-42-feature-x","prNumber":73}'

# Fix — instruct to push to existing branch
neo run fixer --prompt "Fix issues from review on PR #73 (branch feat/PROJ-42-feature-x): ... Push fixes to the existing branch." \\
  --repo /path/to/repo \\
  --meta '{"ticketId":"PROJ-42","stage":"fix","branch":"feat/PROJ-42-feature-x","prNumber":73,"cycle":2}'

# Architect — read-only, no branch needed
neo run architect --prompt "Design decomposition for feature Y" \\
  --repo /path/to/repo \\
  --meta '{"ticketId":"PROJ-99","stage":"refine"}'
\`\`\`

### Other commands
\`\`\`bash
neo runs --short [--all]     # check recent runs
neo runs <runId>             # full run details
neo cost --short [--all]     # check budget
neo agents                   # list available agents
neo log <type> "<message>"   # log a progress report (types: decision, action, blocker, progress)
\`\`\`

## Reporting
Log every decision and action with \`neo log\`. These logs are your audit trail.

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
  const { messages, webhooks, runCompletions } = opts.grouped;
  const totalEvents = messages.length + webhooks.length + runCompletions.length;

  if (totalEvents > 0) {
    const parts: string[] = [];
    for (const msg of messages) {
      const countSuffix = msg.count > 1 ? ` (×${msg.count})` : "";
      parts.push(`**Message from ${msg.from}${countSuffix}**: ${msg.text}`);
    }
    for (const evt of webhooks) {
      parts.push(formatEvent(evt));
    }
    for (const evt of runCompletions) {
      parts.push(formatEvent(evt));
    }
    sections.push(`## Pending events (${totalEvents})\n${parts.join("\n\n")}`);
  } else {
    sections.push(
      "## Pending events\nNo new events. This is an idle heartbeat — check on active runs if any, or wait.",
    );
  }

  // ─── Knowledge (read-only reference data) ──────────────
  if (opts.knowledge) {
    sections.push(`## Reference knowledge (read-only)
${opts.knowledge}

To update knowledge, output a \`<knowledge>...</knowledge>\` block. Only update when reference data changes (API IDs, workspace config, etc.).`);
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
