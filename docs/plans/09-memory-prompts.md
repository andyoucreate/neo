# Memory System — Execution Prompts

Each prompt is designed to be run in a **separate Claude Code session** via `/oneshot` or direct paste. They are self-contained with full context.

---

## Phase 1 — Foundation: Schemas + Log Buffer + CLI

```
Implement the neo log buffer system and enriched CLI. This is Phase 1 of the memory system redesign (see docs/plans/09-memory-system.md for full roadmap).

## Context

`neo log` currently writes to `activity.jsonl` only. We need it to also write to a `log-buffer.jsonl` that the supervisor heartbeat will drain. This phase builds the foundation — schemas, buffer module, CLI enrichment, and env var injection.

## What to implement

### 1. Schemas (`packages/core/src/supervisor/schemas.ts`)

Add these new schemas:

```typescript
// Log buffer entry — written by neo log, read by heartbeat
export const logBufferEntrySchema = z.object({
  id: z.string(),
  type: z.enum(["progress", "action", "decision", "blocker", "milestone", "discovery"]),
  message: z.string(),
  agent: z.string().optional(),
  runId: z.string().optional(),
  repo: z.string().optional(),
  target: z.enum(["memory", "knowledge", "digest"]),
  timestamp: z.string(),
  consolidatedAt: z.string().optional(),
});

// Memory delta operations
export const memoryOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("append"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string(), index: z.number() }),
]);

// Knowledge delta operations
export const knowledgeOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append"), section: z.string(), fact: z.string(), source: z.string().optional(), date: z.string().optional() }),
  z.object({ op: z.literal("remove"), section: z.string(), index: z.number() }),
]);
```

Add to `supervisorDaemonStateSchema`:
- `lastConsolidationHeartbeat: z.number().default(0)`
- `lastCompactionHeartbeat: z.number().default(0)`

Add `consolidationInterval` (default: 5) to the supervisor config schema.

### 2. Log buffer module (`packages/core/src/supervisor/log-buffer.ts`) — CREATE

Functions to implement:
- `readLogBuffer(dir: string): Promise<LogBufferEntry[]>` — read all entries from log-buffer.jsonl
- `readLogBufferSince(dir: string, since: string): Promise<LogBufferEntry[]>` — entries with timestamp > since
- `readUnconsolidated(dir: string): Promise<LogBufferEntry[]>` — entries where consolidatedAt is null
- `markConsolidated(dir: string, ids: string[]): Promise<void>` — set consolidatedAt on entries by id
- `compactLogBuffer(dir: string): Promise<void>` — remove entries with consolidatedAt older than 24h. Cap file at 1MB.
- `buildAgentDigest(entries: LogBufferEntry[]): string` — group by runId, sort chronologically, add ★◆⚠ markers, dedup adjacent identical messages, truncate (max 5/run, 30 total)
- `computeHotState(memory: SupervisorMemory, pendingEntries: LogBufferEntry[]): { activeWork: string[]; blockers: string[] }` — merge memory + pending buffer entries

Follow patterns from existing `event-queue.ts` for file I/O. Use appendFile for writes, readFile+split for reads. Parse each line independently (skip malformed).

### 3. CLI enrichment (`packages/cli/src/commands/log.ts`)

Current: takes `type` (decision/action/blocker/progress) and `message`, writes to activity.jsonl only.

Change to:
- **6 types**: progress, action, decision, blocker, milestone, discovery
- **New flags**: `--memory` (boolean), `--knowledge` (boolean), `--repo <path>`, keep existing `--name`
- **Implicit routing rules**:
  - progress/action → target: "digest"
  - decision/milestone → target: "memory"
  - blocker → target: "memory"
  - discovery → target: "knowledge"
  - `--memory` flag overrides to "memory", `--knowledge` overrides to "knowledge"
- **Triple write**:
  1. Always: append to `activity.jsonl` (existing behavior, keep TYPE_MAP)
  2. Always: append to `log-buffer.jsonl` (new, with full LogBufferEntry schema)
  3. If type === "blocker": also append to `inbox.jsonl` (wake up heartbeat) — format as InboxMessage with `from: "agent"` and synthesized text
- **Agent/run defaults**: read from `$NEO_AGENT_NAME`, `$NEO_RUN_ID`, `$NEO_REPOSITORY` env vars as defaults for --agent, --run, --repo

### 4. Env vars injection (`packages/core/src/runner/session.ts`)

Add `env?: Record<string, string>` to `SessionOptions`. Pass it into `queryOptions` for the SDK. The orchestrator should pass:
- `NEO_RUN_ID`: runId
- `NEO_AGENT_NAME`: agent.name
- `NEO_REPOSITORY`: repoPath

### 5. Exports (`packages/core/src/supervisor/index.ts`)

Export all new types and functions from log-buffer.ts.

### 6. Tests

Write tests in the existing test structure using vitest:
- `log-buffer.test.ts`: read, readSince, readUnconsolidated, markConsolidated, compact, buildAgentDigest, computeHotState
- Update `log.test.ts` if it exists, or create it: test all 6 types, implicit routing, flag overrides, blocker→inbox

## Verification

```bash
pnpm build && pnpm typecheck && pnpm test
```

Do NOT modify heartbeat.ts or prompt-builder.ts — that's Phase 3.
```

---

## Phase 2 — Memory System: Delta Ops + Knowledge Markdown + Schema Refonte

```
Implement memory delta operations, knowledge markdown format, and SupervisorMemory schema restructuring. This is Phase 2 of the memory system redesign (see docs/plans/09-memory-system.md).

Phase 1 (schemas + log buffer + CLI) may or may not be done yet — this phase is independent. If Phase 1 schemas are already in place, build on them. If not, add the schemas yourself.

## Context

Currently:
- Memory uses `<memory>...</memory>` full dump/restore at every heartbeat (~1000 output tokens wasted)
- Knowledge is a free-form `knowledge.json` text file with no structure
- `SupervisorMemory` has flat `string[]` for activeWork/blockers (no traceability)

We're fixing all three.

## What to implement

### 1. SupervisorMemory schema refonte (`packages/core/src/supervisor/memory.ts`)

Replace the current interface:

```typescript
// OLD — remove
export interface SupervisorMemory {
  activeWork: string[];
  blockers: string[];
  repoNotes: Record<string, string>;
  recentDecisions: Array<{ date: string; decision: string; outcome?: string }>;
  trackerSync: Record<string, string>;
  notes: string;
}

// NEW
export interface SupervisorMemory {
  agenda: string;  // free-form strategy text

  activeWork: Array<{
    description: string;
    runId?: string;
    repo?: string;
    status: "running" | "waiting" | "blocked";
    priority?: "critical" | "high" | "medium" | "low";
    since: string;
    deadline?: string;
  }>;

  blockers: Array<{
    description: string;
    source?: string;
    runId?: string;
    repo?: string;
    since: string;
  }>;

  decisions: Array<{
    date: string;
    decision: string;
    outcome?: string;
  }>;

  trackerSync: Record<string, string>;
}
```

Update `emptyMemory()` and `parseStructuredMemory()` accordingly. Add migration logic: if the old format is detected (activeWork contains strings instead of objects), convert them:
- `string` → `{ description: string, status: "running", since: new Date().toISOString() }`
- Move `repoNotes` content to a migration note in the activity log
- Drop `notes` (log a warning if non-empty)

### 2. Memory delta operations (`packages/core/src/supervisor/memory.ts`)

Add:

```typescript
export function extractMemoryOps(response: string): MemoryOp[] {
  const match = /<memory-ops>([\s\S]*?)<\/memory-ops>/i.exec(response);
  if (!match?.[1]) return [];
  const ops: MemoryOp[] = [];
  for (const line of match[1].trim().split("\n").filter(Boolean)) {
    try {
      ops.push(memoryOpSchema.parse(JSON.parse(line)));
    } catch { /* skip malformed, log warning */ }
  }
  return ops;
}

export function applyMemoryOps(memory: SupervisorMemory, ops: MemoryOp[]): SupervisorMemory {
  // Clone memory, apply each op:
  // "set" → set field at path (support dot notation for nested: "repoNotes./path")
  // "append" → push value to array at path
  // "remove" → splice array at path by index
  // Return new memory object (immutable)
}
```

Remove `extractMemoryFromResponse()` — NO fallback to `<memory>` full dump. If the LLM outputs no valid ops, memory stays untouched (safer than accepting a potentially corrupted full dump). The LLM must learn the `<memory-ops>` format.

Add audit logging: after applying ops, append to `memory-archive.jsonl`:
```json
{"type":"memory_ops","timestamp":"...","heartbeat":45,"ops":[...]}
```

### 3. Knowledge markdown (`packages/core/src/supervisor/knowledge.ts`) — REWRITE

The current file has `loadKnowledge()` and `saveKnowledge()` working with `knowledge.json` (plain text). Rewrite to use `knowledge.md` with sections per repo.

Format:
```markdown
## /repos/myapp
- Uses Prisma with PostgreSQL [developer, 2026-03-15]
- CI takes ~8 min [supervisor, 2026-03-14]

## Global
- All repos use pnpm workspaces [supervisor, 2026-03-15]
```

Functions:
- `loadKnowledge(dir: string): Promise<string>` — read knowledge.md (migrate from knowledge.json if needed)
- `saveKnowledge(dir: string, content: string): Promise<void>` — write knowledge.md
- `parseKnowledge(md: string): Map<string, string[]>` — parse into section→facts map
- `renderKnowledge(sections: Map<string, string[]>): string` — render back to markdown
- `extractKnowledgeOps(response: string): KnowledgeOp[]` — parse `<knowledge-ops>` block (same robust pattern as memory-ops)
- `applyKnowledgeOps(md: string, ops: KnowledgeOp[]): string` — apply ops to markdown
- `selectKnowledgeForRepos(md: string, repoPaths: string[]): string` — extract only relevant sections

Migration: if `knowledge.json` exists and `knowledge.md` doesn't, convert. If knowledge.json contains JSON, wrap each value as a bullet point. If it's plain text, put it in a `## Legacy` section.

Remove `extractKnowledgeFromResponse()` — NO fallback to `<knowledge>` full text. Same principle: if ops fail, knowledge stays untouched. Safer than overwriting with potentially incomplete text.

### 4. Tests

- `memory.test.ts`: extractMemoryOps (valid, malformed lines, empty), applyMemoryOps (set, append, remove, nested paths), migration from old schema, audit log
- `knowledge.test.ts`: parseKnowledge, renderKnowledge, extractKnowledgeOps, applyKnowledgeOps, selectKnowledgeForRepos, migration from JSON

## Verification

```bash
pnpm build && pnpm typecheck && pnpm test
```

Do NOT modify heartbeat.ts or prompt-builder.ts — that's Phase 3.
```

---

## Phase 3 — Heartbeat Integration: Two Rhythms + Prompt Builder

```
Integrate the memory system into the heartbeat loop with two rhythms (standard/consolidation) and rebuild the prompt builder. This is Phase 3 of the memory system redesign (see docs/plans/09-memory-system.md).

PREREQUISITE: Phase 1 (log-buffer, CLI) and Phase 2 (memory-ops, knowledge markdown, schema refonte) must be complete.

## Context

Currently `heartbeat.ts` loads full memory+knowledge into every prompt and requires the supervisor to output `<memory>...</memory>` full dump every time. This wastes ~2000 tokens per heartbeat.

We're splitting into two rhythms:
- **Standard heartbeat** (4 out of 5): hot state + digest + events. No memory output.
- **Consolidation heartbeat** (1 out of 5): full memory + knowledge + accumulated digest + `<memory-ops>`/`<knowledge-ops>`.

## What to implement

### 1. Heartbeat two modes (`packages/core/src/supervisor/heartbeat.ts`)

Modify `runHeartbeat()`:

```
1. Drain events (existing)
2. Read log buffer:
   - For standard: readLogBufferSince(dir, state.lastHeartbeat)
   - For consolidation: readUnconsolidated(dir) — ALL pending
3. Determine mode: shouldConsolidate(state, config, hasPendingMemoryEntries)
   - hasPendingMemoryEntries = any entry with target "memory" or "knowledge" and no consolidatedAt
4. Build prompt:
   - Standard: buildStandardPrompt(...)
   - Consolidation: buildConsolidationPrompt(...)
5. Call SDK (existing stream logic)
6. After response:
   - Standard: do NOT extract memory/knowledge ops
   - Consolidation:
     a. Extract memory-ops (NO fallback — if zero valid ops, memory stays untouched)
     b. Apply memory-ops to memory.json (only if ops found)
     c. Extract knowledge-ops (NO fallback — same principle)
     d. Apply knowledge-ops to knowledge.md
     e. Audit log the ops to memory-archive.jsonl
     f. markConsolidated(dir, allEntryIds)
     g. compactLogBuffer(dir)
     h. Update state: lastConsolidationHeartbeat = heartbeatCount
7. Update state (existing: lastHeartbeat, heartbeatCount, cost, etc.)
```

`shouldConsolidate()`:
```typescript
function shouldConsolidate(state, config, hasPendingMemoryEntries): boolean {
  const since = state.heartbeatCount - (state.lastConsolidationHeartbeat ?? 0);
  if (since >= config.supervisor.consolidationInterval) return true;
  if (hasPendingMemoryEntries && since >= 2) return true;
  return false;
}
```

### 2. Prompt builder (`packages/core/src/supervisor/prompt-builder.ts`)

Replace the single `buildHeartbeatPrompt()` with two functions:

#### `buildStandardPrompt(opts)` — lightweight, no full memory

Sections:
1. Role (same as before but shorter, no "Always include <memory>" instruction)
2. Commands (keep neo run/neo log instructions)
3. **Reporting**: instruct supervisor to use `neo log` for its own discoveries (`neo log discovery --knowledge "..."`)
4. Custom instructions (SUPERVISOR.md)
5. Repos list
6. MCP integrations
7. Budget status
8. **Hot state** (NOT full memory): render activeWork and blockers with time elapsed:
   ```
   ## Current state
   activeWork:
     - [RUNNING 2h31m] PROJ-42 developer (run abc1) — ⚠ deadline: today 18:00
     - [WAITING 15m] PR #73 CI pending
   blockers:
     - [45m] merge conflict on feat/auth (reported by fixer/run-def2)
   ```
   Use `computeHotState()` from log-buffer.ts to merge memory + pending entries.
   Calculate durations from `since` field vs current time.
9. Active runs
10. **Agent digest**: output of `buildAgentDigest(recentEntries)` with ★◆⚠ markers
11. Events
12. Footer: "Memory consolidation at next cycle — no <memory-ops> needed now."

#### `buildConsolidationPrompt(opts)` — full memory access

Same as standard PLUS:
- Full `memory.json` content (the complete JSON)
- Full `knowledge.md` content
- Accumulated digest (all unconsolidated entries, not just recent)
- Replace footer with consolidation instructions:
  ```
  This is a CONSOLIDATION heartbeat. Review the digest entries marked ★ (memory) and ◆ (knowledge).

  Before integrating, check for CONTRADICTIONS between new entries and existing knowledge.
  If a new fact contradicts an existing one, REPLACE the old fact.

  Use <memory-ops> for memory updates:
  <memory-ops>
  {"op":"set","path":"agenda","value":"updated agenda text"}
  {"op":"append","path":"decisions","value":{"date":"2026-03-15","decision":"..."}}
  {"op":"remove","path":"blockers","index":0}
  </memory-ops>

  Use <knowledge-ops> for knowledge updates:
  <knowledge-ops>
  {"op":"append","section":"/repos/myapp","fact":"New fact here","source":"developer","date":"2026-03-15"}
  {"op":"remove","section":"/repos/myapp","index":2}
  </knowledge-ops>

  Review and update your agenda. Remove completed items, add new ones.
  If nothing to change, skip the ops blocks entirely.
  ```

### 3. Hot state rendering

Create a helper `renderHotState(memory, pendingEntries, now)` that:
- Calls `computeHotState()` to get merged state
- Formats each activeWork item with `[STATUS duration]` prefix
- Adds deadline warning if deadline is within 2 hours
- Links blockers to activeWork by runId: `blocked by: "description"`
- Returns formatted string for prompt injection

### 4. Tests

- `heartbeat.test.ts`: shouldConsolidate logic (cadence, pending material, edge cases)
- `prompt-builder.test.ts`: both prompt modes output correct sections, hot state rendering, digest inclusion

## Verification

```bash
pnpm build && pnpm typecheck && pnpm test
```
```

---

## Phase 4 — Agent Integration: Prompts + Feedback Loop

```
Update all agent prompts to use neo log, inject knowledge into agent sessions, and add cross-run learning. This is Phase 4 of the memory system redesign (see docs/plans/09-memory-system.md).

PREREQUISITE: Phase 1 (neo log CLI exists and works).

## Context

Agents currently have no instructions to use `neo log`. They also don't receive accumulated knowledge about the repo they're working on, leading to re-discoveries. And they don't learn from failures of previous runs on the same repo.

## What to implement

### 1. Agent prompt updates

Add this section to ALL agent prompts (developer.md, reviewer.md, fixer.md, architect.md, and any others in `packages/agents/prompts/`):

```markdown
## Reporting with neo log

Use `neo log` to report progress to the supervisor. ALWAYS chain neo log with the command that triggered it in the SAME Bash call — NEVER use a separate tool call just for logging.

Types:
- `progress` — current status ("3/5 endpoints done")
- `action` — completed action ("Pushed to branch")
- `decision` — significant choice ("Chose JWT over sessions")
- `blocker` — blocking issue ("Tests failing, missing dependency")
- `milestone` — major achievement ("All tests passing, PR opened")
- `discovery` — learned fact about the codebase ("Repo uses Prisma + PostgreSQL")

Flags are auto-filled from environment: --agent, --run, --repo.
Use --memory for facts the supervisor should remember in working memory.
Use --knowledge for stable facts about the codebase.

Examples:
```bash
# Chain with commands — NEVER log separately
git push origin feat/auth && neo log action "Pushed feat/auth"
pnpm test && neo log milestone "All tests passing" || neo log blocker "Tests failing"
ls src/db/migrations ; neo log discovery "Repo uses Prisma with PostgreSQL"
```
```

### 2. Knowledge injection into agent prompts

In `packages/core/src/runner/session.ts` (or wherever the agent prompt is assembled), before calling the SDK:

1. Load `knowledge.md` from the supervisor directory
2. Call `selectKnowledgeForRepos(knowledge, [repoPath])` to get relevant facts
3. If non-empty, prepend to the agent prompt:

```markdown
## Known facts about this repository
- Uses Prisma with PostgreSQL, migrations in /db/migrations [developer, 2026-03-15]
- CI takes ~8 min, flaky test in auth.spec.ts [supervisor, 2026-03-14]
```

This prevents agents from re-discovering known facts.

### 3. Cross-run learning

In the same prompt assembly step:

1. Read `.neo/runs/<repo-slug>/` directory
2. Find the last 3-5 runs on this repo that have `status: "failed"`
3. Extract `error` and `rawOutput` (first 200 chars) from each failed step
4. Inject as lessons:

```markdown
## Lessons from previous runs on this repository
- Run abc1 (developer, 2h ago): Failed — "Migration not applied before tests"
- Run def2 (fixer, 1h ago): Failed — "Merge conflict on src/auth/index.ts"
```

### 4. Supervisor prompt update

In `packages/agents/SUPERVISOR.md` (or equivalent), add instructions for the supervisor to use `neo log` for its own discoveries:

```markdown
## Using neo log for your discoveries

When you learn something from MCP tools, GitHub, Notion, or any external source, log it:

```bash
neo log discovery --knowledge "Notion PROJ-42: deadline March 20, assigned to Karl" --agent supervisor
neo log decision --memory "Prioritizing PROJ-42 over PROJ-99 due to deadline" --agent supervisor
```

Your discoveries will appear in your own digest at the next heartbeat and be consolidated into long-term memory.
```

### 5. Tests

- Verify agent prompts contain neo log instructions
- Test knowledge injection: given a knowledge.md, verify the correct section is injected for a given repo
- Test cross-run learning: given persisted runs with failures, verify lessons are extracted

## Verification

```bash
pnpm build && pnpm typecheck && pnpm test
```
```

---

## Phase 5 — Advanced: Compaction + Memory Search

```
Implement LLM-based memory compaction (3rd heartbeat rhythm) and neo memory search command. This is Phase 5 of the memory system redesign (see docs/plans/09-memory-system.md).

PREREQUISITE: Phase 3 (heartbeat integration with two rhythms).

## Context

The memory system now has standard and consolidation heartbeats. Over time, knowledge.md and memory.json grow. We need periodic deep cleaning (compaction) and on-demand memory access (search).

## What to implement

### 1. Compaction heartbeat (3rd rhythm)

In `heartbeat.ts`, add a `shouldCompact()` check:

```typescript
function shouldCompact(state: SupervisorDaemonState): boolean {
  const since = state.heartbeatCount - (state.lastCompactionHeartbeat ?? 0);
  return since >= 50; // every ~50 heartbeats
}
```

Compaction is a special consolidation heartbeat with a different prompt focus:

```
This is a COMPACTION heartbeat. Review your ENTIRE memory and knowledge for cleanup.

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

Use <memory-ops> and <knowledge-ops> as usual.
```

After compaction: update `state.lastCompactionHeartbeat`.

### 2. `neo memory` commands (`packages/cli/src/commands/memory.ts`) — CREATE

Subcommands:

#### `neo memory search <query>`
- Grep across `memory.json` (formatted) and `knowledge.md`
- Optional `--repo <path>` to filter knowledge section
- Print matching lines with context
- Use `--short` for supervisor (compact output)

#### `neo memory list`
- Parse knowledge.md sections
- Display: section name, fact count, last update date
- Display memory.json summary: activeWork count, blockers count, decisions count

#### `neo memory show`
- Pretty-print full memory.json + knowledge.md

Register in `packages/cli/src/index.ts` as a subcommand.

### 3. Knowledge compaction rules

In `knowledge.ts`, add:
- `compactKnowledge(md: string, maxFactsPerRepo: number): string` — trim oldest facts per section
- Staleness detection: in `renderKnowledge()`, add `(stale?)` marker to facts >30 days old

### 4. Tests

- `heartbeat.test.ts`: shouldCompact logic
- `memory.test.ts` or `memory-commands.test.ts`: search, list functionality
- `knowledge.test.ts`: compaction, staleness markers

## Verification

```bash
pnpm build && pnpm typecheck && pnpm test
neo memory search "prisma"
neo memory list
neo memory show
```
```
