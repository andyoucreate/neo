# Supervisor Instructions Architecture

This document explains why neo has two supervisor instruction files and when to use each.

## Purpose

Neo supports two distinct usage patterns for supervisor functionality:

1. **Autonomous daemon** — a background process that monitors trackers, dispatches agents, and processes results without human intervention
2. **Interactive sessions** — a human operator using Claude Code to dispatch agents on-demand

Each pattern requires different instructions, optimized for its execution context.

## Runtime Instructions

**File:** `packages/agents/SUPERVISOR.md`

### Purpose

Domain knowledge loaded by `SupervisorDaemon` at runtime. This file is consumed by the autonomous supervisor loop — no human is present.

### Loaded by

- `packages/core/src/supervisor/heartbeat.ts` — heartbeat cycle that processes events
- `packages/core/src/supervisor/daemon.ts` — daemon initialization

### Resolution order

1. Explicit path via `supervisor.instructions` in neo config
2. User default: `~/.neo/SUPERVISOR.md`
3. Bundled default from `@neotx/agents` package

### Content focus

- Agent output contracts (JSON schemas for parsing)
- Dispatch `--meta` fields for traceability
- Pipeline state machine transitions
- Anti-loop guards and escalation policy
- Self-evaluation rules for inferring missing ticket fields

The daemon operates in a tight loop: receive event → parse → decide → dispatch → yield. Instructions must be unambiguous and machine-actionable.

## Interactive Skill

**File:** `skills/neo-supervisor/SKILL.md`

### Purpose

Claude Code skill for human-driven supervisor workflows. The human operator invokes `/neo-supervisor` when they want Claude to help dispatch agents, monitor runs, or make decisions.

### Loaded by

Claude Code skill system when the user invokes the skill or when Claude determines it's relevant to the conversation.

### Content focus

- Command syntax and examples
- Decision rules as guidance (not rigid state machine)
- Supervisor loop as a pattern to follow
- Budget awareness and prioritization advice

The interactive skill can explain reasoning, ask clarifying questions, and adapt to the operator's intent. Instructions are conversational and flexible.

## When to Use Which

| Scenario | File |
|----------|------|
| Building/configuring `SupervisorDaemon` | `packages/agents/SUPERVISOR.md` |
| Adding agent output contracts | `packages/agents/SUPERVISOR.md` |
| Modifying pipeline state transitions | `packages/agents/SUPERVISOR.md` |
| Improving interactive UX | `skills/neo-supervisor/SKILL.md` |
| Adding command examples | `skills/neo-supervisor/SKILL.md` |
| Documenting decision heuristics | `skills/neo-supervisor/SKILL.md` |

## Maintenance Notes

### Keep in sync

Both files list the same agents with the same capabilities. If you add an agent:

1. Add to the table in `packages/agents/SUPERVISOR.md`
2. Add to the table in `skills/neo-supervisor/SKILL.md`
3. Document the output contract in `packages/agents/SUPERVISOR.md`

### Cross-references

Each file has a header comment pointing to the other:

- `SUPERVISOR.md` references the skill for interactive use
- `SKILL.md` references the runtime file for daemon behavior

Update these if file paths change.

### Testing changes

- **Runtime instructions**: run integration tests with `pnpm test` in `packages/core`
- **Interactive skill**: test manually by invoking `/neo-supervisor` in Claude Code
