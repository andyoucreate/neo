import type { RepoConfig } from "@/config";
import type { GroupedEvents } from "./event-queue.js";
import { buildAgentDigest } from "./log-buffer.js";
import {
  getActiveRunsWithNotes,
  getRecentCompletedRunsWithNotes,
  getRecentRunHistory,
} from "./run-notes.js";
import type { LogBufferEntry, QueuedEvent } from "./schemas.js";

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
  focusMd: string;
}

export interface StandardPromptOptions extends PromptOptions {
  recentEntries: LogBufferEntry[];
}

export interface ConsolidationPromptOptions extends PromptOptions {
  knowledgeMd: string;
  allUnconsolidatedEntries: LogBufferEntry[];
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

### Other commands
\`\`\`bash
neo runs --short [--all]     # check recent runs
neo runs <runId>             # full run details
neo notes <runId> <type> "text"  # add a note to a run
neo notes <runId>            # show run timeline
neo notes --active           # show notes from all active runs
neo cost --short [--all]     # check budget
neo agents                   # list available agents
neo log <type> "<message>"   # log a progress report
\`\`\``;

// ─── Shared instruction blocks ──────────────────────────

const HEARTBEAT_RULES = `### Heartbeat lifecycle
1. Process incoming events (messages, run completions)
2. Follow up on pending work (CI checks, deferred dispatches) with \`neo runs\` or \`gh pr checks\`
3. Make decisions and dispatch agents
4. Log decisions with \`neo log\`, update your focus
5. Yield — each heartbeat should take seconds, not minutes

After dispatching with \`neo run\`, note the runId in your focus and yield. Do NOT poll in a loop.
Completion events arrive at future heartbeats — react then.
If you deferred work (e.g. "CI pending"), you MUST check it at the next heartbeat.`;

const REPORTING_RULES = `### Reporting
\`neo log\` is your ONLY visible output — the TUI shows these and nothing else. Be synthetic but information-dense.
- \`neo log decision "..."\` — why you chose this route
- \`neo log action "..."\` — what you dispatched/did
- \`neo log discovery --knowledge "..."\` — stable facts to persist
- \`neo log discovery "..."\` — observations about active work (update focus for important context)
- 1-3 sentences per log. Pack maximum info: ticket, agent, branch, runId, cost, PR#. No markdown.

Your text output is NEVER shown to users. Do not write summaries or reports outside of \`neo log\`.`;

const MEMORY_VERTICALS = `### Memory verticals — what goes where
- **Focus** (\`focus.md\`, auto-loaded): important context for current work — decisions, pending follow-ups, what you're waiting on. High-signal, ephemeral (hours to days).
- **Notes** (\`notes/\`, read on demand): detailed plans, analysis, checklists that span multiple heartbeats. Prefix: \`plan-\`, \`context-\`, \`checklist-\`. Delete when done.
- **Knowledge** (\`knowledge.md\`, rewritten via Bash during consolidation): STABLE FACTS about repos, systems, and processes. Not for ephemeral working context.

If it only matters for the current task, put it in focus. If it's a stable fact, use knowledge. If it's a detailed document, use notes.`;

const RUN_NOTES_INSTRUCTIONS = `### Run notes
Track active runs with \`neo notes\`. Notes are persisted per-run and surface in future heartbeats via the "activeRuns" hot state, so consolidation can integrate them.

\`\`\`bash
neo notes <runId> <type> "text"
\`\`\`

| Type | When to use |
|------|-------------|
| \`observation\` | Notable output from a run (test results, PR status, errors seen) |
| \`decision\` | Why you chose a particular approach for this run |
| \`stage\` | Run entered a new phase (e.g. "tests running", "PR opened") |
| \`blocker\` | Something is blocking progress on this run |
| \`resolution\` | A previously logged blocker has been resolved |

Emit notes after dispatching, after checking run status, and when processing run_complete events.

\`\`\`bash
neo notes abc12345 stage "Dispatched to fix auth module"
neo notes abc12345 observation "Tests passing, PR #42 opened"
neo notes def67890 blocker "CI failing — missing API key"
neo notes def67890 resolution "Key added, CI re-triggered"
\`\`\``;

// ─── Hot state rendering ────────────────────────────────

/**
 * Render the hot state using active runs with notes (from persisted run files).
 * Also includes recently completed/failed runs and blockers from pending entries.
 * Format: runId [STATUS duration] workflow — repo + notes
 */
export async function renderHotStateWithRunNotes(
  pendingEntries: LogBufferEntry[],
): Promise<string> {
  const lines: string[] = [];

  const activeRunsWithNotes = await getActiveRunsWithNotes(3);
  if (activeRunsWithNotes) {
    lines.push("activeRuns:");
    for (const line of activeRunsWithNotes.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  const recentCompleted = await getRecentCompletedRunsWithNotes();
  if (recentCompleted) {
    lines.push("recentlyCompleted:");
    for (const line of recentCompleted.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  const blockers: string[] = [];
  for (const entry of pendingEntries) {
    if (entry.type === "blocker") {
      blockers.push(entry.message);
    }
  }

  if (blockers.length > 0) {
    lines.push("blockers:");
    for (const desc of blockers) {
      lines.push(`  - [NEW] ${desc}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "No active runs or blockers.";
}

// ─── Section builders ───────────────────────────────────

function buildContextSections(opts: PromptOptions): string[] {
  const parts: string[] = [];

  // Config context
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

function buildFocusSection(focusMd: string, supervisorDir: string): string {
  const content =
    focusMd.trim() ||
    "(empty — this is a fresh start. Write your initial context here after processing your first events.)";
  return `<focus>
${content}
</focus>

Update your focus when important context changes:
\`\`\`bash
cat > ${supervisorDir}/focus.md << 'EOF'
<your working context here>
EOF
\`\`\`

**In focus:** key decisions, pending follow-ups, what you're waiting on, constraints you'd lose between heartbeats.
**Not in focus:** stable facts (use knowledge), detailed plans (use notes/), raw progress (use \`neo log\`).
Keep it short and high-signal. Rewrite fully when context changes.`;
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
export async function buildStandardPrompt(opts: StandardPromptOptions): Promise<string> {
  const sections: string[] = [];

  // Role
  sections.push(`<role>\n${ROLE}\nHeartbeat #${opts.heartbeatCount}\n</role>`);

  // Commands
  sections.push(`<commands>\n${COMMANDS}\n</commands>`);

  // Context — all variable data grouped together
  const contextParts: string[] = [];
  contextParts.push(...buildContextSections(opts));

  const hotState = await renderHotStateWithRunNotes(opts.recentEntries);
  contextParts.push(`Current state:\n${hotState}`);

  if (opts.activeRuns.length > 0) {
    contextParts.push(`Active runs:\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  contextParts.push(buildFocusSection(opts.focusMd, opts.supervisorDir));

  const digest = buildAgentDigest(opts.recentEntries);
  if (digest) {
    contextParts.push(`Agent digest:\n${digest}`);
  }

  contextParts.push(`Events:\n${buildEventsSection(opts.grouped)}`);

  sections.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);

  // Instructions — all behavioral rules grouped together
  const instructionParts: string[] = [];
  instructionParts.push(HEARTBEAT_RULES);
  instructionParts.push(REPORTING_RULES);
  instructionParts.push(MEMORY_VERTICALS);

  if (opts.customInstructions) {
    instructionParts.push(`### Custom instructions\n${opts.customInstructions}`);
  }

  instructionParts.push(RUN_NOTES_INSTRUCTIONS);

  instructionParts.push(
    "This is a standard heartbeat. Focus on processing events and dispatching work. Record observations about active runs using run-notes so consolidation heartbeats can integrate them.",
  );

  sections.push(`<instructions>\n${instructionParts.join("\n\n")}\n</instructions>`);

  return sections.join("\n\n");
}

// ─── Consolidation prompt (knowledge review) ────────────

/**
 * Build the consolidation heartbeat prompt (1 out of 5 heartbeats).
 * Structure: <role> → <commands> → <context> → <instructions>
 */
export async function buildConsolidationPrompt(opts: ConsolidationPromptOptions): Promise<string> {
  const sections: string[] = [];

  // Role
  sections.push(`<role>\n${ROLE}\nHeartbeat #${opts.heartbeatCount} (CONSOLIDATION)\n</role>`);

  // Commands
  sections.push(`<commands>\n${COMMANDS}\n</commands>`);

  // Context — all variable data grouped together (including knowledge)
  const contextParts: string[] = [];
  contextParts.push(...buildContextSections(opts));

  const hotState = await renderHotStateWithRunNotes(opts.allUnconsolidatedEntries);
  contextParts.push(`Current state:\n${hotState}`);

  if (opts.activeRuns.length > 0) {
    contextParts.push(`Active runs:\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  contextParts.push(buildFocusSection(opts.focusMd, opts.supervisorDir));

  const digest = buildAgentDigest(opts.allUnconsolidatedEntries);
  if (digest) {
    contextParts.push(`Agent digest (accumulated):\n${digest}`);
  }

  contextParts.push(`Events:\n${buildEventsSection(opts.grouped)}`);

  // Run history — full notes from runs since last consolidation
  const runHistory = await getRecentRunHistory(opts.lastConsolidationTimestamp, 10);
  if (runHistory) {
    contextParts.push(`Run history (since last consolidation):\n${runHistory}`);
  }

  if (opts.knowledgeMd) {
    contextParts.push(`Current knowledge.md:\n${opts.knowledgeMd}`);
  } else {
    contextParts.push("Current knowledge.md: (empty)");
  }

  sections.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);

  // Instructions — consolidation workflow
  const instructionParts: string[] = [];
  instructionParts.push(HEARTBEAT_RULES);
  instructionParts.push(REPORTING_RULES);
  instructionParts.push(MEMORY_VERTICALS);

  if (opts.customInstructions) {
    instructionParts.push(`### Custom instructions\n${opts.customInstructions}`);
  }

  instructionParts.push(
    `### Consolidation
This is a CONSOLIDATION heartbeat. Your job:

1. **Review run history** — read all notes from runs since last consolidation (decisions, observations, blockers, outcomes). Extract stable facts worth remembering long-term.
2. **Review agent digest** — check accumulated neo log entries for discoveries and decisions.
3. **Rewrite knowledge.md** — integrate new learnings from runs. Remove outdated facts. Resolve contradictions (keep newer). Keep it concise and organized by repo/topic.
4. **Update focus.md** — reflect the current state. Remove resolved items, add new context.

Rewrite knowledge.md via Bash:
\`\`\`bash
cat > ${opts.supervisorDir}/knowledge.md << 'EOF'
## Global
- stable facts applicable everywhere

## /repos/myapp
- architecture decisions learned from runs
- conventions, tech stack, recurring patterns
EOF
\`\`\`

What belongs in knowledge: architecture decisions, tech stack, conventions, API configs, recurring patterns — facts that help future agents work better on these repos.
What does NOT belong: ephemeral status (use focus), detailed plans (use notes/), raw progress (use neo log).
If nothing meaningful changed since last consolidation, skip the rewrite.`,
  );
  instructionParts.push(RUN_NOTES_INSTRUCTIONS);

  sections.push(`<instructions>\n${instructionParts.join("\n\n")}\n</instructions>`);

  return sections.join("\n\n");
}

// ─── Compaction prompt ──────────────────────────────────

/**
 * Build the compaction heartbeat prompt (every ~50 heartbeats).
 * Structure: <role> → <commands> → <context> → <instructions>
 */
export async function buildCompactionPrompt(opts: ConsolidationPromptOptions): Promise<string> {
  const sections: string[] = [];

  // Role
  sections.push(`<role>\n${ROLE}\nHeartbeat #${opts.heartbeatCount} (COMPACTION)\n</role>`);

  // Commands
  sections.push(`<commands>\n${COMMANDS}\n</commands>`);

  // Context — knowledge for cleanup review
  const contextParts: string[] = [];
  contextParts.push(...buildContextSections(opts));

  contextParts.push(buildFocusSection(opts.focusMd, opts.supervisorDir));

  if (opts.knowledgeMd) {
    contextParts.push(`Reference knowledge:\n${opts.knowledgeMd}`);
  }

  sections.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);

  // Instructions — cleanup rules
  const instructionParts: string[] = [];
  instructionParts.push(HEARTBEAT_RULES);
  instructionParts.push(REPORTING_RULES);
  instructionParts.push(MEMORY_VERTICALS);

  if (opts.customInstructions) {
    instructionParts.push(`### Custom instructions\n${opts.customInstructions}`);
  }

  instructionParts.push(`### Compaction tasks
This is a COMPACTION heartbeat. Review your ENTIRE knowledge and focus for cleanup.

1. Remove stale facts from knowledge (>7 days old with no recent reinforcement)
2. Merge duplicate or similar facts within the same repo section
3. Clean up focus — remove resolved items, prune stale context
4. Delete completed notes from notes/ directory
5. Stay under 20 facts per repo in knowledge

Flag contradictions: if two facts contradict, keep the newer one.
Rewrite knowledge.md via Bash if changes are needed. If nothing to change, skip.

\`\`\`bash
cat > ${opts.supervisorDir}/knowledge.md << 'EOF'
<cleaned up knowledge here>
EOF
\`\`\``);

  instructionParts.push(RUN_NOTES_INSTRUCTIONS);

  sections.push(`<instructions>\n${instructionParts.join("\n\n")}\n</instructions>`);

  return sections.join("\n\n");
}
