import type { RepoConfig } from "@/config";
import type { GroupedEvents } from "./event-queue.js";
import { buildAgentDigest, computeHotState } from "./log-buffer.js";
import type { SupervisorMemory } from "./memory.js";
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
}

export interface StandardPromptOptions extends PromptOptions {
  memory: SupervisorMemory;
  recentEntries: LogBufferEntry[];
}

export interface ConsolidationPromptOptions extends PromptOptions {
  memory: SupervisorMemory;
  memoryJson: string;
  knowledgeMd: string;
  allUnconsolidatedEntries: LogBufferEntry[];
}

/** @deprecated Use buildStandardPrompt or buildConsolidationPrompt instead. */
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

// ─── Role & Commands (shared between both modes) ────────

const ROLE_STANDARD = `You are the neo autonomous supervisor.
You orchestrate developer agents across repositories. You make decisions autonomously.

Your job at each heartbeat:
1. Process incoming events (messages, run completions)
2. If your state has pending work (CI checks, deferred dispatches), follow up with \`neo runs\` or \`gh pr checks\`
3. Make decisions and dispatch agents
4. Log decisions with \`neo log\`
5. **Yield.** Each heartbeat should take seconds, not minutes.

CRITICAL RULES:
- After dispatching with \`neo run\`, note the runId and yield. Do NOT poll in a loop.
- Completion events arrive as webhooks at future heartbeats — react then.
- But if you deferred work (e.g. "CI pending, check later"), you MUST check it at the next heartbeat using \`neo runs <id>\` or \`gh pr checks\`.`;

const COMMANDS = `## Commands

### Dispatching agents
\`\`\`bash
neo run <agent> --prompt "..." --repo <path> [--branch <name>] [--priority critical|high|medium|low] [--meta '<json>']
\`\`\`

**Flags:**
| Flag | Required | Description |
|------|----------|-------------|
| \`--prompt\` | always | Task description for the agent |
| \`--repo\` | always | Target repository path |
| \`--branch\` | writable agents | Branch name for the isolated clone |
| \`--priority\` | no | \`critical\`, \`high\`, \`medium\`, \`low\` |
| \`--meta\` | recommended | JSON metadata for traceability and deduplication |

**Clone isolation & \`--branch\`:**
neo runs each agent in an isolated git clone (\`git clone --local\`). The \`--branch\` flag controls this:
- **Writable agents** (developer, fixer): \`--branch\` is **required**. neo creates a clone and checks out \`<branch>\`.
- **Read-only agents** (architect, reviewer, refiner): \`--branch\` is **not needed**.

### Other commands
\`\`\`bash
neo runs --short [--all]     # check recent runs
neo runs <runId>             # full run details
neo cost --short [--all]     # check budget
neo agents                   # list available agents
neo log <type> "<message>"   # log a progress report
\`\`\``;

const REPORTING = `## Reporting

\`neo log\` is your ONLY visible output — the TUI shows these and nothing else. Be synthetic but information-dense.
- \`neo log decision "..."\` — why you chose this route
- \`neo log action "..."\` — what you dispatched/did
- \`neo log discovery --knowledge "..."\` — reference facts to persist
- \`neo log discovery --memory "..."\` — observations about active work
- 1-3 sentences per log. Pack maximum info: ticket, agent, branch, runId, cost, PR#. No markdown.

Your text output is NEVER shown to users. Do not write summaries, tables, or reports outside of \`neo log\`.`;

// ─── Hot state rendering ────────────────────────────────

/**
 * Render the hot state (activeWork + blockers) as a formatted string.
 * Merges memory state with pending log buffer entries.
 */
export function renderHotState(
  memory: SupervisorMemory,
  pendingEntries: LogBufferEntry[],
  now: Date = new Date(),
): string {
  const hotState = computeHotState(memory, pendingEntries);
  const lines: string[] = [];

  renderActiveWork(lines, memory, hotState.activeWork, now);
  renderBlockers(lines, memory, hotState.blockers, now);

  return lines.length > 0 ? lines.join("\n") : "No active work or blockers.";
}

function renderActiveWork(
  lines: string[],
  memory: SupervisorMemory,
  hotWorkDescs: string[],
  now: Date,
): void {
  if (hotWorkDescs.length === 0 && memory.activeWork.length === 0) return;

  lines.push("activeWork:");
  for (const item of memory.activeWork) {
    lines.push(formatWorkItem(item, now));
  }
  // Add pending entries not already covered by memory
  const memoryDescs = new Set(memory.activeWork.map((w) => w.description));
  for (const desc of hotWorkDescs) {
    if (!memoryDescs.has(desc)) {
      lines.push(`  - [NEW] ${desc}`);
    }
  }
}

function formatWorkItem(item: SupervisorMemory["activeWork"][number], now: Date): string {
  const duration = formatDuration(new Date(item.since), now);
  const status = item.status.toUpperCase();
  let line = `  - [${status} ${duration}] ${item.description}`;
  if (item.runId) line += ` (run ${item.runId.slice(0, 8)})`;
  if (item.deadline) {
    const hoursLeft = (new Date(item.deadline).getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursLeft <= 2 && hoursLeft > 0) {
      line += ` — ⚠ deadline: ${item.deadline}`;
    }
  }
  return line;
}

function renderBlockers(
  lines: string[],
  memory: SupervisorMemory,
  hotBlockerDescs: string[],
  now: Date,
): void {
  if (hotBlockerDescs.length === 0 && memory.blockers.length === 0) return;

  lines.push("blockers:");
  for (const blocker of memory.blockers) {
    const duration = formatDuration(new Date(blocker.since), now);
    let line = `  - [${duration}] ${blocker.description}`;
    if (blocker.runId) {
      line += ` (reported by ${blocker.source ?? "agent"}/${blocker.runId.slice(0, 8)})`;
    }
    lines.push(line);
  }
  const memoryDescs = new Set(memory.blockers.map((b) => b.description));
  for (const desc of hotBlockerDescs) {
    if (!memoryDescs.has(desc)) {
      lines.push(`  - [NEW] ${desc}`);
    }
  }
}

function formatDuration(since: Date, now: Date): string {
  const ms = now.getTime() - since.getTime();
  if (ms < 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

// ─── Standard prompt (lightweight, no full memory) ──────

/**
 * Build the standard heartbeat prompt (4 out of 5 heartbeats).
 * Includes hot state + agent digest, but NOT full memory/knowledge.
 */
export function buildStandardPrompt(opts: StandardPromptOptions): string {
  const sections: string[] = [];

  // Role
  sections.push(`${ROLE_STANDARD}\n\nHeartbeat #${opts.heartbeatCount}`);

  // Commands
  sections.push(COMMANDS);

  // Reporting
  sections.push(REPORTING);

  // Custom instructions
  if (opts.customInstructions) {
    sections.push(`## Custom instructions\n${opts.customInstructions}`);
  }

  // Repos
  sections.push(buildReposSection(opts.repos));

  // MCP
  if (opts.mcpServerNames.length > 0) {
    sections.push(buildMcpSection(opts.mcpServerNames));
  }

  // Budget
  sections.push(buildBudgetSection(opts.budgetStatus));

  // Hot state
  const hotState = renderHotState(opts.memory, opts.recentEntries);
  sections.push(`## Current state\n${hotState}`);

  // Active runs
  if (opts.activeRuns.length > 0) {
    sections.push(`## Active runs\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  // Agent digest
  const digest = buildAgentDigest(opts.recentEntries);
  if (digest) {
    sections.push(`## Agent digest\n${digest}`);
  }

  // Events
  sections.push(buildEventsSection(opts.grouped));

  // Footer — no memory ops needed
  sections.push("Memory consolidation at next cycle — no <memory-ops> needed now.");

  return sections.join("\n\n---\n\n");
}

// ─── Consolidation prompt (full memory + knowledge) ─────

/**
 * Build the consolidation heartbeat prompt (1 out of 5 heartbeats).
 * Includes full memory + knowledge + accumulated digest.
 */
export function buildConsolidationPrompt(opts: ConsolidationPromptOptions): string {
  const sections: string[] = [];

  // Role
  sections.push(`${ROLE_STANDARD}\n\nHeartbeat #${opts.heartbeatCount} (CONSOLIDATION)`);

  // Commands
  sections.push(COMMANDS);

  // Reporting
  sections.push(REPORTING);

  // Custom instructions
  if (opts.customInstructions) {
    sections.push(`## Custom instructions\n${opts.customInstructions}`);
  }

  // Repos
  sections.push(buildReposSection(opts.repos));

  // MCP
  if (opts.mcpServerNames.length > 0) {
    sections.push(buildMcpSection(opts.mcpServerNames));
  }

  // Budget
  sections.push(buildBudgetSection(opts.budgetStatus));

  // Hot state
  const hotState = renderHotState(opts.memory, opts.allUnconsolidatedEntries);
  sections.push(`## Current state\n${hotState}`);

  // Active runs
  if (opts.activeRuns.length > 0) {
    sections.push(`## Active runs\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  // Agent digest (all unconsolidated)
  const digest = buildAgentDigest(opts.allUnconsolidatedEntries);
  if (digest) {
    sections.push(`## Agent digest (accumulated)\n${digest}`);
  }

  // Events
  sections.push(buildEventsSection(opts.grouped));

  // Full memory
  sections.push(`## Your current memory\n\`\`\`json\n${opts.memoryJson}\n\`\`\``);

  // Full knowledge
  if (opts.knowledgeMd) {
    sections.push(`## Reference knowledge\n${opts.knowledgeMd}`);
  }

  // Consolidation footer with ops instructions
  sections.push(`This is a CONSOLIDATION heartbeat. Review the digest entries marked ★ (memory) and ◆ (knowledge).

Before integrating, check for CONTRADICTIONS between new entries and existing knowledge.
If a new fact contradicts an existing one, REPLACE the old fact.

Use <memory-ops> for memory updates:
\`\`\`
<memory-ops>
{"op":"set","path":"agenda","value":"updated agenda text"}
{"op":"append","path":"decisions","value":{"date":"${new Date().toISOString().slice(0, 10)}","decision":"..."}}
{"op":"remove","path":"blockers","index":0}
</memory-ops>
\`\`\`

Use <knowledge-ops> for knowledge updates:
\`\`\`
<knowledge-ops>
{"op":"append","section":"/repos/myapp","fact":"New fact here","source":"developer","date":"${new Date().toISOString().slice(0, 10)}"}
{"op":"remove","section":"/repos/myapp","index":2}
</knowledge-ops>
\`\`\`

Review and update your agenda. Remove completed items, add new ones.
If nothing to change, skip the ops blocks entirely.`);

  return sections.join("\n\n---\n\n");
}

// ─── Compaction prompt ──────────────────────────────────

/**
 * Build the compaction heartbeat prompt (every ~50 heartbeats).
 * Deep cleanup: remove stale facts, merge duplicates, summarize old decisions.
 */
export function buildCompactionPrompt(opts: ConsolidationPromptOptions): string {
  const sections: string[] = [];

  // Role
  sections.push(`${ROLE_STANDARD}\n\nHeartbeat #${opts.heartbeatCount} (COMPACTION)`);

  // Commands
  sections.push(COMMANDS);

  // Reporting
  sections.push(REPORTING);

  // Custom instructions
  if (opts.customInstructions) {
    sections.push(`## Custom instructions\n${opts.customInstructions}`);
  }

  // Repos
  sections.push(buildReposSection(opts.repos));

  // MCP
  if (opts.mcpServerNames.length > 0) {
    sections.push(buildMcpSection(opts.mcpServerNames));
  }

  // Budget
  sections.push(buildBudgetSection(opts.budgetStatus));

  // Full memory
  sections.push(`## Your current memory\n\`\`\`json\n${opts.memoryJson}\n\`\`\``);

  // Full knowledge
  if (opts.knowledgeMd) {
    sections.push(`## Reference knowledge\n${opts.knowledgeMd}`);
  }

  // Compaction instructions
  sections.push(`This is a COMPACTION heartbeat. Review your ENTIRE memory and knowledge for cleanup.

Tasks:
1. Remove stale facts from knowledge (>7 days old with no recent reinforcement)
2. Merge duplicate or similar facts within the same repo section
3. Summarize old decisions into patterns (keep last 10 detailed, summarize older ones)
4. Remove completed items from activeWork
5. Clear resolved blockers
6. Update your agenda — remove completed goals, add new priorities
7. Stay under 6KB memory / 20 facts per repo in knowledge

Flag contradictions: if two facts contradict, keep the newer one.
Mark facts you're unsure about with (needs verification).

Use <memory-ops> for memory updates:
\`\`\`
<memory-ops>
{"op":"set","path":"agenda","value":"updated agenda text"}
{"op":"append","path":"decisions","value":{"date":"${new Date().toISOString().slice(0, 10)}","decision":"..."}}
{"op":"remove","path":"blockers","index":0}
</memory-ops>
\`\`\`

Use <knowledge-ops> for knowledge updates:
\`\`\`
<knowledge-ops>
{"op":"append","section":"/repos/myapp","fact":"New fact here","source":"supervisor","date":"${new Date().toISOString().slice(0, 10)}"}
{"op":"remove","section":"/repos/myapp","index":2}
</knowledge-ops>
\`\`\`

If nothing to change, skip the ops blocks entirely.`);

  return sections.join("\n\n---\n\n");
}

// ─── Shared section builders ────────────────────────────

function buildReposSection(repos: RepoConfig[]): string {
  if (repos.length > 0) {
    const repoList = repos.map((r) => `- ${r.path} (branch: ${r.defaultBranch})`).join("\n");
    return `## Registered repositories\n${repoList}`;
  }
  return "## Registered repositories\n(none — run 'neo init' in a repo to register it)";
}

function buildMcpSection(mcpServerNames: string[]): string {
  const mcpList = mcpServerNames.map((n) => `- ${n}`).join("\n");
  return `## Available integrations (MCP)\n${mcpList}\n\nYou can use these tools directly to query external systems.`;
}

function buildBudgetSection(budgetStatus: {
  todayUsd: number;
  capUsd: number;
  remainingPct: number;
}): string {
  return `## Budget status\n- Today: $${budgetStatus.todayUsd.toFixed(2)} / $${budgetStatus.capUsd.toFixed(2)} (${budgetStatus.remainingPct.toFixed(0)}% remaining)`;
}

function buildEventsSection(grouped: GroupedEvents): string {
  const { messages, webhooks, runCompletions } = grouped;
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
    return `## Pending events (${totalEvents})\n${parts.join("\n\n")}`;
  }
  return "## Pending events\nNo new events. This is an idle heartbeat — check on active runs if any, or wait.";
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

// ─── Legacy compatibility ───────────────────────────────

/**
 * @deprecated Use buildStandardPrompt or buildConsolidationPrompt instead.
 * Kept for backward compatibility during migration.
 */
export function buildHeartbeatPrompt(opts: HeartbeatPromptOptions): string {
  const sections: string[] = [];

  sections.push(`${ROLE_STANDARD}\n\nHeartbeat #${opts.heartbeatCount}

IMPORTANT: Always include a <memory>...</memory> block at the end of your response with your updated memory.`);

  sections.push(COMMANDS);
  sections.push(REPORTING);

  if (opts.customInstructions) {
    sections.push(`## Custom instructions\n${opts.customInstructions}`);
  }

  sections.push(buildReposSection(opts.repos));

  if (opts.mcpServerNames.length > 0) {
    sections.push(buildMcpSection(opts.mcpServerNames));
  }

  sections.push(buildBudgetSection(opts.budgetStatus));

  if (opts.activeRuns.length > 0) {
    sections.push(`## Active runs\n${opts.activeRuns.map((r) => `- ${r}`).join("\n")}`);
  }

  sections.push(buildEventsSection(opts.grouped));

  if (opts.knowledge) {
    sections.push(`## Reference knowledge (read-only)
${opts.knowledge}

To update knowledge, output a \`<knowledge>...</knowledge>\` block. Only update when reference data changes (API IDs, workspace config, etc.).`);
  }

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
