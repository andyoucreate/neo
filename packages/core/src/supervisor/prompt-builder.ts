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

// ─── Role (concise identity + mindset) ──────────────────

const ROLE = `You are the neo autonomous supervisor. You orchestrate developer agents across repositories. You make decisions autonomously, act on events, and yield quickly.`;

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
| \`--priority\` | no | \`critical\`, \`high\`, \`medium\`, \`low\` |
| \`--meta\` | recommended | JSON metadata for traceability and deduplication |

All agents require \`--branch\`. Each agent session runs in an isolated clone on that branch.

### Monitoring & reading agent output
\`\`\`bash
neo runs --short [--all]     # check recent runs
neo runs <runId>             # full run details + agent output
neo cost --short [--all]     # check budget
neo agents                   # list available agents
\`\`\`

\`neo runs <runId>\` returns the agent's full output. Always read it after \`architect\` or \`refiner\` runs — their output contains the plan or decomposition you need to act on next.

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
1. **Check work queue FIRST** — if you have pending tasks, work on the next one before looking for new work
2. Process incoming events (messages, run completions)
3. Follow up on pending work (CI checks, deferred dispatches) with \`neo runs\` or \`gh pr checks\`
4. Make decisions and dispatch agents
5. Update task status (\`neo memory update <id> --outcome in_progress|done|blocked\`) and log decisions
6. Yield — each heartbeat should take seconds, not minutes

**CRITICAL**: Your work queue IS your plan. Do not re-plan work that is already in the queue. When an planner agent produces tasks, create them with \`neo memory write --type task\`, then dispatch independent tasks in the same heartbeat. Maximize parallelism within concurrency limits.

After dispatching, mark tasks \`in_progress\`, note runIds in your focus, and yield. Do NOT poll in a loop.
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
| \`fact\` | Stable truth that affects decisions | After discovering something that changes how you dispatch or review | Permanent (decays if unused) |
| \`procedure\` | How-to recipe learned from failure | After the same issue occurs 3+ times | Permanent (decays if unused) |
| \`focus\` | Structured working context | After every dispatch, deferral, or priority change | Expires (always set --expires) |
| \`feedback\` | Recurring review pattern | After seeing the same reviewer complaint 3+ times | Permanent |
| \`episode\` | Run outcome | Auto-created on run completion — do NOT write manually | Permanent |
| \`task\` | Planned work item | After architect output or decomposition | Until done/abandoned |

#### What to store
- Architectural truths that affect future dispatch decisions (CI config, build requirements, tooling)
- Procedures learned from repeated failures (3+ occurrences of the same issue)
- Active working context in structured focus format (see below)

#### What NOT to store
- File counts, line numbers, or structural details derivable from code (\`ls\` or \`cat package.json\` can answer it)
- Completed work details — once a PR is merged, forget the related facts unless they are reusable
- Agent output details already available via \`neo runs <id>\`
- Facts about repos where no work is currently planned

#### Focus format (MANDATORY)
Focus entries MUST use this structured format — no free-form paragraphs:
\`\`\`
ACTIVE: <runId> <agent> "<task>" branch:<name>
PENDING: <taskId> "<description>" depends:<taskId>
WAITING: <what> since:HB<N>
PROCESSED: <runId> → <outcome> PR#<N>
\`\`\`

\`\`\`bash
# Focus: structured working context (always set --expires)
neo memory write --type focus --expires 2h "ACTIVE: 5900a64a developer 'T1: schema+store' branch:feat/task-queue
PENDING: T2 'CLI --outcome flag' depends:T1
PENDING: T3+T4 'prompt injection' depends:T1"

# Facts: truths that change how you work (NOT trivia)
neo memory write --type fact --scope /path/to/repo "CI requires pnpm build before push — no auto-rebuild in pipeline"
neo memory write --type fact --scope /path/to/repo "Biome enforces complexity max 20 — extract helpers for large functions"

# Procedures: recipes learned from failure (write after 3+ occurrences)
neo memory write --type procedure --scope /path/to/repo "Before re-dispatching after orphan failure, check if PR already merged with gh pr view"
neo memory write --type procedure --scope /path/to/repo "Integration tests require DATABASE_URL env var — agent must set it"

# Feedback: recurring reviewer complaints
neo memory write --type feedback --scope /path/to/repo --category input_validation "Always validate user input at controller boundaries"

# Tasks: work queue items from architect/refiner output
neo memory write --type task --scope /path/to/repo --severity high --category "neo runs abc123" "T1: Implement auth middleware"
neo memory write --type task --scope /path/to/repo --severity medium --tags "initiative:auth-v2,depends:mem_abc" --category "cat notes/plan-auth.md" "T2: Add JWT validation"

# Update task status as you work
neo memory update <id> --outcome in_progress
neo memory update <id> --outcome done
neo memory update <id> --outcome blocked
neo memory update <id> --outcome abandoned

# Forget stale entries
neo memory forget <id>

# Search across all memories (semantic)
neo memory search "database setup"
\`\`\`

#### Work queue workflow (Tasks)
After architect/refiner output, create tasks with \`neo memory write --type task\`:
- Include \`--category\` with the command to retrieve context (\`neo runs <id>\` or \`cat notes/<file>\`)
- Use \`--tags depends:mem_<id>\` for task dependencies
- Use \`--tags initiative:<name>\` to group tasks across repos
- Update status with \`neo memory update <id> --outcome in_progress|done|blocked|abandoned\`
- The queue is shown at every heartbeat — you will not lose track

#### Pattern escalation
When you encounter the same failure or issue 3+ times, ALWAYS write a \`procedure\` memory so you handle it automatically next time. Do not re-discover the same problem repeatedly.

#### Event deduplication
After processing a run completion, record the runId as PROCESSED in your focus. If the same runId appears in future events, skip it — do not re-analyze.

**Notes** (\`notes/\`, via Bash): use for detailed multi-page plans, analysis, and checklists that span multiple heartbeats. After creating or reading a plan, write a focus summary: "Plan: <name> | Tasks: T1-T5 | Current: T1 | Next: T2 (depends T1) | Ref: cat notes/<file>". Delete notes when done.`;

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

  // Notes reminder
  parts.push(`For detailed plans and checklists, use notes:
\`\`\`bash
cat > ${supervisorDir}/notes/plan-feature.md << 'EOF'
<your detailed plan here>
EOF
\`\`\``);

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

const SIGNIFICANT_TYPES = new Set(["decision", "action", "dispatch", "error", "plan"]);

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

  // Context — work queue first so it's the primary driver
  const contextParts: string[] = [];

  const workQueue = buildWorkQueueSection(opts.memories);

  if (workQueue) {
    contextParts.push(workQueue);
  }

  if (opts.activeRuns.length > 0) {
    contextParts.push(`Active runs:\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  contextParts.push(...buildContextSections(opts));
  contextParts.push(buildMemorySection(opts.memories, opts.supervisorDir));

  const recentActions = buildRecentActionsSection(opts.recentActions);
  if (recentActions) {
    contextParts.push(recentActions);
  }

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
    "This is a standard heartbeat. Focus on processing events and dispatching work. If you have tasks in your work queue, dispatch the next eligible one.",
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

  // Context — work queue first so it's the primary driver
  const contextParts: string[] = [];

  const workQueueConsolidation = buildWorkQueueSection(opts.memories);
  if (workQueueConsolidation) {
    contextParts.push(workQueueConsolidation);
  }

  if (opts.activeRuns.length > 0) {
    contextParts.push(`Active runs:\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  contextParts.push(...buildContextSections(opts));
  contextParts.push(buildMemorySection(opts.memories, opts.supervisorDir));

  const recentActions = buildRecentActionsSection(opts.recentActions);
  if (recentActions) {
    contextParts.push(recentActions);
  }

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
This is a CONSOLIDATION heartbeat.

**Idle guard**: if there are NO active runs AND no new events since last consolidation, log "idle, no changes" and yield immediately. Do NOT re-validate facts you already reviewed.

If there IS active work, your job:

1. **Review memory** — check facts and procedures for accuracy. Remove outdated entries. Resolve contradictions (keep newer). Remove facts about completed work (merged PRs, finished initiatives).
2. **Update focus** — rewrite focus using the MANDATORY structured format (ACTIVE/PENDING/WAITING/PROCESSED). Remove resolved items. Add new context.
3. **Pattern escalation** — if agents hit the same issue 3+ times (check recent actions), write a \`procedure\` to prevent recurrence.
4. **Prune completed work** — if a PR is merged or an initiative is done, forget related facts that are no longer actionable. Keep only reusable architectural truths.

\`\`\`bash
neo memory write --type procedure --scope /repo "Before re-dispatching after orphan, check gh pr view first"
neo memory write --type focus --expires 4h "ACTIVE: abc123 developer 'T3: prompt injection' branch:feat/task-queue
PROCESSED: 5900a64a → PR#70 APPROVED"
neo memory forget <stale-id>
\`\`\``,
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

  const workQueueCompaction = buildWorkQueueSection(opts.memories);
  if (workQueueCompaction) {
    contextParts.push(workQueueCompaction);
  }

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
This is a COMPACTION heartbeat. Deep-clean your ENTIRE memory.

1. **Remove stale facts** — facts >7 days old with no recent reinforcement. Check the "(last accessed Xd ago)" hints in the facts section.
2. **Remove completed-work facts** — if all PRs for a repo initiative are merged/closed, forget related facts. Keep only reusable architectural truths (build system, CI config, tooling).
3. **Remove trivial facts** — file counts, line numbers, structural details that \`ls\` or \`cat package.json\` can answer. These waste context.
4. **Merge duplicates** — combine similar facts within the same scope into one.
5. **Clean up focus** — forget resolved items, rewrite remaining in structured format.
6. **Delete completed notes** from notes/ directory.
7. **Stay under 15 facts per scope** — prioritize facts that affect dispatch decisions.

Flag contradictions: if two facts contradict, keep the newer one.

\`\`\`bash
neo memory list --type fact
neo memory forget <stale-id>
\`\`\``);

  sections.push(`<instructions>\n${instructionParts.join("\n\n")}\n</instructions>`);

  return sections.join("\n\n");
}
