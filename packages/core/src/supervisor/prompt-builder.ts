import type { RepoConfig } from "@/config";
import type { GroupedEvents } from "./event-queue.js";
import type { MemoryEntry } from "./memory/entry.js";
import type { QueuedEvent } from "./schemas.js";

// ─── Shared options ─────────────────────────────────────

export interface PromptOptions {
  repos: RepoConfig[];
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
  supervisorDir: string;
  memories: MemoryEntry[];
}

export interface StandardPromptOptions extends PromptOptions {}

export interface ConsolidationPromptOptions extends PromptOptions {
  /** ISO timestamp of last consolidation — used to filter run history */
  lastConsolidationTimestamp?: string | undefined;
}

// ─── Role (concise identity + mindset) ──────────────────

const ROLE = `You are the neo autonomous supervisor. You orchestrate developer agents across repositories. You make decisions autonomously, act on events, and yield quickly.`;

// ─── Commands reference ─────────────────────────────────

const COMMANDS = `### Dispatching agents
\`\`\`bash
neo run <agent> --prompt "..." --repo <path> [--branch <name>] [--priority critical|high|medium|low] [--meta '<json>']
\`\`\`

| Flag | Required | Description |
|------|----------|-------------|
| \`--prompt\` | always | Task description for the agent |
| \`--repo\` | always | Target repository path |
| \`--branch\` | writable agents | Branch name for the isolated clone |
| \`--priority\` | no | \`critical\`, \`high\`, \`medium\`, \`low\` |
| \`--meta\` | recommended | JSON metadata for traceability and deduplication |

Writable agents (developer, fixer) require \`--branch\`. Read-only agents (architect, reviewer, refiner) do not.

### Monitoring
\`\`\`bash
neo runs --short [--all]     # check recent runs
neo runs <runId>             # full run details
neo cost --short [--all]     # check budget
neo agents                   # list available agents
\`\`\`

### Memory
\`\`\`bash
neo memory write --type fact --scope /path "Stable fact about repo"
neo memory write --type focus --expires 2h "Current working context"
neo memory write --type procedure --scope /path "How to do X"
neo memory forget <id>
neo memory search "keyword"
neo memory list --type fact
\`\`\`

### Reporting
\`\`\`bash
neo log <type> "<message>"   # visible in TUI only
\`\`\``;

// ─── Shared instruction blocks ──────────────────────────

const HEARTBEAT_RULES = `### Heartbeat lifecycle
1. Process incoming events (messages, run completions)
2. Follow up on pending work (CI checks, deferred dispatches) with \`neo runs\` or \`gh pr checks\`
3. Make decisions and dispatch agents
4. Update memory and log decisions
5. Yield — each heartbeat should take seconds, not minutes

After dispatching with \`neo run\`, note the runId in your focus and yield. Do NOT poll in a loop.
Completion events arrive at future heartbeats — react then.
If you deferred work (e.g. "CI pending"), you MUST check it at the next heartbeat.`;

const REPORTING_RULES = `### Reporting
\`neo log\` is your ONLY visible output — the TUI shows these and nothing else.
- \`neo log decision "..."\` — why you chose this route
- \`neo log action "..."\` — what you dispatched/did
- \`neo log discovery "..."\` — ephemeral observations
- 1-3 sentences per log. Pack maximum info: ticket, agent, branch, runId, cost, PR#. No markdown.

Your text output is NEVER shown to users.`;

const MEMORY_RULES = `### Memory — types and when to use each

| Type | What | When | TTL |
|------|------|------|-----|
| \`fact\` | Stable truth about a repo | After discovering architecture, stack, conventions | Permanent (decays if unused) |
| \`procedure\` | How-to recipe | After learning a non-obvious workflow | Permanent (decays if unused) |
| \`focus\` | Current working context | After dispatching, deferring work, or changing priorities | Expires (set --expires) |
| \`feedback\` | Recurring review issue | After seeing the same reviewer complaint 3+ times | Permanent |
| \`episode\` | Run outcome | Auto-created on run completion — do NOT write manually | Permanent |

\`\`\`bash
# Focus: what you're working on RIGHT NOW (always set --expires)
neo memory write --type focus --expires 2h "Waiting on CI for PR #42 on myapp"
neo memory write --type focus --expires 4h "3 tickets in progress: PROJ-10, PROJ-11, PROJ-12"

# Facts: stable truths about repos (be descriptive for semantic search)
neo memory write --type fact --scope /path/to/repo "Uses Prisma ORM with PostgreSQL, migrations in prisma/migrations/"
neo memory write --type fact --scope /path/to/repo "CI pipeline: GitHub Actions, ~8min, flaky test in auth.spec.ts"

# Procedures: how-to recipes agents should follow
neo memory write --type procedure --scope /path/to/repo "Run pnpm test:e2e with DATABASE_URL set for integration tests"
neo memory write --type procedure --scope /path/to/repo "Always run pnpm build before pushing — CI doesn't rebuild"

# Feedback: patterns from reviewer that keep recurring
neo memory write --type feedback --scope /path/to/repo --category input_validation "Always validate user input at controller boundaries"

# Forget stale entries
neo memory forget <id>

# Search across all memories (semantic)
neo memory search "database setup"
\`\`\`

**Focus is critical** — always update your focus after dispatching or deferring work. Without focus, you lose context between heartbeats.

**Notes** (\`notes/\`, via Bash): use for detailed multi-page plans, analysis, and checklists that span multiple heartbeats. Delete when done.`;

// ─── Section builders ───────────────────────────────────

function buildContextSections(opts: PromptOptions): string[] {
  const parts: string[] = [];

  if (opts.repos.length > 0) {
    const repoList = opts.repos.map((r) => `- ${r.path} (branch: ${r.defaultBranch})`).join("\n");
    parts.push(`Repositories:\n${repoList}`);
  }

  if (opts.mcpServerNames.length > 0) {
    const mcpList = opts.mcpServerNames.map((n) => `- ${n}`).join("\n");
    parts.push(`Integrations (MCP):\n${mcpList}`);
  }

  parts.push(
    `Budget: $${opts.budgetStatus.todayUsd.toFixed(2)} / $${opts.budgetStatus.capUsd.toFixed(2)} (${opts.budgetStatus.remainingPct.toFixed(0)}% remaining)`,
  );

  return parts;
}

function buildMemorySection(memories: MemoryEntry[], supervisorDir: string): string {
  const focusEntries = memories.filter((m) => m.type === "focus");
  const factEntries = memories.filter((m) => m.type === "fact");
  const procedureEntries = memories.filter((m) => m.type === "procedure");
  const feedbackEntries = memories.filter((m) => m.type === "feedback");

  const parts: string[] = [];

  // Focus (working context)
  if (focusEntries.length > 0) {
    const lines = focusEntries.map((m) => `- ${m.content}`).join("\n");
    parts.push(`<focus>\n${lines}\n</focus>`);
  } else {
    parts.push(
      "<focus>\n(empty — use neo memory write --type focus to set working context)\n</focus>",
    );
  }

  // Known facts
  if (factEntries.length > 0) {
    const lines = factEntries
      .map((m) => {
        const confidence = m.accessCount >= 3 ? "" : " (unconfirmed)";
        return `- ${m.content}${confidence}`;
      })
      .join("\n");
    parts.push(`Known facts:\n${lines}`);
  }

  // Procedures
  if (procedureEntries.length > 0) {
    const lines = procedureEntries.map((m) => `- ${m.content}`).join("\n");
    parts.push(`Procedures:\n${lines}`);
  }

  // Recurring feedback
  if (feedbackEntries.length > 0) {
    const lines = feedbackEntries
      .map((m) => `- [${m.category ?? "general"}] ${m.content}`)
      .join("\n");
    parts.push(`Recurring review issues:\n${lines}`);
  }

  // Notes reminder
  parts.push(`For detailed plans and checklists, use notes:
\`\`\`bash
cat > ${supervisorDir}/notes/plan-feature.md << 'EOF'
<your detailed plan here>
EOF
\`\`\``);

  return parts.join("\n\n");
}

function buildEventsSection(grouped: GroupedEvents): string {
  const { messages, webhooks, runCompletions } = grouped;
  const totalEvents = messages.length + webhooks.length + runCompletions.length;

  if (totalEvents === 0) {
    return "No new events. Idle heartbeat — check on active runs if any, or wait.";
  }

  const parts: string[] = [];
  for (const msg of messages) {
    const countSuffix = msg.count > 1 ? ` (x${msg.count})` : "";
    parts.push(`Message from ${msg.from}${countSuffix}: ${msg.text}`);
  }
  for (const evt of webhooks) {
    parts.push(formatEvent(evt));
  }
  for (const evt of runCompletions) {
    parts.push(formatEvent(evt));
  }
  return `${totalEvents} pending event(s):\n${parts.join("\n\n")}`;
}

function formatEvent(event: QueuedEvent): string {
  switch (event.kind) {
    case "webhook":
      return `Webhook [${event.data.source ?? "unknown"}] ${event.data.event ?? ""}\n\`\`\`json\n${JSON.stringify(event.data.payload ?? {}, null, 2)}\n\`\`\``;
    case "message":
      return `Message from ${event.data.from}: ${event.data.text}`;
    case "run_complete":
      return `Run completed: ${event.runId} (check with \`neo runs\`)`;
    case "internal":
      return `Internal event: ${event.eventKind}`;
  }
}

// ─── Standard prompt (lightweight) ──────────────────────

/**
 * Build the standard heartbeat prompt (4 out of 5 heartbeats).
 * Structure: <role> → <commands> → <context> → <instructions>
 */
export function buildStandardPrompt(opts: StandardPromptOptions): string {
  const sections: string[] = [];

  sections.push(`<role>\n${ROLE}\nHeartbeat #${opts.heartbeatCount}\n</role>`);
  sections.push(`<commands>\n${COMMANDS}\n</commands>`);

  // Context
  const contextParts: string[] = [];
  contextParts.push(...buildContextSections(opts));

  if (opts.activeRuns.length > 0) {
    contextParts.push(`Active runs:\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  contextParts.push(buildMemorySection(opts.memories, opts.supervisorDir));
  contextParts.push(`Events:\n${buildEventsSection(opts.grouped)}`);

  sections.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);

  // Instructions
  const instructionParts: string[] = [];
  instructionParts.push(HEARTBEAT_RULES);
  instructionParts.push(REPORTING_RULES);
  instructionParts.push(MEMORY_RULES);

  if (opts.customInstructions) {
    instructionParts.push(`### Custom instructions\n${opts.customInstructions}`);
  }

  instructionParts.push(
    "This is a standard heartbeat. Focus on processing events and dispatching work.",
  );

  sections.push(`<instructions>\n${instructionParts.join("\n\n")}\n</instructions>`);

  return sections.join("\n\n");
}

// ─── Consolidation prompt ────────────────────────────────

/**
 * Build the consolidation heartbeat prompt (1 out of 5 heartbeats).
 */
export function buildConsolidationPrompt(opts: ConsolidationPromptOptions): string {
  const sections: string[] = [];

  sections.push(`<role>\n${ROLE}\nHeartbeat #${opts.heartbeatCount} (CONSOLIDATION)\n</role>`);
  sections.push(`<commands>\n${COMMANDS}\n</commands>`);

  // Context
  const contextParts: string[] = [];
  contextParts.push(...buildContextSections(opts));

  if (opts.activeRuns.length > 0) {
    contextParts.push(`Active runs:\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  contextParts.push(buildMemorySection(opts.memories, opts.supervisorDir));
  contextParts.push(`Events:\n${buildEventsSection(opts.grouped)}`);

  sections.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);

  // Instructions
  const instructionParts: string[] = [];
  instructionParts.push(HEARTBEAT_RULES);
  instructionParts.push(REPORTING_RULES);
  instructionParts.push(MEMORY_RULES);

  if (opts.customInstructions) {
    instructionParts.push(`### Custom instructions\n${opts.customInstructions}`);
  }

  instructionParts.push(
    `### Consolidation
This is a CONSOLIDATION heartbeat. Your job:

1. **Review memory** — check facts and procedures for accuracy. Remove outdated entries. Resolve contradictions (keep newer).
2. **Update focus** — reflect the current state. Remove resolved items, add new context.
3. **Identify patterns** — if agents keep hitting the same issues, write a procedure or fact to prevent recurrence.

\`\`\`bash
neo memory write --type fact --scope /repos/myapp "Uses Prisma with PostgreSQL"
neo memory write --type focus --expires 4h "Waiting on CI for PR #42"
neo memory forget <stale-id>
\`\`\`

If nothing meaningful changed since last consolidation, skip.`,
  );

  sections.push(`<instructions>\n${instructionParts.join("\n\n")}\n</instructions>`);

  return sections.join("\n\n");
}

// ─── Compaction prompt ──────────────────────────────────

/**
 * Build the compaction heartbeat prompt (every ~50 heartbeats).
 */
export function buildCompactionPrompt(opts: ConsolidationPromptOptions): string {
  const sections: string[] = [];

  sections.push(`<role>\n${ROLE}\nHeartbeat #${opts.heartbeatCount} (COMPACTION)\n</role>`);
  sections.push(`<commands>\n${COMMANDS}\n</commands>`);

  // Context — memory for cleanup review
  const contextParts: string[] = [];
  contextParts.push(...buildContextSections(opts));
  contextParts.push(buildMemorySection(opts.memories, opts.supervisorDir));

  sections.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);

  // Instructions
  const instructionParts: string[] = [];
  instructionParts.push(HEARTBEAT_RULES);
  instructionParts.push(REPORTING_RULES);
  instructionParts.push(MEMORY_RULES);

  if (opts.customInstructions) {
    instructionParts.push(`### Custom instructions\n${opts.customInstructions}`);
  }

  instructionParts.push(`### Compaction
This is a COMPACTION heartbeat. Review your ENTIRE memory for cleanup.

1. Remove stale facts (>7 days old with no recent reinforcement)
2. Merge duplicate or similar facts within the same scope
3. Clean up focus — forget resolved items
4. Delete completed notes from notes/ directory
5. Stay under 20 facts per scope

Flag contradictions: if two facts contradict, keep the newer one.

\`\`\`bash
neo memory forget <stale-id>
neo memory list --type fact
\`\`\``);

  sections.push(`<instructions>\n${instructionParts.join("\n\n")}\n</instructions>`);

  return sections.join("\n\n");
}
