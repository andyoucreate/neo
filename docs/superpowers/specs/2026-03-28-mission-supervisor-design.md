# Mission Supervisor — Design Spec

**Date:** 2026-03-28
**Status:** Draft
**Scope:** Hierarchical supervisor architecture — CEO dispatches MissionSupervisors that guarantee delivery of a mission end-to-end.

---

## Problem

The `Agent` tool is fire-and-forget. There is no supervision *during* execution — no trajectory correction, no stall detection, no retry with context. A task is dispatched and either succeeds or fails. Nobody is accountable for ensuring it completes.

The result: complex multi-step missions fail silently, loop without progress, or stop mid-way with no recovery.

---

## Goal

Introduce a `MissionSupervisor` — a child process with a **persistent SDK conversation** that loops on a single mission until it declares completion. The CEO supervisor dispatches missions to MissionSupervisors instead of directly to agents. MissionSupervisors own the full delivery cycle: spawning agents, monitoring progress, recovering from failures, and reporting back to the CEO.

---

## Architecture

```
CEO Supervisor (process A)
│  Existing HeartbeatLoop — dispatches missions, monitors children
│  ChildSupervisorRegistry: Map<missionId, ChildHandle>
│
├─[IPC]─▶ MissionSupervisor "feat/auth" (process B)
│           Persistent SDK session (resume: sessionId)
│           Loops every tickInterval until mission_complete
│           Spawns: developer, scout, reviewer agents
│           Reports: progress | blocked | complete | failed
│
└─[IPC]─▶ MissionSupervisor "fix/perf" (process C)
            Same structure, isolated context
```

**Depth limit:** CEO → MissionSupervisor → agents (max depth = 1, by design for now). MissionSupervisors cannot spawn other MissionSupervisors.

---

## Components

### 1. `MissionSupervisor` (new — `packages/core/src/supervisor/mission-supervisor.ts`)

A lightweight child process that owns one mission.

```typescript
interface MissionSupervisorOptions {
  missionId: string;
  mission: string;           // The goal/plan in natural language
  repoPath: string;          // Isolated git clone path
  sessionId?: string;        // Resume previous session if provided
  tickInterval: number;      // ms between SDK turns (default: 30_000)
  depth: number;             // Always 0 for now — reserved for future recursive depth > 1
  config: GlobalConfig;
}
```

**Loop behavior:**
1. Build prompt: current mission state + recent agent activity + pending decisions
2. Call `query({ prompt, resume: sessionId, allowedTools: ["Agent", "Read", "Bash", ...] })`
3. Capture `session_id` from init message — persist to disk after first turn
4. Stream messages — intercept `mission_complete` tool call
5. If `mission_complete` → send IPC `{ type: "complete", missionId, summary }` → exit
6. If `mission_blocked` → send IPC `{ type: "blocked", missionId, reason }` → wait for CEO response
7. Otherwise → sleep `tickInterval` → go to 1

**Session persistence:** `~/.neo/missions/<missionId>/session.json` — survives process crash. On restart, `resume: sessionId` picks up the conversation exactly where it left off.

### 2. `mission_complete` tool (new — intercepted by framework, not sent to Claude)

```typescript
const missionCompleteToolSchema = z.object({
  summary: z.string(),           // What was accomplished
  evidence: z.array(z.string()), // PR URL, test output, CI status, etc.
  branch: z.string().optional(), // Branch created if applicable
});
```

**Critical:** The completion condition must be **objectively verifiable**, not self-declared. The MissionSupervisor prompt explicitly requires evidence (CI green, PR open, acceptance criteria met) before calling `mission_complete`.

### 3. `mission_blocked` tool (new)

```typescript
const missionBlockedSchema = z.object({
  reason: z.string(),      // Why the mission cannot proceed
  question: z.string(),    // What the CEO needs to decide
  context: z.string(),     // Relevant context for the decision
});
```

When blocked, the MissionSupervisor pauses its loop and creates a `Decision` in the CEO's DecisionStore. When the CEO answers, it sends an IPC `{ type: "unblock", answer }` to resume.

### 4. `ChildSupervisorRegistry` (new — `packages/core/src/supervisor/child-registry.ts`)

Owned by the CEO's `HeartbeatLoop`. Tracks all active MissionSupervisors.

```typescript
interface ChildHandle {
  missionId: string;
  mission: string;
  process: ChildProcess;
  sessionId?: string;      // Populated after first SDK turn
  startedAt: string;
  lastProgressAt: string;
  status: "running" | "blocked" | "complete" | "failed";
}
```

**IPC protocol (child → parent):**
```typescript
type ChildToParentMessage =
  | { type: "progress"; missionId: string; summary: string }
  | { type: "complete"; missionId: string; summary: string; evidence: string[] }
  | { type: "blocked"; missionId: string; reason: string; question: string }
  | { type: "failed"; missionId: string; error: string };
```

**IPC protocol (parent → child):**
```typescript
type ParentToChildMessage =
  | { type: "unblock"; answer: string }
  | { type: "stop" };
```

### 5. CEO `HeartbeatLoop` changes (modify existing)

The CEO gains a new dispatch path: instead of `neo run <agent>`, it can `neo mission <goal>` which spawns a MissionSupervisor child process.

The HeartbeatLoop:
- Receives IPC messages from all children → pushes into EventQueue as `mission_*` events
- On `mission_blocked` → creates a Decision, includes it in next heartbeat prompt
- On `mission_complete` → logs, updates task store, notifies
- On `mission_failed` → applies existing 3-level recovery logic
- Detects stalled children (no `progress` for > stallTimeout) → kills and restarts

---

## IPC Transport

Using Node.js native IPC (`child_process.fork` with `{ stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }`).

- Messages are JSON-serialized structs (typed above)
- Child stdout/stderr piped to CEO activity log
- If child crashes → CEO gets `'exit'` event → triggers recovery

**Why not webhooks?** IPC is synchronous, zero-latency, and requires no port coordination between siblings. Webhooks are for external events; IPC is for internal parent-child coordination.

---

## Stall Detection

A MissionSupervisor is considered **stalled** if:
- No IPC message received for `> config.missionStallTimeout` (default: 10 min)
- OR the SDK session returns empty turns N times in a row (default: 3)

On stall: CEO kills the child process, restarts it with `resume: sessionId` (the conversation is preserved — the supervisor continues with full context of what it already tried).

---

## Completion Verification

The MissionSupervisor prompt must enforce that `mission_complete` is only called when:
1. All acceptance criteria from the original mission are met
2. At least one piece of objective evidence is provided (PR URL, test output, etc.)
3. CI is green (if applicable)

The CEO always spawns a `reviewer` agent to verify completion before accepting the signal. The reviewer checks: PR exists, CI green, acceptance criteria met. If verification fails, the CEO sends `{ type: "unblock", answer: "verification failed: <reason>" }` to restart the MissionSupervisor loop.

---

## Failure Recovery

Follows existing neo 3-level escalation:
1. **Normal:** MissionSupervisor resumes session, retries with corrected context
2. **Resume:** CEO restarts child with `resume: sessionId` + additional context injected
3. **Fresh:** CEO starts new MissionSupervisor for same mission (new session, new clone)

---

## File Map

| File | Change |
|------|--------|
| `packages/core/src/supervisor/mission-supervisor.ts` | New — MissionSupervisor class |
| `packages/core/src/supervisor/child-registry.ts` | New — ChildSupervisorRegistry |
| `packages/core/src/supervisor/mission-tools.ts` | New — `mission_complete` + `mission_blocked` tool schemas |
| `packages/core/src/supervisor/heartbeat.ts` | Modify — integrate ChildSupervisorRegistry, handle IPC events |
| `packages/core/src/supervisor/prompt-builder.ts` | Modify — add mission dispatch instructions to CEO prompt |
| `packages/agents/prompts/mission-supervisor.md` | New — MissionSupervisor system prompt |
| `packages/core/src/supervisor/schemas.ts` | Modify — add MissionSupervisor state schema |
| `packages/core/src/paths.ts` | Modify — add `getMissionsDir()` path helper |

---

## Out of Scope (for now)

- MissionSupervisors spawning sub-MissionSupervisors (depth > 1)
- Web UI for mission monitoring
- Cross-repo missions (single repo per mission)
- Mission priority/preemption
- Budget per mission (global budget only for now)

---

## Open Question

**Depth > 1 extensibility:** The design uses `depth` field in `MissionSupervisorOptions` (default: 0). When depth > 0, `mission_complete` propagates up the chain. This field is reserved but not implemented — it's the hook for future recursive depth.
