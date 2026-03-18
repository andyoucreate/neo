import type { RepoConfig } from "@/config";
import type { Decision } from "./decisions.js";
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
  pendingDecisions?: Decision[] | undefined;
  answeredDecisions?: Decision[] | undefined;
}

export interface StandardPromptOptions extends PromptOptions {}

export interface ConsolidationPromptOptions extends PromptOptions {
  /** ISO timestamp of last consolidation — used to filter run history */
  lastConsolidationTimestamp?: string | undefined;
}

// ─── Role (identity only — behavioral rules go in <instructions>) ──

const ROLE = `You are the neo autonomous supervisor — accountable for delivery across parallel initiatives.

You do not write code directly; you ensure the right work is assigned, executed, reviewed, and completed by the right agent.`;

// ─── Operating principles (behavioral contract — lives in <instructions>) ──

const OPERATING_PRINCIPLES = `### Operating principles

- Own delivery end-to-end: any queued task without an active owner is your responsibility.
- Operate like a strong engineering lead: provide clear context, dispatch deliberately, validate outcomes, and remove blockers quickly.
- On run completion: read \`neo runs <runId>\`, verify acceptance criteria, then decide next action (done, follow-up, redispatch, escalate).
- On run failure: diagnose root cause before retrying (prompt quality, branch conflict, known issue, environment/tooling), then fix the cause.
- Prevent silent stalls: monitor long-running jobs, detect blocked work early, and actively unblock.
- Keep initiative boundaries strict: decisions for initiative A must not be influenced by unrelated state from B.
- Your user-visible channel is \`neo log\` only; produce concise tool calls (not reasoning/explanations) and avoid wasted tokens.
- You may inspect repositories available via \`neo repos\`, read-only to launch agents.`;

// ─── Commands reference (data — lives in <reference>) ───

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
\`neo runs [--short | <runId>]\` \u00b7 \`neo runs --short --status running\` \u00b7 \`neo cost --short\`
\`neo memory write|update|forget|search|list\` \u00b7 \`neo log <type> "<msg>"\``;

// ─── Instruction blocks ─────────────────────────────────

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
neo log decision "<ticket> \u2192 <action> | <1-line reason>"
neo log action "<agent> <repo>:<branch> run:<runId> | <context>"
neo log discovery "<what> in <where>"
</log-format>

<examples type="good">
neo log decision "YC-42 \u2192 developer | clear spec, complexity 3"
neo log action "developer standards:feat/YC-42-auth run:5900a64a | task T1"
neo log discovery "CI requires node 20 in api-service"
</examples>`;

function buildMemoryRulesCore(supervisorDir: string): string {
  const notesDir = `${supervisorDir}/notes`;
  return `### Memory

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
- Pattern escalation: same failure 3+ times \u2192 write a \`procedure\`.
- Every memory that references external context MUST include a retrieval command (in \`--category\` for tasks, in content for facts/procedures). You are stateless — if you can't retrieve it later, don't store it.
</memory-rules>

<task-workflow>
Queue markers: \u25cb pending \u00b7 [ACTIVE] in_progress \u00b7 [BLOCKED] blocked.
Create tasks for: incoming tickets, architect decompositions, sub-tickets, follow-ups, CI fixes.
- \`--tags "initiative:<name>"\` — groups related tasks
- \`--tags "depends:mem_<id>"\` — blocks until dependency is done
- \`--category\` — retrieval command (MANDATORY). Examples: \`"neo runs <runId>"\` \u00b7 \`"cat ${notesDir}/plan-feature.md"\` \u00b7 \`"API-retrieve-a-page <notionPageId>"\`
Lifecycle: create \u2192 in_progress (on dispatch) \u2192 done | blocked | abandoned
</task-workflow>

<focus>
You are stateless between heartbeats. Focus is your scratchpad — the only thing future-you will read before acting.

Write it like a handoff note to yourself: what's happening, what you decided, what to do next, what to watch for. Free-form. No format imposed. The only rule: if you don't write it down, you lose it.

Rewrite focus at the END of every heartbeat. Never leave it empty after a heartbeat with activity.
</focus>

<notes>
Notes directory: \`${notesDir}/\`
Use notes for any initiative with 3+ tasks (persists across heartbeats).
- Write: \`cat > ${notesDir}/plan-<initiative>.md << 'EOF' ... EOF\`
- Link to tasks: \`--category "cat ${notesDir}/plan-<initiative>.md"\`
- Update after each task: check off milestones, add PR numbers, note blockers
- Delete when initiative is done
Use cases: architect decompositions, initiative tracking, debugging across heartbeats, review checklists.
</notes>`;
}

function buildMemoryRulesExamples(supervisorDir: string): string {
  const notesDir = `${supervisorDir}/notes`;
  return `<memory-examples>
neo memory write --type focus --expires 2h "ACTIVE: 5900a64a developer 'T1' branch:feat/x (cat ${notesDir}/plan-YC-2670-kanban.md)"
neo memory write --type fact --scope /repo "main branch uses protected merges — agents must create PRs, never push directly"
neo memory write --type fact --scope /repo "pnpm build must pass before push — CI does not rebuild, run 2g589f34a5a failed without it"
neo memory write --type procedure --scope /repo "After architect run: parse milestones from JSON output, create one task per milestone with --tags initiative:<name>"
neo memory write --type procedure --scope /repo "When developer run fails with ENOSPC: the repo has large fixtures — use --branch with shallow clone flag"
neo memory write --type feedback --scope /repo "User wants PR descriptions in French even though code is in English"
neo memory write --type task --scope /repo --severity high --category "neo runs 2g589f34a5a" --tags "initiative:auth-v2,depends:mem_xyz" "T1: Auth middleware"
neo memory update <id> --outcome in_progress|done|blocked|abandoned
neo memory forget <id>
</memory-examples>`;
}

// ─── Prompt assembly helpers ────────────────────────────
//
// Prompt structure follows Anthropic best practices:
//   <role>         — Identity only (2 sentences)
//   <context>      — Data top: focus → work state → knowledge → environment → events (query last)
//   <reference>    — Command documentation (stable reference data)
//   <instructions> — All behavioral rules bottom: principles → lifecycle → reporting → memory → directive

function buildRoleSection(heartbeatCount: number, label?: string): string {
  const suffix = label ? ` (${label})` : "";
  return `<role>\n${ROLE}\nHeartbeat #${heartbeatCount}${suffix}\n</role>`;
}

function getCommandsSection(heartbeatCount: number): string {
  return heartbeatCount <= 3 ? COMMANDS : COMMANDS_COMPACT;
}

function buildReferenceSection(heartbeatCount: number): string {
  return `<reference>\n${getCommandsSection(heartbeatCount)}\n</reference>`;
}

/**
 * Build the focus section from memory entries.
 * Rendered at the top of <context> — first thing the supervisor reads to re-orient.
 */
function buildFocusSection(memories: MemoryEntry[]): string {
  const focusEntries = memories.filter((m) => m.type === "focus");

  if (focusEntries.length > 0) {
    const lines = focusEntries.map((m) => `- ${m.content}`).join("\n");
    return `<focus>\n${lines}\n</focus>`;
  }

  return "<focus>\n(empty \u2014 use neo memory write --type focus to set working context)\n</focus>";
}

// ─── Decision sections ──────────────────────────────────

/**
 * Build the pending decisions section.
 * Shows decisions awaiting supervisor response with clear instructions.
 */
function buildPendingDecisionsSection(decisions: Decision[] | undefined): string {
  if (!decisions || decisions.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (const d of decisions) {
    const expiry = d.expiresAt ? ` (expires: ${d.expiresAt})` : "";
    const defaultHint = d.defaultAnswer ? ` [default: ${d.defaultAnswer}]` : "";
    lines.push(`- **${d.id}**: ${d.question}${expiry}${defaultHint}`);

    if (d.options && d.options.length > 0) {
      for (const opt of d.options) {
        const desc = opt.description ? ` — ${opt.description}` : "";
        lines.push(`    • \`${opt.key}\`: ${opt.label}${desc}`);
      }
    }

    if (d.context) {
      lines.push(`    Context: ${d.context}`);
    }
  }

  return `Pending decisions (${decisions.length}):
${lines.join("\n")}

To answer a decision, emit a \`decision:answer\` event:
\`\`\`bash
neo event emit decision:answer --data '{"id":"<decision_id>","answer":"<option_key>"}'
\`\`\``;
}

/**
 * Build the recent answered decisions section.
 * Provides context continuity by showing recently resolved decisions.
 */
function buildAnsweredDecisionsSection(decisions: Decision[] | undefined): string {
  if (!decisions || decisions.length === 0) {
    return "";
  }

  const lines = decisions.map((d) => {
    const answeredBy = d.source ? ` (by ${d.source})` : "";
    return `- ${d.id}: "${d.question}" → **${d.answer}**${answeredBy}`;
  });

  return `Recent decisions (${decisions.length}):\n${lines.join("\n")}`;
}

/**
 * Build the full context block shared by standard & consolidation prompts.
 * Order: focus (orientation) \u2192 work state \u2192 knowledge \u2192 environment \u2192 events (query last).
 * Compaction uses a subset via buildCompactionContext.
 */
function buildFullContext(opts: PromptOptions): string {
  const parts: string[] = [];

  // 1. Focus — orientation (first thing read after role)
  parts.push(buildFocusSection(opts.memories));

  // 2. Work state — what's happening right now
  const workQueue = buildWorkQueueSection(opts.memories);
  if (workQueue) {
    parts.push(workQueue);
  }

  if (opts.activeRuns.length > 0) {
    parts.push(`Active runs:\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  const recentActions = buildRecentActionsSection(opts.recentActions);
  if (recentActions) {
    parts.push(recentActions);
  }

  // 2b. Decisions — pending questions requiring supervisor response
  const pendingDecisions = buildPendingDecisionsSection(opts.pendingDecisions);
  if (pendingDecisions) {
    parts.push(pendingDecisions);
  }

  const answeredDecisions = buildAnsweredDecisionsSection(opts.answeredDecisions);
  if (answeredDecisions) {
    parts.push(answeredDecisions);
  }

  // 3. Knowledge — accumulated memory (facts, procedures, feedback)
  parts.push(buildKnowledgeSection(opts.memories));

  // 4. Environment — stable infra (repos, MCP, budget)
  parts.push(...buildEnvironmentSections(opts));

  // 5. Events — the "query" (last = highest attention per Anthropic guidelines)
  parts.push(`Events:\n${buildEventsSection(opts.grouped)}`);

  return `<context>\n${parts.join("\n\n")}\n</context>`;
}

/**
 * Build a lighter context for compaction heartbeats.
 * No active runs, no recent actions, no events — just memory for cleanup review.
 */
function buildCompactionContext(opts: PromptOptions): string {
  const parts: string[] = [];

  parts.push(buildFocusSection(opts.memories));
  parts.push(buildKnowledgeSection(opts.memories));

  const workQueue = buildWorkQueueSection(opts.memories);
  if (workQueue) {
    parts.push(workQueue);
  }

  parts.push(...buildEnvironmentSections(opts));

  return `<context>\n${parts.join("\n\n")}\n</context>`;
}

/**
 * Build the base instruction parts shared by all prompt variants.
 * Order: principles \u2192 lifecycle \u2192 reporting \u2192 memory \u2192 custom \u2192 (caller adds directive last)
 */
function buildBaseInstructions(
  opts: PromptOptions,
  options: { includeExamples: boolean },
): string[] {
  const parts: string[] = [];
  parts.push(OPERATING_PRINCIPLES);
  parts.push(HEARTBEAT_RULES);
  parts.push(REPORTING_RULES);
  parts.push(buildMemoryRulesCore(opts.supervisorDir));

  if (options.includeExamples) {
    parts.push(buildMemoryRulesExamples(opts.supervisorDir));
  }

  if (opts.customInstructions) {
    parts.push(`### Custom instructions\n${opts.customInstructions}`);
  }

  return parts;
}

function wrapInstructions(parts: string[]): string {
  return `<instructions>\n${parts.join("\n\n")}\n</instructions>`;
}

// ─── Context section builders ───────────────────────────

function buildEnvironmentSections(opts: PromptOptions): string[] {
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

/**
 * Build the knowledge section: facts, procedures, and feedback.
 * Focus is excluded — it's rendered separately at context top level.
 */
function buildKnowledgeSection(memories: MemoryEntry[]): string {
  const factEntries = memories.filter((m) => m.type === "fact");
  const procedureEntries = memories.filter((m) => m.type === "procedure");
  const feedbackEntries = memories.filter((m) => m.type === "feedback");

  const parts: string[] = [];

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
      return `Work queue (0 remaining, ${doneCount} done) \u2014 all tasks complete. Pick up new work or wait for events.`;
    }
    return "";
  }

  const groups = groupTasksByInitiative(tasks);
  const lines = renderTaskGroups(groups);

  if (tasks.length > MAX_TASKS) {
    lines.push(`  ... and ${tasks.length - MAX_TASKS} more pending`);
  }

  const header = `Work queue (${tasks.length} remaining, ${doneCount} done) \u2014 dispatch the next eligible task:`;
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

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function bySeverity(a: MemoryEntry, b: MemoryEntry): number {
  const aOrder = SEVERITY_ORDER[a.severity ?? "medium"] ?? 2;
  const bOrder = SEVERITY_ORDER[b.severity ?? "medium"] ?? 2;
  return aOrder - bOrder;
}

function partitionTasks(tasks: MemoryEntry[]): {
  active: MemoryEntry[];
  blocked: MemoryEntry[];
  pending: MemoryEntry[];
} {
  const active: MemoryEntry[] = [];
  const blocked: MemoryEntry[] = [];
  const pending: MemoryEntry[] = [];
  for (const t of tasks) {
    if (t.outcome === "in_progress") active.push(t);
    else if (t.outcome === "blocked") blocked.push(t);
    else pending.push(t);
  }
  return { active, blocked, pending };
}

function renderInitiativeSummary(group: TaskGroup): string {
  const { active, pending } = partitionTasks(group.tasks);
  const nextEligible = [...pending].sort(bySeverity)[0];
  const cat = nextEligible?.category ? ` -> ${nextEligible.category}` : "";
  const nextLabel = nextEligible
    ? ` (next: ${nextEligible.content.slice(0, 30)}${nextEligible.content.length > 30 ? "..." : ""} [${nextEligible.severity ?? "medium"}])`
    : "";
  return `[${group.initiative}] ${active.length} active, ${pending.length} pending${nextLabel}${cat}`;
}

function renderCompactInitiative(group: TaskGroup, lines: string[], rendered: number): number {
  lines.push(`  ${renderInitiativeSummary(group)}`);

  const { active, blocked, pending } = partitionTasks(group.tasks);
  const nextEligible = [...pending].sort(bySeverity)[0];

  for (const task of [...active, ...blocked]) {
    if (rendered >= MAX_TASKS) break;
    lines.push(`    ${formatTaskLine(task)}`);
    rendered++;
  }

  // Show next eligible pending if no active/blocked tasks
  if (nextEligible && active.length === 0 && blocked.length === 0 && rendered < MAX_TASKS) {
    lines.push(`    ${formatTaskLine(nextEligible)}`);
    rendered++;
  }

  return rendered;
}

function renderFlatGroup(
  group: TaskGroup,
  showHeader: boolean,
  lines: string[],
  rendered: number,
): number {
  if (showHeader && group.initiative) {
    lines.push(`  [${group.initiative}]`);
  }
  for (const task of group.tasks) {
    if (rendered >= MAX_TASKS) break;
    lines.push(`  ${formatTaskLine(task)}`);
    rendered++;
  }
  return rendered;
}

function renderTaskGroups(groups: TaskGroup[]): string[] {
  const lines: string[] = [];
  let rendered = 0;

  for (const group of groups) {
    if (rendered >= MAX_TASKS) break;

    const useCompactMode = group.initiative && group.tasks.length >= 3;
    if (useCompactMode) {
      rendered = renderCompactInitiative(group, lines, rendered);
    } else {
      const showHeader = group.initiative !== null && groups.length > 1;
      rendered = renderFlatGroup(group, showHeader, lines, rendered);
    }
  }

  return lines;
}

function formatTaskLine(task: MemoryEntry): string {
  const marker = formatTaskMarker(task.outcome);
  const severity = task.severity ? `[${task.severity}] ` : "";
  const scope = task.scope !== "global" ? ` (${getBasename(task.scope)})` : "";
  const run = task.runId ? ` [run ${task.runId.slice(0, 8)}]` : "";
  const cat = task.category ? ` \u2192 ${task.category}` : "";
  return `${marker} ${severity}${task.content}${scope}${run}${cat}`;
}

function formatTaskMarker(outcome: string | undefined): string {
  switch (outcome) {
    case "in_progress":
      return "[ACTIVE]";
    case "blocked":
      return "[BLOCKED]";
    default:
      return "\u25cb";
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

// ─── Event count helper ─────────────────────────────────

function countEvents(grouped: GroupedEvents): number {
  return grouped.messages.length + grouped.webhooks.length + grouped.runCompletions.length;
}

// ─── Idle prompt (minimal — no events, no runs, no tasks) ─

/**
 * Check if this heartbeat has nothing to do.
 */
export function isIdleHeartbeat(opts: PromptOptions): boolean {
  const hasWork = buildWorkQueueSection(opts.memories) !== "";
  return countEvents(opts.grouped) === 0 && opts.activeRuns.length === 0 && !hasWork;
}

/**
 * Build a minimal idle prompt (~50 tokens).
 * Used when there are no events, no active runs, and no pending tasks.
 */
export function buildIdlePrompt(opts: StandardPromptOptions): string {
  return `${buildRoleSection(opts.heartbeatCount)}

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
 *
 * Structure (Anthropic best practices: data top, instructions bottom):
 *   <role>         — Identity only
 *   <context>      — Focus \u2192 work state \u2192 knowledge \u2192 environment \u2192 events (query last)
 *   <reference>    — Command documentation
 *   <instructions> — Principles \u2192 lifecycle \u2192 reporting \u2192 memory \u2192 directive
 */
export function buildStandardPrompt(opts: StandardPromptOptions): string {
  const instructionParts = buildBaseInstructions(opts, { includeExamples: false });
  const hasEvents = countEvents(opts.grouped) > 0;

  instructionParts.push(
    hasEvents
      ? "Process events, dispatch eligible work, yield. Each heartbeat costs ~$0.10 \u2014 be efficient."
      : "No events. If pending work exists, dispatch it. Otherwise yield immediately.",
  );

  return [
    buildRoleSection(opts.heartbeatCount),
    buildFullContext(opts),
    buildReferenceSection(opts.heartbeatCount),
    wrapInstructions(instructionParts),
  ].join("\n\n");
}

// ─── Consolidation prompt ────────────────────────────────

/**
 * Build the consolidation heartbeat prompt (1 out of 5 heartbeats).
 */
export function buildConsolidationPrompt(opts: ConsolidationPromptOptions): string {
  const instructionParts = buildBaseInstructions(opts, { includeExamples: true });

  instructionParts.push(
    `### Consolidation
This is a CONSOLIDATION heartbeat.

**Idle guard**: if there are NO active runs AND no new events since last consolidation, log "idle, no changes" and yield immediately. Do NOT re-validate facts you already reviewed.

If there IS active work, your job:

1. **Review memory** \u2014 check facts and procedures for accuracy. Remove outdated entries. Resolve contradictions (keep newer). Remove facts about completed work (merged PRs, finished initiatives).
2. **Update focus** \u2014 rewrite focus using the MANDATORY structured format (ACTIVE/PENDING/WAITING/PROCESSED). Remove resolved items. Add new context.
3. **Pattern escalation** \u2014 if agents hit the same issue 3+ times (check recent actions), write a \`procedure\` to prevent recurrence.
4. **Prune completed work** \u2014 if a PR is merged or an initiative is done, forget related facts that are no longer actionable. Keep only reusable architectural truths.
5. **Prune done tasks** \u2014 forget tasks with outcome \`done\` or \`abandoned\` older than 7 days.`,
  );

  return [
    buildRoleSection(opts.heartbeatCount, "CONSOLIDATION"),
    buildFullContext(opts),
    buildReferenceSection(opts.heartbeatCount),
    wrapInstructions(instructionParts),
  ].join("\n\n");
}

// ─── Compaction prompt ──────────────────────────────────

/**
 * Build the compaction heartbeat prompt (every ~50 heartbeats).
 */
export function buildCompactionPrompt(opts: ConsolidationPromptOptions): string {
  const notesDir = `${opts.supervisorDir}/notes`;
  const instructionParts = buildBaseInstructions(opts, { includeExamples: true });

  instructionParts.push(`### Compaction
This is a COMPACTION heartbeat. Deep-clean your ENTIRE memory.

1. **Remove stale facts** \u2014 facts >7 days old with no recent reinforcement. Check the "(last accessed Xd ago)" hints in the facts section.
2. **Remove completed-work facts** \u2014 if all PRs for a repo initiative are merged/closed, forget related facts. Keep only reusable architectural truths (build system, CI config, tooling).
3. **Remove trivial facts** \u2014 file counts, line numbers, structural details that \`ls\` or \`cat package.json\` can answer. These waste context.
4. **Merge duplicates** \u2014 combine similar facts within the same scope into one.
5. **Clean up focus** \u2014 forget resolved items, rewrite remaining in structured format.
6. **Prune done tasks** \u2014 forget tasks with outcome \`done\` or \`abandoned\` older than 7 days.
7. **Delete completed notes** from \`${notesDir}/\` directory.
8. **Stay under 15 facts per scope** \u2014 prioritize facts that affect dispatch decisions.

Flag contradictions: if two facts contradict, keep the newer one.

\`\`\`bash
neo memory list --type fact
neo memory forget <stale-id>
\`\`\``);

  return [
    buildRoleSection(opts.heartbeatCount, "COMPACTION"),
    buildCompactionContext(opts),
    buildReferenceSection(opts.heartbeatCount),
    wrapInstructions(instructionParts),
  ].join("\n\n");
}
