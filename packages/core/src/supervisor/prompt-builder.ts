import type { RepoConfig } from "@/config";
import type { TaskEntry } from "@/supervisor/task-store";
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
  tasks: TaskEntry[];
  recentActions: ActivityEntry[];
  pendingDecisions?: Decision[] | undefined;
  answeredDecisions?: Decision[] | undefined;
  /** When true, supervisor answers decisions autonomously instead of waiting for human input */
  autoDecide?: boolean | undefined;
  /**
   * True when there are pending decisions regardless of autoDecide mode.
   * Used by buildIdlePrompt to block scout dispatch when the user has unanswered decisions.
   */
  hasPendingDecisions?: boolean | undefined;
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

- You are fully responsible for any unassigned queued task — ensure end-to-end delivery.
- Act as a decisive engineering lead: give clear context, dispatch deliberately, validate outcomes, and resolve blockers fast.
- On completion, always review \`neo runs <runId>\`: check if criteria are met, then choose to mark done, follow up, re-dispatch, or escalate.
- On run failure: identify the root cause (prompt quality, repo, conflict, known issue, environment/tooling) before retrying. Fix cause before proceeding.
- Proactively monitor for blocked or stalled work; never let issues persist silently.
- Output only via \`neo log\`. Prefer concise tool calls, not explanations. No wasted tokens.
- Launch agents read-only from repos via \`neo repos\`.
- Update every task outcome on every heartbeat; never leave status unknown.
- Never dispatch duplicate runs.
- For decisions: answer pending questions in 1–2 heartbeats. If strategic/scope/priority → answer directly. For code context, dispatch scout. Wait for human only if autoDecide is disabled or ambiguity remains. Blocking agents wastes budget.
- If human input is required (ambiguous scope, conflict, unknown repo, task failed ≥3×): use \`neo decision create "<question>" --options ... --expires-in 24h --context "<reason>"\`. Never proceed by guessing or remaining silent. Always ask if uncertain.
- Every \`neo run\` MUST have an \`in_progress\` task:
  1. Check for task: \`neo task list --status pending,in_progress\`
  2. If missing, create: \`neo task create --scope <repo> --priority <p> --initiative <name> "<description>"\`
  3. After dispatch, update: \`neo task update <id> --status in_progress --context "neo runs <runId>"\`
  Runs without tasks are not allowed.
- Always review agent outputs (\`neo runs <runId>\`) before follow-up, according to SUPERVISOR.md agent contracts.
- **Child supervisors**: for self-contained objectives requiring 3+ agent dispatches with intermediate decisions, use \`spawn_child_supervisor\` instead of direct dispatch. Every child MUST have a \`maxCostUsd\` cap and a corresponding task. React to child IPC events: \`progress\` → log, \`complete\` → verify evidence + mark done, \`blocked\` → answer or escalate, \`failed\` → re-spawn max 2×, then escalate.
`;

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

\`neo runs <runId>\` returns the agent's full output. **ALWAYS read it when a run completes** — it contains the agent's results that you need to decide next steps per SUPERVISOR.md routing rules.

### Memory
\`\`\`bash
neo memory write --type knowledge --subtype fact --scope /path "Stable fact about repo"
neo memory write --type knowledge --subtype procedure --scope /path "How to do X"
neo memory write --type warning --scope /path "Recurring issue to watch for"
neo memory write --type focus --expires 2h "Current working context"
neo task create --scope /path --priority high --context "neo runs <id>" "Task description"
neo task update <id> --status in_progress|done|blocked|abandoned
neo memory forget <id>
neo memory search "keyword"
neo memory list --type fact
\`\`\`

### Decisions
When you need human input on something that cannot be decided autonomously:
\`\`\`bash
neo decision create "<question>" --options "key1:label1,key2:label2:description" [--default <key>] [--expires-in 24h] [--context "..."]
neo decision list                    # show pending decisions
neo decision answer <id> <answer>    # answer a decision (usually done by human via TUI)
\`\`\`
The decision ID is returned by \`create\`. If no answer arrives before expiration, the \`--default\` answer is applied automatically (or the decision expires without resolution).

### Reporting
\`\`\`bash
neo log <type> "<message>"   # visible in TUI only
\`\`\``;

const COMMANDS_COMPACT = `### Commands (reference)
\`neo run <agent> --prompt "..." --repo <path> --branch <name> --meta '{"label":"T1-auth",...}'\`
\`neo runs [--short | <runId>]\` \u00b7 \`neo runs --short --status running\` \u00b7 \`neo cost --short\`
\`neo memory write|update|forget|search|list\` \u00b7 \`neo log <type> "<msg>"\`
\`neo config get <key>\` \u00b7 \`neo config set <key> <value> --global\` \u00b7 \`neo config list\`
\`neo decision create "<question>" --options "..." [--default <key>]\` \u00b7 \`neo decision list\``;

// ─── Instruction blocks ─────────────────────────────────

// ─── Child supervisor rules ──────────────────────────────
const CHILD_SUPERVISOR_RULES = `### Child supervisors

A child supervisor is a subordinate autonomous instance you can spawn for a **self-contained objective** that would otherwise require many sequential heartbeats and complex state-tracking. The child runs its own heartbeat loop and reports back via IPC events.

<when-to-spawn>
Spawn a child when ALL three conditions hold:
1. The work is **isolated** — no shared branches or PRs with other active initiatives.
2. It requires **3+ developer dispatches** with intermediate decisions (too complex to track in focus).
3. It has **clear acceptance criteria** you can express as a checklist.

Do NOT spawn a child for: simple one-agent tasks, work that shares a branch, or tasks where you need tight control over each step. Children cannot spawn children (depth limit = 1).
</when-to-spawn>

<spawn-tool>
\`\`\`json
{
  "name": "spawn_child_supervisor",
  "input": {
    "objective": "Implement the CSV export feature per .neo/specs/csv-export.md",
    "acceptanceCriteria": [
      "PR is open and CI passes",
      "Reviewer approved with no CRITICAL issues",
      ".neo/specs/csv-export.md acceptance criteria are met"
    ],
    "maxCostUsd": 5.00
  }
}
\`\`\`
Always set \`maxCostUsd\` — budget-uncapped children are a safety risk.
After spawning: create a task, mark it \`in_progress\`, log the supervisorId.
</spawn-tool>

<child-event-contracts>
React to each IPC message type:

| type | Meaning | Your action |
|------|---------|-------------|
| \`progress\` | Child is alive and working | Log summary, update task outcome with latest summary. No dispatch needed. |
| \`complete\` | All acceptance criteria met | Read \`evidence[]\` to verify. Mark task \`done\`. If a PR was created, dispatch \`reviewer\`. |
| \`blocked\` | Child needs a decision | Read \`question\` + \`urgency\`. If you can answer → \`neo decision answer\` or send \`inject\` with context. Urgency \`high\` = answer within 1 heartbeat. |
| \`failed\` | Child crashed or hit max retries | Read \`error\`. If recoverable → re-spawn with same criteria. On 3rd failure → mark task \`blocked\`, create a decision for human. |
| \`session\` | Child started a new SDK session | Note sessionId for debugging. No action needed. |

After \`complete\`: always verify \`evidence[]\` — a child may self-report completion without fully meeting criteria.
After \`failed\` 2× on the same child: do NOT re-spawn automatically. Create a \`blocked\` task and escalate.
</child-event-contracts>

<child-budget-guard>
- Always set \`maxCostUsd\` — a child without a budget cap is a runaway risk.
- Factor child cost into your \`neo cost --short\` check before spawning.
- If a child hits its cap it will \`failed\` with "budget exceeded". Evaluate whether to re-spawn with a higher cap or restructure as direct agent dispatches.
</child-budget-guard>`;

const HEARTBEAT_RULES = `### Heartbeat lifecycle

<decision-tree>
1. DEDUP FIRST — check focus for PROCESSED entries. Skip any runId already processed.
2. MONITOR RUNS — \`neo runs --short\` to check active run status. If a run completed since last HB, read its output with \`neo runs <runId>\` BEFORE doing anything else.
3. PENDING TASKS? — dispatch the next eligible task from work queue. Do not re-plan.
4. EVENTS? — process run completions, messages, webhooks. Read agent output and route per SUPERVISOR.md contracts.
5. CI AUDIT — for every open PR across all repos, run:
   \`gh pr list --repo <repo> --json number,headRefName,title,statusCheckRollup --state open\`
   Then for each PR:
   - CI **failed** + no active developer run on that branch → re-dispatch developer with CI error context
   - CI **passed** + no active reviewer run + no reviewer dispatched this cycle → dispatch reviewer
   - CI **pending** → log and skip (check next heartbeat)
   - PR has \`CHANGES_REQUESTED\` verdict + no active developer run → re-dispatch developer with review feedback (check anti-loop guard first)
   Never leave a PR orphaned: every open PR must have either an active run or a clear status.
5b. DECISIONS — check \`neo decision list\` for pending decisions. **Prioritize above dispatch.** Agents are BLOCKED waiting — stale decisions waste budget. Route each: answer directly if scope/strategy, dispatch scout if needs codebase context, escalate to human if genuinely uncertain.
6. DISPATCH — route work to agents. Mark tasks \`in_progress\`, add ACTIVE to focus.
7. UPDATE TASKS — review ALL in_progress/blocked tasks. For each: confirm status matches reality (run still active? PR merged? blocked resolved?). Update outcomes immediately — do not defer to next heartbeat.
8. SERIALIZE & YIELD — rewrite focus (see <focus>), log your decisions, and yield. Do not poll.
</decision-tree>

<run-monitoring>
Runs are your agents in the field. You MUST actively track them:
- **On dispatch**: include a label in \`--meta\` for identification: \`--meta '{"label":"T6-csv-export","ticketId":"YC-42",...}'\`
- **On completion**: ALWAYS run \`neo runs <runId>\` to read the full output. This is NOT optional — you cannot decide next steps without reading the output.
- **On failure**: read the output to understand why. Decide: retry (blocked), abandon, or escalate.
- **Active runs**: check \`neo runs --short --status running\` to verify your runs are still alive. If a run disappeared, investigate.
</run-monitoring>

<multi-task-initiatives>
**Branch strategy:** one branch per initiative. Architect produces a plan; developer executes all tasks on that branch. Independent initiatives CAN run in parallel on different branches.

**Dispatch quality:** when dispatching developer with a plan, include the plan path and any context from completed prior work (PR numbers, APIs added). For direct tasks (no plan), write a detailed \`--prompt\` with acceptance criteria.

**Post-completion:** if agent opened a PR, dispatch \`reviewer\` in parallel with CI (do not wait). Update task outcome with concrete details (PR#, what was done) and update the initiative note.

**Task tracking discipline:**
- On dispatch: \`neo memory update <id> --outcome in_progress\` immediately — never dispatch without updating the task.
- On run completion: update to \`done\` with details OR \`blocked\` with reason. Do this in the SAME heartbeat you read the run output.
- On run failure: update to \`blocked\` with root cause. Never leave a failed run's task as \`in_progress\`.
- Every heartbeat: cross-check active tasks against \`neo runs --short\`. If a run finished but the task is still \`in_progress\`, something was missed — fix it now.

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

function buildMemoryRulesCore(): string {
  return `### Memory

<memory-types>
| Type | Subtype | Store when | TTL |
|------|---------|-----------|-----|
| \`knowledge\` | \`fact\` | Stable truth affecting dispatch decisions | Permanent (decays) |
| \`knowledge\` | \`procedure\` | Same failure 3+ times | Permanent |
| \`warning\` | — | Same review complaint 3+ times | Permanent |
| \`focus\` | — | After every dispatch/deferral | --expires required |
</memory-types>

<tasks>
Tasks are managed separately via \`neo task\` commands:
\`\`\`bash
neo task create --scope /path --priority high --context "neo runs <id>" "Task description"
neo task update <id> --status in_progress|done|blocked|abandoned
neo task list [--initiative <name>] [--status pending,in_progress]
\`\`\`
</tasks>

<memory-rules>
- Focus is free-form working memory — rewrite at end of EVERY heartbeat (see <focus>).
- NEVER store: file counts, line numbers, completed work details, data available via \`neo runs <id>\`.
- After PR merge: forget related facts unless they are reusable architectural truths.
- Pattern escalation: same failure 3+ times → write a \`procedure\` (knowledge subtype).
- Every memory that references external context MUST include a retrieval command in the content. You are stateless — if you can't retrieve it later, don't store it.
</memory-rules>

<task-workflow>
Tasks are separate from memory. Use \`neo task\` commands:
- \`neo task create --scope /path --priority high --initiative <name> "Description"\`
- \`neo task update <id> --status in_progress|done|blocked|abandoned\`

Queue markers: ○ pending · [ACTIVE] in_progress · [BLOCKED] blocked.
Create tasks for: incoming tickets, architect decompositions, sub-tickets, follow-ups, CI fixes.
- \`--initiative <name>\` — groups related tasks
- \`--depends <task_id>\` — blocks until dependency is done
- \`--context\` — retrieval command (MANDATORY). Example: \`"neo runs <runId>"\`

**Update frequency:** task status MUST be updated in the same heartbeat as the triggering event. Never defer to "next heartbeat" — by then you will have forgotten.

**Mandatory cross-check:** before yielding, verify that:
1. Every dispatched run has a corresponding \`in_progress\` task
2. Every completed run has a corresponding \`done\` or \`blocked\` task
3. No task is \`in_progress\` without an active run (unless manually worked)
</task-workflow>

<focus>
You are stateless between heartbeats. Focus is your scratchpad — the only thing future-you will read before acting.

Write it like a handoff note to yourself: what's happening, what you decided, what to do next, what to watch for. Free-form. No format imposed. The only rule: if you don't write it down, you lose it.

Rewrite focus at the END of every heartbeat. Never leave it empty after a heartbeat with activity.
</focus>`;
}

function buildMemoryRulesExamples(): string {
  return `<memory-examples>
neo memory write --type focus --expires 2h "ACTIVE: 5900a64a developer 'T1' branch:feat/x | T2 pending, waiting on CI"
neo memory write --type knowledge --subtype fact --scope /repo "main branch uses protected merges — agents must create PRs, never push directly"
neo memory write --type knowledge --subtype fact --scope /repo "pnpm build must pass before push — CI does not rebuild, run 2g589f34a5a failed without it"
neo memory write --type knowledge --subtype procedure --scope /repo "After architect run: read plan path from output, dispatch developer with plan per SUPERVISOR.md routing"
neo memory write --type knowledge --subtype procedure --scope /repo "When developer run fails with ENOSPC: the repo has large fixtures — use --branch with shallow clone flag"
neo memory write --type warning --scope /repo "User wants PR descriptions in French even though code is in English"
neo task create --scope /repo --priority high --context "neo runs 2g589f34a5a" --initiative auth-v2 --depends mem_xyz "T1: Auth middleware"
neo task update <id> --status in_progress|done|blocked|abandoned
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
 * Shows decisions awaiting supervisor response with autoDecide instructions.
 * Only rendered in autoDecide mode (decisions are empty otherwise).
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

  const instruction = `You are in **autoDecide** mode — answer each pending decision yourself based on available context, project knowledge, and best engineering judgment.

\`\`\`bash
neo decision answer <decision_id> <answer>
\`\`\`

For each decision: analyze the options, consider the project context and risk, then answer decisively. Prefer safe, incremental choices when uncertain. Log your reasoning before answering.

**Merge authority:** In autoDecide mode you MAY merge branches when the PR is ready (CI green, reviews approved). Use \`gh pr merge\` with the appropriate merge strategy.`;

  return `Pending decisions (${decisions.length}):
${lines.join("\n")}

${instruction}`;
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
  const workQueue = buildWorkQueueSection(opts.tasks);
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

  const workQueue = buildWorkQueueSection(opts.tasks);
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
  parts.push(CHILD_SUPERVISOR_RULES);
  parts.push(HEARTBEAT_RULES);
  parts.push(REPORTING_RULES);
  parts.push(buildMemoryRulesCore());

  if (options.includeExamples) {
    parts.push(buildMemoryRulesExamples());
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
 * Build the knowledge section: facts, procedures (from knowledge type), and warnings.
 * Focus is excluded — it's rendered separately at context top level.
 */
function buildKnowledgeSection(memories: MemoryEntry[]): string {
  const knowledgeEntries = memories.filter((m) => m.type === "knowledge");
  const warningEntries = memories.filter((m) => m.type === "warning");

  const factEntries = knowledgeEntries.filter((m) => m.subtype === "fact" || !m.subtype);
  const procedureEntries = knowledgeEntries.filter((m) => m.subtype === "procedure");

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

  // Warnings (replaces feedback)
  if (warningEntries.length > 0) {
    const lines = warningEntries
      .map((m) => `- [${m.category ?? "general"}] ${m.content}`)
      .join("\n");
    parts.push(`Recurring review issues:\n${lines}`);
  }

  return parts.join("\n\n");
}

// ─── Work queue (tasks) ─────────────────────────────────

const DONE_STATUSES = new Set(["done", "abandoned"]);
const MAX_TASKS = 15;

interface TaskGroup {
  initiative: string | null;
  tasks: TaskEntry[];
}

export function buildWorkQueueSection(tasks: TaskEntry[]): string {
  const activeTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status));
  const doneCount = tasks.filter((t) => DONE_STATUSES.has(t.status)).length;

  if (activeTasks.length === 0) {
    if (doneCount > 0) {
      return `Work queue (0 remaining, ${doneCount} done) \u2014 all tasks complete. Pick up new work or wait for events.`;
    }
    return "";
  }

  const groups = groupTasksByInitiative(activeTasks);
  const lines = renderTaskGroups(groups);

  if (activeTasks.length > MAX_TASKS) {
    lines.push(`  ... and ${activeTasks.length - MAX_TASKS} more pending`);
  }

  const header = `Work queue (${activeTasks.length} remaining, ${doneCount} done) \u2014 dispatch the next eligible task:`;
  return `${header}\n${lines.join("\n")}`;
}

function groupTasksByInitiative(tasks: TaskEntry[]): TaskGroup[] {
  const initiativeMap = new Map<string, TaskEntry[]>();
  const noInitiative: TaskEntry[] = [];

  for (const task of tasks) {
    if (task.initiative) {
      const group = initiativeMap.get(task.initiative) ?? [];
      group.push(task);
      initiativeMap.set(task.initiative, group);
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

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function byPriority(a: TaskEntry, b: TaskEntry): number {
  const aOrder = PRIORITY_ORDER[a.priority ?? "medium"] ?? 2;
  const bOrder = PRIORITY_ORDER[b.priority ?? "medium"] ?? 2;
  return aOrder - bOrder;
}

function partitionTasks(tasks: TaskEntry[]): {
  active: TaskEntry[];
  blocked: TaskEntry[];
  pending: TaskEntry[];
} {
  const active: TaskEntry[] = [];
  const blocked: TaskEntry[] = [];
  const pending: TaskEntry[] = [];
  for (const t of tasks) {
    if (t.status === "in_progress") active.push(t);
    else if (t.status === "blocked") blocked.push(t);
    else pending.push(t);
  }
  return { active, blocked, pending };
}

function renderInitiativeSummary(group: TaskGroup): string {
  const { active, pending } = partitionTasks(group.tasks);
  const nextEligible = [...pending].sort(byPriority)[0];
  const ctx = nextEligible?.context ? ` -> ${nextEligible.context}` : "";
  const nextLabel = nextEligible
    ? ` (next: ${nextEligible.title.slice(0, 30)}${nextEligible.title.length > 30 ? "..." : ""} [${nextEligible.priority ?? "medium"}])`
    : "";
  return `[${group.initiative}] ${active.length} active, ${pending.length} pending${nextLabel}${ctx}`;
}

function renderCompactInitiative(group: TaskGroup, lines: string[], rendered: number): number {
  lines.push(`  ${renderInitiativeSummary(group)}`);

  const { active, blocked, pending } = partitionTasks(group.tasks);
  const nextEligible = [...pending].sort(byPriority)[0];

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

function formatTaskLine(task: TaskEntry): string {
  const marker = formatTaskMarker(task.status);
  const priority = task.priority ? `[${task.priority}] ` : "";
  const scope = task.scope !== "global" ? ` (${getBasename(task.scope)})` : "";
  const run = task.runId ? ` [run ${task.runId.slice(0, 8)}]` : "";
  const ctx = task.context ? ` \u2192 ${task.context}` : "";
  return `${marker} ${priority}${task.title}${scope}${run}${ctx}`;
}

function formatTaskMarker(status: string): string {
  switch (status) {
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
    case "child_supervisor": {
      const msg = event.message;
      switch (msg.type) {
        case "progress":
          return `Child [${msg.supervisorId}] progress: ${msg.summary}`;
        case "complete":
          return `Child [${msg.supervisorId}] COMPLETE: ${msg.summary}\nEvidence:\n${msg.evidence.map((e) => `  - ${e}`).join("\n")}`;
        case "blocked":
          return `Child [${msg.supervisorId}] BLOCKED [${msg.urgency}]: ${msg.reason}\nQuestion: ${msg.question}`;
        case "failed":
          return `Child [${msg.supervisorId}] FAILED: ${msg.error}`;
        case "session":
          return `Child [${msg.supervisorId}] session started: ${msg.sessionId}`;
      }
    }
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
  const hasWork = buildWorkQueueSection(opts.tasks) !== "";
  return countEvents(opts.grouped) === 0 && opts.activeRuns.length === 0 && !hasWork;
}

/**
 * Build the idle prompt.
 * Used when there are no events, no active runs, and no pending tasks.
 * If there are pending decisions, surfaces them. Otherwise, yields.
 */
export function buildIdlePrompt(opts: StandardPromptOptions): string {
  const budgetLine = `Budget: $${opts.budgetStatus.todayUsd.toFixed(2)} / $${opts.budgetStatus.capUsd.toFixed(2)} (${opts.budgetStatus.remainingPct.toFixed(0)}% remaining)`;
  const hasRepos = opts.repos.length > 0;
  const hasBudget = opts.budgetStatus.remainingPct > 10;
  // Use hasPendingDecisions (always reflects reality) rather than pendingDecisions.length
  // (which is empty in non-autoDecide mode even when decisions exist).
  const hasPendingDecisions = opts.hasPendingDecisions ?? (opts.pendingDecisions?.length ?? 0) > 0;

  // If no repos or no budget, just yield
  if (!hasRepos || !hasBudget) {
    return `${buildRoleSection(opts.heartbeatCount)}

<context>
No events. No active runs. No pending tasks.
${budgetLine}
</context>

<directive>
Nothing to do. Run \`neo log discovery "idle"\` and yield. Do not produce any other output.
</directive>`;
  }

  const repoList = opts.repos.map((r) => `- ${r.path} (branch: ${r.defaultBranch})`).join("\n");

  // If there are pending decisions from a previous scout
  if (hasPendingDecisions) {
    const pendingSection = buildPendingDecisionsSection(opts.pendingDecisions);

    // In autoDecide mode, supervisor should answer decisions instead of waiting
    if (opts.autoDecide) {
      return `${buildRoleSection(opts.heartbeatCount)}

<context>
No events. No active runs. No pending tasks.
${budgetLine}

${pendingSection}

Repositories:
${repoList}
</context>

<reference>
${getCommandsSection(opts.heartbeatCount)}
</reference>

<directive>
Idle — but there are pending decisions to resolve. You are in **autoDecide** mode: answer each pending decision now using your best engineering judgment, then yield. You MAY merge branches when PRs are ready (CI green, reviews approved).
</directive>`;
    }

    return `${buildRoleSection(opts.heartbeatCount)}

<context>
No events. No active runs. No pending tasks.
${budgetLine}

${pendingSection}

Repositories:
${repoList}
</context>

<directive>
Idle — but there are pending decisions awaiting user response.
Run \`neo log discovery "idle — waiting on ${String(opts.pendingDecisions?.length ?? 0)} pending decision(s)"\` and yield.
</directive>`;
  }

  return `${buildRoleSection(opts.heartbeatCount)}

<context>
No events. No active runs. No pending tasks.
${budgetLine}

Repositories:
${repoList}
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
  const instructionParts = buildBaseInstructions(opts, { includeExamples: true });

  instructionParts.push(`### Compaction
This is a COMPACTION heartbeat. Deep-clean your ENTIRE memory.

1. **Remove stale facts** \u2014 facts >7 days old with no recent reinforcement. Check the "(last accessed Xd ago)" hints in the facts section.
2. **Remove completed-work facts** \u2014 if all PRs for a repo initiative are merged/closed, forget related facts. Keep only reusable architectural truths (build system, CI config, tooling).
3. **Remove trivial facts** \u2014 file counts, line numbers, structural details that \`ls\` or \`cat package.json\` can answer. These waste context.
4. **Merge duplicates** \u2014 combine similar facts within the same scope into one.
5. **Clean up focus** \u2014 forget resolved items, rewrite remaining in structured format.
6. **Prune done tasks** \u2014 forget tasks with outcome \`done\` or \`abandoned\` older than 7 days.
7. **Stay under 15 facts per scope** \u2014 prioritize facts that affect dispatch decisions.

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
