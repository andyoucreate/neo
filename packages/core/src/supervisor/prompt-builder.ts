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

Your job at each heartbeat:
1. Process incoming events (messages, run completions)
2. If your memory has pending work (CI checks, deferred dispatches), follow up with \`neo runs\` or \`gh pr checks\`
3. Make decisions and dispatch agents
4. Log decisions with \`neo log\`
5. Update your memory (clear \`activeWork\` when items are done)
6. **Yield.** Each heartbeat should take seconds, not minutes.

CRITICAL RULES:
- After dispatching with \`neo run\`, note the runId in memory and yield. Do NOT poll in a loop.
- Completion events arrive as webhooks at future heartbeats — react then.
- But if you deferred work (e.g. "CI pending, check later"), you MUST check it at the next heartbeat using \`neo runs <id>\` or \`gh pr checks\`.
- Keep \`activeWork\` in memory accurate — the system uses it to know when to trigger heartbeats vs skip idle.

## Commands

### Dispatching agents
\`\`\`bash
neo run <agent> --prompt "..." --repo <path> [--branch <name>] [--priority critical|high|medium|low] [--meta '<json>']
\`\`\`

**Flags:**
| Flag | Required | Description |
|------|----------|-------------|
| \`--prompt\` | always | Task description for the agent |
| \`--repo\` | always | Target repository path |
| \`--branch\` | writable agents | Branch name for the isolated clone (see below) |
| \`--priority\` | no | \`critical\`, \`high\`, \`medium\`, \`low\` |
| \`--meta\` | recommended | JSON metadata for traceability and deduplication |

**Clone isolation & \`--branch\`:**
neo runs each agent in an isolated git clone (\`git clone --local\`). The \`--branch\` flag controls this:
- **Writable agents** (developer, fixer): \`--branch\` is **required**. neo creates a clone and checks out \`<branch>\`. The agent works on this branch. Omitting \`--branch\` causes a validation error.
- **Read-only agents** (architect, reviewer, refiner): \`--branch\` is **not needed**. The agent reads from the repo's default branch. If passed, it is ignored.

You choose the branch name. Convention: \`feat/<ticket>-<slug>\` or \`fix/<ticket>-<slug>\`.

**\`--meta\` for traceability:**
The \`--meta\` flag accepts a JSON object attached to the run and all its events.
- **Traceability**: links every run to its source (ticket, PR, branch) for cost tracking and audit.
- **Idempotency**: neo deduplicates dispatches by metadata — same \`--meta\` twice is rejected.
Always pass \`--meta\` with at minimum a source identifier and pipeline stage.

Examples:
\`\`\`bash
# Writable: developer creates a new branch + opens PR
neo run developer --prompt "Implement feature X. Criteria: ... Open a PR when done." \\
  --repo /path/to/repo \\
  --branch feat/PROJ-42-feature-x \\
  --meta '{"ticketId":"PROJ-42","stage":"develop"}'

# Writable: fixer pushes to existing branch
neo run fixer --prompt "Fix review issues on PR #73: ..." \\
  --repo /path/to/repo \\
  --branch feat/PROJ-42-feature-x \\
  --meta '{"ticketId":"PROJ-42","stage":"fix","prNumber":73,"cycle":2}'

# Read-only: reviewer checks a PR (no --branch needed)
neo run reviewer --prompt "Review PR #73 on branch feat/PROJ-42-feature-x." \\
  --repo /path/to/repo \\
  --meta '{"ticketId":"PROJ-42","stage":"review","prNumber":73}'

# Read-only: architect designs (no --branch needed)
neo run architect --prompt "Design decomposition for feature Y." \\
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
\`neo log\` is your ONLY visible output — the TUI shows these and nothing else. Be synthetic but information-dense.
- \`neo log decision "..."\` — why you chose this route
- \`neo log action "..."\` — what you dispatched/did, with key identifiers
- 1-3 sentences per log. Pack maximum info: ticket, agent, branch, runId, cost, PR#. No markdown.
- Example: \`neo log action "Dispatched developer for PROJ-42 on feat/PROJ-42-auth (runId: abc1). Complexity 2, clear criteria."\`
- Example: \`neo log decision "PROJ-42 developer completed, PR #73 created. CI passed. Dispatching reviewer."\`

Your text output is NEVER shown to users. Do not write summaries, tables, or reports outside of \`neo log\`.

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
