# Plan 09 — Memory System Roadmap

> Design document: `~/.claude/plans/prancy-wobbling-wombat.md`

## Overview

Transform `neo log` into a universal memory interface for agents and supervisor, with a multi-layered memory system (working/semantic/episodic), two heartbeat rhythms (perception/consolidation), and delta-based memory operations.

## Dependency Graph

```
Phase 1 ─────────────────────┐
  Schemas + Log Buffer + CLI  │
                              ├──→ Phase 3
Phase 2 ─────────────────────┘      Heartbeat Integration
  Memory Ops + Knowledge MD          + Prompt Builder
  + Memory Schema Refonte                  │
                                           ├──→ Phase 5
Phase 4 ──────────────────────────────────┘      Advanced Features
  Agent Prompts + Feedback Loop
  + Cross-run Learning
```

Phase 1 and Phase 2 are **parallel** (no dependency between them).
Phase 3 depends on both Phase 1 and Phase 2.
Phase 4 can start after Phase 1 (for agent prompts) but feedback loop needs Phase 3.
Phase 5 depends on Phase 3.

---

## Phase 1 — Foundation: Schemas + Log Buffer + CLI

**Goal**: `neo log` writes to the buffer, agents have env vars, everything compiles.

### Scope
- [ ] `logBufferEntrySchema` + `knowledgeOpSchema` + `memoryOpSchema` in `schemas.ts`
- [ ] `lastConsolidationHeartbeat`, `lastCompactionHeartbeat` in daemon state schema
- [ ] `consolidationInterval` in supervisor config schema
- [ ] Create `log-buffer.ts`: `readLogBuffer()`, `markConsolidated()`, `compactLogBuffer()`, `buildAgentDigest()`, `computeHotState()`
- [ ] Enrich `log.ts` CLI: 6 types, `--memory`/`--knowledge`/`--repo` flags, implicit routing, triple write (activity + buffer + inbox for blockers)
- [ ] Add `env` to `SessionOptions` in `session.ts`, pass `NEO_RUN_ID`, `NEO_AGENT_NAME`, `NEO_REPOSITORY`
- [ ] Export new modules from `index.ts`
- [ ] Tests for log-buffer (read, mark, compact, digest, hot state)
- [ ] Tests for CLI (types, flags, routing, blocker→inbox)

### Files
| File | Action |
|------|--------|
| `packages/core/src/supervisor/schemas.ts` | Modify |
| `packages/core/src/supervisor/log-buffer.ts` | **Create** |
| `packages/cli/src/commands/log.ts` | Modify |
| `packages/core/src/runner/session.ts` | Modify |
| `packages/core/src/supervisor/index.ts` | Modify |
| `packages/core/src/config.ts` | Modify (consolidationInterval) |

### Verification
```bash
pnpm build && pnpm typecheck && pnpm test
neo log progress "test" --agent dev --run test-1
neo log blocker "test blocker" --agent dev --run test-1
cat ~/.neo/supervisors/supervisor/log-buffer.jsonl
cat ~/.neo/supervisors/supervisor/inbox.jsonl
```

---

## Phase 2 — Memory System: Delta Ops + Knowledge Markdown + Schema Refonte

**Goal**: Memory supports delta operations, knowledge is markdown, SupervisorMemory schema is restructured.

### Scope
- [ ] Refactor `SupervisorMemory` interface: structured `activeWork`/`blockers` (with runId, repo, status, since, deadline, priority), add `agenda`, remove `repoNotes`/`notes`
- [ ] Migration logic in `loadMemory()`: old string[] → new structured objects
- [ ] `extractMemoryOps()` with robust line-by-line parsing (skip malformed)
- [ ] `applyMemoryOps()`: apply ops immutably on SupervisorMemory
- [ ] Remove `extractMemoryFromResponse()` and `extractKnowledgeFromResponse()` — no fallback, if ops fail memory stays untouched
- [ ] Audit log: append every `<memory-ops>` to `memory-archive.jsonl`
- [ ] Rewrite `knowledge.ts`: `parseKnowledge()`, `renderKnowledge()`, `applyKnowledgeOps()`, `selectKnowledgeForRepos()`
- [ ] Migration `knowledge.json` → `knowledge.md` (one-time on first load)
- [ ] Knowledge provenance: `[source, date]` inline in markdown
- [ ] Tests for memory ops (extract, apply, zero-ops-safe)
- [ ] Tests for knowledge (parse, render, ops, select, migration)

### Files
| File | Action |
|------|--------|
| `packages/core/src/supervisor/memory.ts` | Modify (ops + schema refonte + migration) |
| `packages/core/src/supervisor/knowledge.ts` | **Rewrite** (JSON → markdown) |
| `packages/core/src/supervisor/schemas.ts` | Modify (if not done in Phase 1) |
| `packages/core/src/supervisor/index.ts` | Modify |

### Verification
```bash
pnpm build && pnpm typecheck && pnpm test
# Manual: check that loadMemory migrates old format
# Manual: check that knowledge.md is created from knowledge.json
```

---

## Phase 3 — Heartbeat Integration: Two Rhythms + Prompt Builder

**Goal**: Heartbeat runs in two modes (standard/consolidation), prompt builder generates appropriate prompts, full integration.

### Scope
- [ ] `shouldConsolidate()` in heartbeat.ts: fixed cadence + pending material trigger
- [ ] Standard heartbeat: computeHotState() + digest (sliding window on timestamp) + events. No memory output.
- [ ] Consolidation heartbeat: full memory + knowledge + accumulated digest + `<memory-ops>`/`<knowledge-ops>` instructions
- [ ] Two clocks: no marking at standard, `consolidatedAt` only at consolidation
- [ ] `buildStandardPrompt()`: hot state with time elapsed + digest + events
- [ ] `buildConsolidationPrompt()`: full memory + knowledge + digest with ★◆⚠ markers + contradiction detection instructions + agenda review
- [ ] After consolidation: apply memory-ops, apply knowledge-ops, mark entries, update state
- [ ] Supervisor prompted to use `neo log` for its own discoveries
- [ ] Hot state rendering: `[RUNNING 2h31m]`, `[BLOCKED 45m]`, deadline warnings
- [ ] Tests for shouldConsolidate, both prompt modes, integration

### Files
| File | Action |
|------|--------|
| `packages/core/src/supervisor/heartbeat.ts` | Modify (major) |
| `packages/core/src/supervisor/prompt-builder.ts` | Modify (major) |
| `packages/core/src/supervisor/schemas.ts` | Modify (state fields) |

### Verification
```bash
pnpm build && pnpm typecheck && pnpm test
# Integration: start supervisor, send messages, verify two-rhythm behavior in activity.jsonl
```

---

## Phase 4 — Agent Integration: Prompts + Feedback Loop

**Goal**: Agents are prompted to use `neo log`, receive knowledge about their repo, and learn from previous run failures.

### Scope
- [ ] Add `neo log` chaining instructions to all agent prompts (developer, reviewer, fixer, architect)
- [ ] Inject relevant knowledge.md section into agent prompts (filtered by repo)
- [ ] Cross-run learning: read last N failed runs on same repo from `.neo/runs/`, inject lessons into agent prompt
- [ ] Update SUPERVISOR.md: instruct supervisor to use `neo log discovery` for MCP/Notion findings
- [ ] Update prompt-builder.ts supervisor prompts: `neo log` instructions with examples

### Files
| File | Action |
|------|--------|
| `packages/agents/prompts/developer.md` | Modify |
| `packages/agents/prompts/reviewer.md` | Modify |
| `packages/agents/prompts/fixer.md` | Modify |
| `packages/agents/prompts/architect.md` | Modify |
| `packages/agents/SUPERVISOR.md` | Modify |
| `packages/core/src/runner/session.ts` | Modify (knowledge injection) |
| `packages/core/src/supervisor/prompt-builder.ts` | Modify (supervisor neo log examples) |

### Verification
```bash
pnpm build && pnpm typecheck && pnpm test
# Manual: dispatch a developer agent, check it uses neo log
# Manual: dispatch a second agent on same repo, check it receives knowledge
```

---

## Phase 5 — Advanced: Compaction + Memory Search + Polish

**Goal**: LLM-based compaction, on-demand memory search, production hardening.

### Scope
- [ ] Compaction heartbeat (3rd rhythm): every ~50 heartbeats, summarize/deduplicate/prune
- [ ] `lastCompactionHeartbeat` tracking in state
- [ ] `neo memory search <query>` command: grep across memory.json + knowledge.md
- [ ] `neo memory list` command: index of all stored knowledge sections
- [ ] Knowledge compaction: max 10 facts per repo, archive oldest
- [ ] Staleness markers in consolidation prompt: facts >30 days flagged `(stale?)`
- [ ] Tests for compaction logic, memory search

### Files
| File | Action |
|------|--------|
| `packages/core/src/supervisor/heartbeat.ts` | Modify (3rd rhythm) |
| `packages/core/src/supervisor/prompt-builder.ts` | Modify (compaction prompt) |
| `packages/cli/src/commands/memory.ts` | **Create** |
| `packages/cli/src/index.ts` | Modify (add memory subcommand) |

### Verification
```bash
pnpm build && pnpm typecheck && pnpm test
neo memory search "prisma"
neo memory list
```
