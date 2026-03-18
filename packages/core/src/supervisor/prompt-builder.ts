import type { RepoConfig } from "@/config";
import type { GroupedEvents } from "./event-queue.js";
import type { MemoryEntry } from "./memory/entry.js";
import type { ActivityEntry, QueuedEvent } from "./schemas.js";

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
  recentActions: ActivityEntry[];
}

export interface StandardPromptOptions extends PromptOptions {}

export interface ConsolidationPromptOptions extends PromptOptions {
  /** ISO timestamp of last consolidation — used to filter run history */
  lastConsolidationTimestamp?: string | undefined;
}

// ─── Role (identity + behavioral contract) ──────────────

const ROLE = `You are the neo autonomous supervisor — accountable for delivery across parallel initiatives.

You do not write code directly; you ensure the right work is assigned, executed, reviewed, and completed by the right agent.

<operating-principles>
- Own delivery end-to-end: any queued task without an active owner is your responsibility.
- Operate like a strong engineering lead: provide clear context, dispatch deliberately, validate outcomes, and remove blockers quickly.
- On run completion: ALWAYS read \`neo runs <runId>\`, verify acceptance criteria, then decide next action (done, follow-up, redispatch, escalate).
- On run failure: diagnose root cause before retrying (prompt quality, branch conflict, known issue, environment/tooling), then fix the cause.
- Prevent silent stalls: monitor long-running jobs, detect blocked work early, and actively unblock.
- Keep initiative boundaries strict: decisions for initiative A must not be influenced by unrelated state from B.
- Your user-visible channel is \`neo log\` only; produce concise tool calls (not reasoning/explanations) and avoid wasted tokens.
- You may inspect repositories available via \`neo repos\`, read-only to launch agents.
</operating-principles>`;

// ─── Commands reference ─────────────────────────────────

const COMMANDS = `### Dispatching agents
\`\`\`bash
neo run <agent> --prompt "..." --repo <path> --branch <name> [--priority critical|high|medium|low] [--meta '<json>']
\`\`\`

| Flag | Required | Description |
|------|----------|-------------|
| \`--prompt\` | always | Task description for the agent |
| \`--repo\` | always | Target repository path |
| \`--branch\` | always | Branch name for the isolated clone |
| \`--priority\` | optional | \`critical\`, \`high\`, \`medium\`, \`low\` |
| \`--meta\` | **always** | JSON with \`"label"\` for identification + \`"ticketId"\`, \`"stage"\`, etc. |

All agents require \`--branch\`. Each agent session runs in an isolated clone on that branch.
Always include \`--meta '{"label":"T1-auth-middleware","ticketId":"YC-42","stage":"develop"}'\` so you can identify runs later.

### Monitoring & reading agent output
\`\`\`bash
neo runs --short                    # check recent runs
neo runs --short --status running   # check active runs are alive
neo runs <runId>                    # full run details + agent output (MUST READ on completion)
neo cost --short [--all]            # check budget
\`\`\`

\`neo runs <runId>\` returns the agent's full output. **ALWAYS read it when a run completes** — it contains structured JSON (PR URLs, issues, plans, milestones) that you need to decide next steps.

### Memory
\`\`\`bash
neo memory write --type fact --scope /path "Stable fact about repo"
neo memory write --type focus --expires 2h "Current working context"
neo memory write --type procedure --scope /path "How to do X"
neo memory write --type task --scope /path --severity high --category "neo runs <id>" "Task description"
neo memory update <id> --outcome in_progress|done|blocked|abandoned
neo memory forget <id>
neo memory search "keyword"
neo memory list --type fact
\`\`\`

### Reporting
\`\`\`bash
neo log <type> "<message>"   # visible in TUI only
\`\`\``;

const COMMANDS_COMPACT = `### Commands (reference)
\`neo run <agent> --prompt "..." --repo <path> --branch <name> --meta '{"label":"T1-auth",...}'\`
\`neo runs [--short | <runId>]\` · \`neo runs --short --status running\` · \`neo cost --short\`
\`neo memory write|update|forget|search|list\` · \`neo log <type> "<msg>"\``;

// ─── Shared instruction blocks ──────────────────────────

const HEARTBEAT_RULES = `### Heartbeat lifecycle

<decision-tree>
1. DEDUP FIRST — check focus for PROCESSED entries. Skip any runId already processed.
2. MONITOR RUNS — \`neo runs --short\` to check active run status. If a run completed since last HB, read its output with \`neo runs <runId>\` BEFORE doing anything else.
3. PENDING TASKS? — dispatch the next eligible task from work queue. Do not re-plan.
4. EVENTS? — process run completions, messages, webhooks. Parse agent JSON output.
5. FOLLOW-UPS? — check CI (\`gh pr checks\`), deferred dispatches.
6. DISPATCH — route work to agents. Mark tasks \`in_progress\`, add ACTIVE to focus.
7. SERIALIZE & YIELD — rewrite focus (see <focus>), log your decisions, and yield. Do not poll.
</decision-tree>

<run-monitoring>
Runs are your agents in the field. You MUST actively track them:
- **On dispatch**: include a label in \`--meta\` for identification: \`--meta '{"label":"T6-csv-export","ticketId":"YC-42",...}'\`
- **On completion**: ALWAYS run \`neo runs <runId>\` to read the full output. Parse structured JSON (PR URLs, issues, plans). This is NOT optional — you cannot decide next steps without reading the output.
- **On failure**: read the output to understand why. Decide: retry (blocked), abandon, or escalate.
- **Active runs**: check \`neo runs --short --status running\` to verify your runs are still alive. If a run disappeared, investigate.
</run-monitoring>

<multi-task-initiatives>
**Branch strategy:** one branch per initiative — all tasks push to the same branch sequentially (never in parallel). First task creates the branch; open PR after it completes. Later tasks add commits to the same PR. Independent initiatives CAN run in parallel on different branches.

**Dispatch quality:** write a detailed \`--prompt\` with acceptance criteria, files to modify, and context from completed sibling tasks (commits, APIs added, files changed). When dispatching task N, summarize what tasks 1..N-1 produced.

**Post-completion:** if agent opened a PR, dispatch \`reviewer\` in parallel with CI (do not wait). Update task outcome with concrete details (PR#, what was done) and update the initiative note.

**Memory:** store key outputs as facts if they affect future tasks (e.g. "T5 added dateRange param to fetchAllFstRecords").
</multi-task-initiatives>`;

const REPORTING_RULES = `### Reporting

\`neo log\` is your ONLY visible output. Use telegraphic format.

<log-format>
neo log decision "<ticket> → <action> | <1-line reason>"
neo log action "<agent> <repo>:<branch> run:<runId> | <context>"
neo log discovery "<what> in <where>"
</log-format>

<examples type="good">
neo log decision "YC-42 → developer | clear spec, complexity 3"
neo log action "developer standards:feat/YC-42-auth run:5900a64a | task T1"
neo log discovery "CI requires node 20 in api-service"
</examples>`;

const MEMORY_RULES_CORE = `### Memory

<memory-types>
| Type | Store when | TTL |
|------|-----------|-----|
| \`fact\` | Stable truth affecting dispatch decisions | Permanent (decays) |
| \`procedure\` | Same failure 3+ times | Permanent |
| \`focus\` | After every dispatch/deferral | --expires required |
| \`task\` | Any planned work (tickets, decompositions, follow-ups) | Until done/abandoned |
| \`feedback\` | Same review complaint 3+ times | Permanent |
</memory-types>

<memory-rules>
- Focus is free-form working memory — rewrite at end of EVERY heartbeat (see <focus>).
- NEVER store: file counts, line numbers, completed work details, data available via \`neo runs <id>\`.
- After PR merge: forget related facts unless they are reusable architectural truths.
- Pattern escalation: same failure 3+ times → write a \`procedure\`.
- Every memory that references external context MUST include a retrieval command (in \`--category\` for tasks, in content for facts/procedures). You are stateless — if you can't retrieve it later, don't store it.
</memory-rules>

<task-workflow>
Queue markers: ○ pending · [ACTIVE] in_progress · [BLOCKED] blocked.
Create tasks for: incoming tickets, architect decompositions, sub-tickets, follow-ups, CI fixes.
- \`--tags "initiative:<name>"\` — groups related tasks
- \`--tags "depends:mem_<id>"\` — blocks until dependency is done
- \`--category\` — retrieval command (MANDATORY). Examples: \`"neo runs <runId>"\` · \`"cat notes/plan-feature.md"\` · \`"API-retrieve-a-page <notionPageId>"\`
Lifecycle: create → in_progress (on dispatch) → done | blocked | abandoned
</task-workflow>

<focus>
You are stateless between heartbeats. Focus is your scratchpad — the only thing future-you will read before acting.

Write it like a handoff note to yourself: what's happening, what you decided, what to do next, what to watch for. Free-form. No format imposed. The only rule: if you don't write it down, you lose it.

Rewrite focus at the END of every heartbeat. Never leave it empty after a heartbeat with activity.
</focus>

<notes>
Use notes/ for any initiative with 3+ tasks (persists across heartbeats).
- Write: \`cat > notes/plan-<initiative>.md << 'EOF' ... EOF\`
- Link to tasks: \`--category "cat notes/plan-<initiative>.md"\`
- Update after each task: check off milestones, add PR numbers, note blockers
- Delete when initiative is done
Use cases: architect decompositions, initiative tracking, debugging across heartbeats, review checklists.
</notes>`;

const MEMORY_RULES_EXAMPLES = `<memory-examples>
neo memory write --type focus --expires 2h "ACTIVE: 5900a64a developer 'T1' branch:feat/x (cat notes/plan-YC-2670-kanban.md)"
neo memory write --type fact --scope /repo "main branch uses protected merges — agents must create PRs, never push directly"
neo memory write --type fact --scope /repo "pnpm build must pass before push — CI does not rebuild, run 2g589f34a5a failed without it"
neo memory write --type procedure --scope /repo "After architect run: parse milestones from JSON output, create one task per milestone with --tags initiative:<name>"
neo memory write --type procedure --scope /repo "When developer run fails with ENOSPC: the repo has large fixtures — use --branch with shallow clone flag"
neo memory write --type feedback --scope /repo "User wants PR descriptions in French even though code is in English"
neo memory write --type task --scope /repo --severity high --category "neo runs 2g589f34a5a" --tags "initiative:auth-v2,depends:mem_xyz" "T1: Auth middleware"
neo memory update <id> --outcome in_progress|done|blocked|abandoned
neo memory forget <id>
</memory-examples>`;

// ─── Section builders ───────────────────────────────────

function getCommandsSection(heartbeatCount: number): string {
  return heartbeatCount <= 3 ? COMMANDS : COMMANDS_COMPACT;
}

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

function buildMemorySection(memories: MemoryEntry[]): string {
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

  // Known facts — grouped by scope with staleness signal
  if (factEntries.length > 0) {
    const byScope = new Map<string, MemoryEntry[]>();
    for (const m of factEntries) {
      const scope = m.scope === "global" ? "global" : (m.scope.split("/").pop() ?? m.scope);
      const group = byScope.get(scope) ?? [];
      group.push(m);
      byScope.set(scope, group);
    }

    const scopeSections: string[] = [];
    for (const [scope, entries] of byScope) {
      const oldestAccess = Math.min(
        ...entries.map((m) => Date.now() - new Date(m.lastAccessedAt).getTime()),
      );
      const daysAgo = Math.floor(oldestAccess / 86_400_000);
      const staleHint = daysAgo >= 5 ? ` (last accessed ${daysAgo}d ago)` : "";
      const lines = entries
        .map((m) => {
          const confidence = m.accessCount >= 3 ? "" : " (unconfirmed)";
          return `  - ${m.content}${confidence}`;
        })
        .join("\n");
      scopeSections.push(`  [${scope}]${staleHint} (${entries.length})\n${lines}`);
    }
    parts.push(`Known facts:\n${scopeSections.join("\n")}`);
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

  return parts.join("\n\n");
}

// ─── Work queue (tasks) ─────────────────────────────────

const DONE_OUTCOMES = new Set(["done", "abandoned"]);
const MAX_TASKS = 15;

interface TaskGroup {
  initiative: string | null;
  tasks: MemoryEntry[];
}

export function buildWorkQueueSection(memories: MemoryEntry[]): string {
  const tasks = memories.filter((m) => m.type === "task" && !DONE_OUTCOMES.has(m.outcome ?? ""));
  const doneCount = countDoneTasks(memories);

  if (tasks.length === 0) {
    if (doneCount > 0) {
      return `Work queue (0 remaining, ${doneCount} done) — all tasks complete. Pick up new work or wait for events.`;
    }
    return "";
  }

  const groups = groupTasksByInitiative(tasks);
  const lines = renderTaskGroups(groups);

  if (tasks.length > MAX_TASKS) {
    lines.push(`  ... and ${tasks.length - MAX_TASKS} more pending`);
  }

  const header = `Work queue (${tasks.length} remaining, ${doneCount} done) — dispatch the next eligible task:`;
  return `${header}\n${lines.join("\n")}`;
}

function countDoneTasks(memories: MemoryEntry[]): number {
  return memories.filter((m) => m.type === "task" && DONE_OUTCOMES.has(m.outcome ?? "")).length;
}

function groupTasksByInitiative(tasks: MemoryEntry[]): TaskGroup[] {
  const initiativeMap = new Map<string, MemoryEntry[]>();
  const noInitiative: MemoryEntry[] = [];

  for (const task of tasks) {
    const tag = task.tags.find((t) => t.startsWith("initiative:"));
    if (tag) {
      const key = tag.slice("initiative:".length);
      const group = initiativeMap.get(key) ?? [];
      group.push(task);
      initiativeMap.set(key, group);
    } else {
      noInitiative.push(task);
    }
  }

  const groups: TaskGroup[] = [];
  for (const [initiative, taskList] of initiativeMap) {
    groups.push({ initiative, tasks: taskList });
  }
  if (noInitiative.length > 0) {
    groups.push({ initiative: null, tasks: noInitiative });
  }
  return groups;
}

function renderTaskGroups(groups: TaskGroup[]): string[] {
  const lines: string[] = [];
  let rendered = 0;

  for (const group of groups) {
    if (rendered >= MAX_TASKS) break;
    if (group.initiative && groups.length > 1) {
      lines.push(`  [${group.initiative}]`);
    }
    for (const task of group.tasks) {
      if (rendered >= MAX_TASKS) break;
      lines.push(`  ${formatTaskLine(task)}`);
      rendered++;
    }
  }

  return lines;
}

function formatTaskLine(task: MemoryEntry): string {
  const marker = formatTaskMarker(task.outcome);
  const severity = task.severity ? `[${task.severity}] ` : "";
  const scope = task.scope !== "global" ? ` (${getBasename(task.scope)})` : "";
  const run = task.runId ? ` [run ${task.runId.slice(0, 8)}]` : "";
  const cat = task.category ? ` → ${task.category}` : "";
  return `${marker} ${severity}${task.content}${scope}${run}${cat}`;
}

function formatTaskMarker(outcome: string | undefined): string {
  switch (outcome) {
    case "in_progress":
      return "[ACTIVE]";
    case "blocked":
      return "[BLOCKED]";
    default:
      return "○";
  }
}

function getBasename(scopePath: string): string {
  const parts = scopePath.split("/");
  return parts[parts.length - 1] || scopePath;
}

// ─── Recent actions ─────────────────────────────────────

const SIGNIFICANT_TYPES = new Set(["decision", "action", "dispatch", "error"]);

function buildRecentActionsSection(entries: ActivityEntry[]): string {
  const significant = entries.filter((e) => SIGNIFICANT_TYPES.has(e.type));
  if (significant.length === 0) return "";

  const lines = significant.map((e) => {
    const ago = formatTimeAgo(Date.now() - new Date(e.timestamp).getTime());
    return `- [${e.type}] ${e.summary} (${ago})`;
  });

  return `Recent actions (your last heartbeats):\n${lines.join("\n")}`;
}

function formatTimeAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ─── Events ─────────────────────────────────────────────

function buildEventsSection(grouped: GroupedEvents): string {
  const { messages, webhooks, runCompletions } = grouped;
  const totalEvents = messages.length + webhooks.length + runCompletions.length;

  if (totalEvents === 0) {
    return "No new events.";
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

// ─── Idle prompt (minimal — no events, no runs, no tasks) ─

/**
 * Check if this heartbeat has nothing to do.
 */
export function isIdleHeartbeat(opts: PromptOptions): boolean {
  const { messages, webhooks, runCompletions } = opts.grouped;
  const totalEvents = messages.length + webhooks.length + runCompletions.length;
  const hasWork = buildWorkQueueSection(opts.memories) !== "";
  return totalEvents === 0 && opts.activeRuns.length === 0 && !hasWork;
}

/**
 * Build a minimal idle prompt (~50 tokens).
 * Used when there are no events, no active runs, and no pending tasks.
 */
export function buildIdlePrompt(opts: StandardPromptOptions): string {
  return `<role>
${ROLE}
Heartbeat #${opts.heartbeatCount}
</role>

<context>
No events. No active runs. No pending tasks.
Budget: $${opts.budgetStatus.todayUsd.toFixed(2)} / $${opts.budgetStatus.capUsd.toFixed(2)} (${opts.budgetStatus.remainingPct.toFixed(0)}% remaining)
</context>

<directive>
Nothing to do. Run \`neo log discovery "idle"\` and yield. Do not produce any other output.
</directive>`;
}

// ─── Standard prompt ────────────────────────────────────

/**
 * Build the standard heartbeat prompt (4 out of 5 heartbeats).
 * Structure: <role> → <context> (data top) → <reference> → <instructions> (rules bottom)
 */
export function buildStandardPrompt(opts: StandardPromptOptions): string {
  const sections: string[] = [];

  // Role — identity + behavioral contract
  sections.push(`<role>\n${ROLE}\nHeartbeat #${opts.heartbeatCount}\n</role>`);

  // Context — data first (Anthropic best practice: data top, instructions bottom)
  const contextParts: string[] = [];

  const workQueue = buildWorkQueueSection(opts.memories);
  if (workQueue) {
    contextParts.push(workQueue);
  }

  if (opts.activeRuns.length > 0) {
    contextParts.push(`Active runs:\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  contextParts.push(...buildContextSections(opts));
  contextParts.push(buildMemorySection(opts.memories));

  const recentActions = buildRecentActionsSection(opts.recentActions);
  if (recentActions) {
    contextParts.push(recentActions);
  }

  contextParts.push(`Events:\n${buildEventsSection(opts.grouped)}`);

  sections.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);

  // Reference — commands (compact after first few heartbeats)
  sections.push(`<reference>\n${getCommandsSection(opts.heartbeatCount)}\n</reference>`);

  // Instructions — rules last
  const instructionParts: string[] = [];
  instructionParts.push(HEARTBEAT_RULES);
  instructionParts.push(REPORTING_RULES);
  instructionParts.push(MEMORY_RULES_CORE);

  if (opts.customInstructions) {
    instructionParts.push(`### Custom instructions\n${opts.customInstructions}`);
  }

  const { messages, webhooks, runCompletions } = opts.grouped;
  const hasEvents = messages.length + webhooks.length + runCompletions.length > 0;
  instructionParts.push(
    hasEvents
      ? "Process events, dispatch eligible work, yield. Each heartbeat costs ~$0.10 — be efficient."
      : "No events. If pending work exists, dispatch it. Otherwise yield immediately.",
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

  // Context — data first
  const contextParts: string[] = [];

  const workQueueConsolidation = buildWorkQueueSection(opts.memories);
  if (workQueueConsolidation) {
    contextParts.push(workQueueConsolidation);
  }

  if (opts.activeRuns.length > 0) {
    contextParts.push(`Active runs:\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  contextParts.push(...buildContextSections(opts));
  contextParts.push(buildMemorySection(opts.memories));

  const recentActions = buildRecentActionsSection(opts.recentActions);
  if (recentActions) {
    contextParts.push(recentActions);
  }

  contextParts.push(`Events:\n${buildEventsSection(opts.grouped)}`);

  sections.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);

  // Reference
  sections.push(`<reference>\n${getCommandsSection(opts.heartbeatCount)}\n</reference>`);

  // Instructions
  const instructionParts: string[] = [];
  instructionParts.push(HEARTBEAT_RULES);
  instructionParts.push(REPORTING_RULES);
  instructionParts.push(MEMORY_RULES_CORE);
  instructionParts.push(MEMORY_RULES_EXAMPLES);

  if (opts.customInstructions) {
    instructionParts.push(`### Custom instructions\n${opts.customInstructions}`);
  }

  instructionParts.push(
    `### Consolidation
This is a CONSOLIDATION heartbeat.

**Idle guard**: if there are NO active runs AND no new events since last consolidation, log "idle, no changes" and yield immediately. Do NOT re-validate facts you already reviewed.

If there IS active work, your job:

1. **Review memory** — check facts and procedures for accuracy. Remove outdated entries. Resolve contradictions (keep newer). Remove facts about completed work (merged PRs, finished initiatives).
2. **Update focus** — rewrite focus using the MANDATORY structured format (ACTIVE/PENDING/WAITING/PROCESSED). Remove resolved items. Add new context.
3. **Pattern escalation** — if agents hit the same issue 3+ times (check recent actions), write a \`procedure\` to prevent recurrence.
4. **Prune completed work** — if a PR is merged or an initiative is done, forget related facts that are no longer actionable. Keep only reusable architectural truths.
5. **Prune done tasks** — forget tasks with outcome \`done\` or \`abandoned\` older than 7 days.`,
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

  // Context — memory for cleanup review
  const contextParts: string[] = [];
  contextParts.push(...buildContextSections(opts));
  contextParts.push(buildMemorySection(opts.memories));

  const workQueueCompaction = buildWorkQueueSection(opts.memories);
  if (workQueueCompaction) {
    contextParts.push(workQueueCompaction);
  }

  sections.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);

  // Reference
  sections.push(`<reference>\n${getCommandsSection(opts.heartbeatCount)}\n</reference>`);

  // Instructions
  const instructionParts: string[] = [];
  instructionParts.push(HEARTBEAT_RULES);
  instructionParts.push(REPORTING_RULES);
  instructionParts.push(MEMORY_RULES_CORE);
  instructionParts.push(MEMORY_RULES_EXAMPLES);

  if (opts.customInstructions) {
    instructionParts.push(`### Custom instructions\n${opts.customInstructions}`);
  }

  instructionParts.push(`### Compaction
This is a COMPACTION heartbeat. Deep-clean your ENTIRE memory.

1. **Remove stale facts** — facts >7 days old with no recent reinforcement. Check the "(last accessed Xd ago)" hints in the facts section.
2. **Remove completed-work facts** — if all PRs for a repo initiative are merged/closed, forget related facts. Keep only reusable architectural truths (build system, CI config, tooling).
3. **Remove trivial facts** — file counts, line numbers, structural details that \`ls\` or \`cat package.json\` can answer. These waste context.
4. **Merge duplicates** — combine similar facts within the same scope into one.
5. **Clean up focus** — forget resolved items, rewrite remaining in structured format.
6. **Prune done tasks** — forget tasks with outcome \`done\` or \`abandoned\` older than 7 days.
7. **Delete completed notes** from notes/ directory.
8. **Stay under 15 facts per scope** — prioritize facts that affect dispatch decisions.

Flag contradictions: if two facts contradict, keep the newer one.

\`\`\`bash
neo memory list --type fact
neo memory forget <stale-id>
\`\`\``);

  sections.push(`<instructions>\n${instructionParts.join("\n\n")}\n</instructions>`);

  return sections.join("\n\n");
}
