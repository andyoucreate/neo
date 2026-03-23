# Neo Superpowers Parity — Design Specification

## Summary

Rework neo's default agent configuration to match the discipline and workflow quality of the superpowers Claude Code plugin. This means: enriched agent prompts with battle-tested disciplines, session-internal subagent spawning for review loops, a blocking decision-poll mechanism for inter-agent communication, and a simplified supervisor that focuses on strategy rather than micro-managing review cycles.

## Why

Neo agents today are mechanically competent but lack the quality guardrails that make superpowers effective: verification-before-completion, systematic debugging, self-review with fresh-eyes subagent review, and inter-agent communication when blocked. The result is agents that guess when uncertain, claim completion without evidence, and require the supervisor to micro-manage the review/fix cycle across separate sessions.

## Approach — Segmented autonomy with subagent review

Keep role segmentation (architect, developer, reviewer, scout) but make each agent **autonomous within its scope** by:
1. Enriching prompts with superpowers disciplines (verification, debugging, self-review)
2. Giving architect and developer the `Agent` tool to spawn reviewer subagents within their session
3. Adding `neo decision create --wait` for blocking inter-agent communication
4. Simplifying the supervisor to dispatch + strategy + decision routing

This gives the fluidity of superpowers (one session handles implement → review → fix) with the isolation of neo (fresh subagent context for review, git clone per session).

## Agent Roster (4 agents, down from 6)

| Agent | Session | Tools | Subagents spawned | Role |
|-------|---------|-------|-------------------|------|
| **architect** | Long (maxTurns: 75) | Read, Glob, Grep, WebSearch, WebFetch, **Agent** | spec-document-reviewer | Triage, design, spec, plan, execution strategy |
| **developer** | Long (maxTurns: 100) | Read, Write, Edit, Bash, Glob, Grep, **Agent** | spec-compliance-reviewer, code-quality-reviewer | Implement, self-review, self-fix, verify |
| **reviewer** | Short (maxTurns: 30) | Read, Glob, Grep, Bash | none | Independent review (standalone, supervisor-dispatched) |
| **scout** | Long (maxTurns: 50) | Read, Glob, Grep, Bash, WebSearch, WebFetch | none | Autonomous codebase exploration |

**Removed agents:**
- **fixer** — replaced by re-dispatching developer with review feedback as context
- **refiner** — absorbed into architect as triage step 0

---

## 1. Architect prompt — enrichment

### 1.1 Triage (replaces refiner)

Score the ticket (1–5) before designing:
- **5**: Crystal clear → proceed to design. Example: "Add JWT validation middleware to /api/auth route, return 401 on invalid token, use existing jwt.verify from src/utils/auth.ts"
- **4**: Clear enough → proceed, enrich with codebase context. Example: "Add auth middleware to the API" (clear intent, missing specifics that codebase exploration can fill)
- **3**: Ambiguous → `neo decision create --wait` for clarifications. Example: "Improve the auth system" (multiple valid interpretations — add OAuth? Fix session bugs? Add RBAC?)
- **2**: Vague → `neo decision create --wait` with decomposition proposal. Example: "Security improvements" (no scope, no criteria, needs full scoping conversation)
- **1**: Incoherent → escalate immediately, STOP. Example: contradictory requirements or empty ticket

### 1.2 Design-first exploration

Before designing, the architect MUST:
1. Explore the codebase — read existing patterns, conventions, adjacent code
2. If ambiguous → `neo decision create --wait` per unclear point
3. Identify 2–3 possible approaches with trade-offs
4. Select recommended approach with reasoning in the design output

### 1.3 Spec document

Write a design document to `.neo/specs/{ticket-id}-design.md` containing:
- Summary and approach chosen (with alternatives considered and why rejected)
- Component/module breakdown
- Data flow (inputs → processing → outputs)
- Risks and mitigations
- Task dependency graph

### 1.4 Spec review loop (subagent)

Spawn a spec-document-reviewer subagent (Agent tool) with prompt:

> "Review this design specification for completeness, consistency, and clarity.
> Spec document: {full spec text}
> Check: are there gaps, contradictions, unclear sections, YAGNI violations, missing edge cases?
> Report: ✅ Approved OR ❌ Issues [list specifically what needs fixing]"

If issues → architect fixes and re-spawns. Max 3 iterations.

### 1.5 Plan quality discipline

When decomposing into tasks, each task MUST:
- Be completable in a single developer session (2–5 minutes of agent work)
- Have exact file paths (create/modify/test)
- Include exact code snippets where possible (not "add validation")
- Have expected output after verification step
- Have clear, testable acceptance criteria
- Include context from sibling tasks when order matters

### 1.6 Execution strategy

The architect's output includes an execution strategy:

```json
{
  "strategy": {
    "parallel_groups": [["T1", "T2"], ["T3", "T4"], ["T5"]],
    "model_hints": { "T1": "haiku", "T2": "sonnet", "T3": "opus" }
  }
}
```

Rules:
- Tasks in the same parallel group MUST have zero file overlap and zero depends_on between them
- Sequential groups execute in order (group 2 waits for group 1 to complete)
- Model hints: `haiku` for mechanical tasks (isolated functions, 1–2 files), `sonnet` for integration (multi-file, pattern matching), `opus` for architecture (design judgment, broad codebase)

### 1.7 Decision polling

Available throughout the architect session. Uses the existing CLI interface with a new `--wait` flag:

```bash
neo decision create "What auth strategy should we use: JWT stateless or session-based?" \
  --type approval \
  --options "jwt:JWT stateless,session:Session-based" \
  --context "Existing codebase uses express-session but no auth middleware yet" \
  --wait \
  --timeout 30m
```

Blocks until the supervisor (or a developer, or the human) responds.

---

## 2. Developer prompt — enrichment

The existing developer prompt (Protocol sections 1–6) remains unchanged. The following sections are appended.

### 2.1 Self-review checklist

Before spawning any reviewer subagent, complete this checklist:
- **Completeness**: Did I implement everything in the spec? Anything missed? Edge cases?
- **Quality**: Is this my best work? Names clear? Code clean?
- **YAGNI**: Did I build ONLY what was requested? No extras, no "while I'm here" improvements?
- **Tests**: Do tests verify real behavior, not mock behavior?
  - Anti-pattern: asserting a mock was called ≠ testing behavior
  - Anti-pattern: test-only methods in production code (destroy(), cleanup())
  - Anti-pattern: incomplete mocks that pass but miss real API surface
  - Anti-pattern: mocking without understanding side effects

Fix issues found during self-review BEFORE spawning reviewers.

### 2.2 Spawning reviewers

After self-review, spawn two sequential subagents:

**1. Spec compliance reviewer** (Agent tool):

> "You are reviewing code changes for spec compliance.
> Task requirements: {full task spec text — do NOT make the subagent read a file}
> CRITICAL: Do NOT trust the developer's self-report. Read the actual code.
> Compare implementation to requirements line by line.
> Check: everything specified implemented? Nothing missing? Nothing extra? No misunderstandings?
> Report: ✅ Spec compliant OR ❌ Issues [file:line, what's missing/extra/wrong]"

If issues → fix, re-spawn. Max 3 iterations. Spec MUST pass before code quality review.

**2. Code quality reviewer** (Agent tool, ONLY after spec compliance ✅):

> "You are reviewing code changes for quality.
> What was implemented: {summary}
> Plan/requirements: {context}
> Check: tests solid and verify behavior (not mocks), one responsibility per file, existing patterns followed, no dead code. Only flag issues in NEW changes, not pre-existing code.
> Report: Strengths, Issues (Critical/Important/Minor with file:line), Assessment"

If critical issues → fix, re-spawn. Max 3 iterations.

### 2.3 Handling review feedback

When receiving feedback from spawned reviewer subagents:

1. **READ** the full feedback without reacting
2. **VERIFY** each suggestion against the actual codebase
3. **EVALUATE**: is this technically correct for THIS code?
4. If **unclear**: ask the reviewer subagent for clarification (re-spawn with question)
5. If **wrong**: ignore with reasoning (reviewer may lack context). Note in report.
6. If **correct**: fix one item at a time, test each

Never implement feedback you haven't verified.
Never express performative agreement — just fix or push back with reasoning.

### 2.4 Systematic debugging

When tests fail or behavior is unexpected:

**Phase 1 — Root Cause Investigation** (MANDATORY before any fix):
- Read error messages completely (stack traces, line numbers, file paths)
- Reproduce consistently — can you trigger it reliably?
- Check recent changes (`git diff`)
- Trace data flow backward to source — where does the bad value originate?

**Phase 2 — Pattern Analysis:**
- Find similar working code in the codebase
- Compare working vs broken line by line
- Identify every difference, however small

**Phase 3 — Hypothesis Testing:**
- State ONE clear hypothesis: "I think X because Y"
- Make the SMALLEST possible change to test it
- Verify. If wrong → new hypothesis. Don't stack fixes.

**Phase 4 — Implementation:**
- Create a failing test case for the bug
- Fix root cause (NOT symptom)
- Verify all tests pass

**Phase 4.5 — If 3+ fixes failed:**
STOP. This is likely an architectural problem, not a bug.
```bash
neo decision create "Architectural issue after 3+ failed fixes" \
  --type approval \
  --context "What was tried: {list}. What failed: {list}. Pattern: each fix reveals new problem elsewhere." \
  --wait --timeout 30m
```

### 2.5 Verification before completion

**IRON LAW: No completion claims without fresh verification evidence.**
Violating the letter of this rule IS violating the spirit.

Gate function — before reporting ANY status:

1. **IDENTIFY**: What command proves this claim?
2. **RUN**: Execute it NOW (fresh, not cached from earlier)
3. **READ**: Full output, exit code, failure count
4. **VERIFY**: Does output actually confirm the claim?
5. **ONLY THEN**: Report status WITH the evidence

| Claim | Requires | NOT sufficient |
|-------|----------|----------------|
| "Tests pass" | Test command output: 0 failures | "should pass", previous run |
| "Build clean" | Build command: exit 0 | Linter passing |
| "Bug fixed" | Original symptom test: passes | "code changed" |
| "Spec complete" | Line-by-line spec check done | "tests pass" |

Red flags in your own output — if you catch yourself writing these, STOP and run verification first:
- "should", "probably", "seems to", "looks good"
- "done!", "fixed!", "all good"
- Any satisfaction expressed before running verification commands

### 2.6 Decision polling (when blocked)

DO NOT guess. DO NOT proceed with assumptions.
```bash
neo decision create "What I need answered" \
  --type approval \
  --context "Full context: what you need, what you tried, what's unclear" \
  --wait --timeout 30m
```
This blocks until the supervisor responds. Resume work based on the response.

### 2.7 Status protocol

Report status as one of:
- **DONE** — all acceptance criteria met, tests passing (with evidence in output), committed
- **DONE_WITH_CONCERNS** — completed but flagging potential issues:
  - File growing beyond 300 lines (architectural signal)
  - Design decisions the plan didn't specify
  - Edge cases suspected but not confirmed
  - Implementation required assumptions not in spec
- **BLOCKED** — cannot proceed. Describe specifically what's blocking and why. Include what was tried.
- **NEEDS_CONTEXT** — spec is unclear or incomplete. List specific questions that must be answered.

Add to JSON output:
```json
{
  "status": "DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT",
  "concerns": ["..."],
  "evidence": { "command": "pnpm test", "exit_code": 0, "summary": "34/34 passing" }
}
```

---

## 3. Reviewer prompt — enrichment

The existing 5-lens review remains. The following changes are made.

### 3.1 Two-pass structure

**PASS 1 — Spec Compliance** (do this FIRST):

Read the spec document (`.neo/specs/{ticket-id}-design.md`) or task prompt. Compare against implementation:
- Does it implement EVERYTHING specified? (nothing missing)
- Does it implement ONLY what's specified? (nothing extra)
- Are acceptance criteria from the spec met?
- Flag deviations as CRITICAL issues

Do NOT trust the developer's report — read the actual code and compare to spec line by line.

If spec compliance fails → verdict is CHANGES_REQUESTED. Stop here and report.

**PASS 2 — Code Quality** (only after spec compliance passes):

Apply the existing 5-lens review (quality, standards, security, performance, coverage).

### 3.2 Output change

Add to JSON output:
```json
{
  "spec_compliance": "PASS | FAIL",
  "spec_deviations": [
    { "type": "missing | extra | misunderstood", "file": "src/path.ts", "description": "..." }
  ]
}
```

Verdict logic: spec compliance FAIL → CHANGES_REQUESTED (always, regardless of code quality).

---

## 4. `neo decision create --wait` — blocking poll mechanism

### 4.1 CLI behavior

Uses the existing `neo decision create` interface with two new flags (`--wait`, `--timeout`):

```bash
neo decision create "Question for supervisor or human" \
  --type approval \
  --options "yes:Approve,no:Reject" \
  --context "Detailed context for the decision maker" \
  [--default yes] \
  [--expires-in 1h] \
  --wait \
  [--timeout 30m]
```

The existing positional argument (`question`), `--type`, `--options`, `--context`, `--default`, and `--expires-in` flags are unchanged. Two new flags:

- `--wait` — after creating the decision, poll until answered (instead of returning immediately)
- `--timeout <duration>` — max wait time (default 30min). On timeout: exit 1 with message.

Poll mechanism:
1. Creates the decision (same as current)
2. Polls decision status every 10 seconds via the store
3. When `status === "answered"` → prints the answer text and returns (exit 0)
4. On timeout → prints timeout message (exit 1). Agent decides to escalate or continue.

Implementation: `setInterval` poll loop in the CLI command handler. No SDK changes needed.

### 4.2 Prerequisite: `neo decision get <id>`

Verify this command exists. If not, implement it — returns decision status and answer. Required for the poll loop.

### 4.3 Supervisor decision routing (prompt addition)

```
When a pending decision arrives from an agent:

1. Can you answer directly? (strategic question, scope, priority, simple context)
   → neo decision answer <id> <answer>

2. Needs codebase investigation? (technical question about existing code)
   → Dispatch a scout to investigate (already readonly with Read, Glob, Grep, Bash)
   → Read the run output
   → neo decision answer <id> with findings

3. Needs human input? (autoDecide: false, or genuinely uncertain)
   → Log it and wait for human response

IMPORTANT: An agent is BLOCKED waiting. Answer within 1–2 heartbeats.
Stale decisions waste agent session budget (the agent's clock is ticking).
```

---

## 5. Session configuration changes

### 5.1 maxTurns per agent (YAML defaults)

| Agent | maxTurns | Justification |
|-------|----------|---------------|
| architect | 75 | Explore + design + spawn spec-reviewer + fix loops |
| developer | 100 | Implement + spawn 2 reviewers + fix loops + verify |
| reviewer | 30 | Single-pass review, no subagents |
| scout | 50 | Deep exploration, many tool calls |

These are YAML defaults — overridable via `.neo/agents/{name}.yml` per repo.

### 5.2 Agent tool addition

```yaml
# architect.yml — add Agent to tools
tools: [Read, Glob, Grep, WebSearch, WebFetch, Agent]

# developer.yml — add Agent to tools
tools: [Read, Write, Edit, Bash, Glob, Grep, Agent]
```

Developer subagents spawned via the `Agent` tool inherit the parent's `cwd` by default (SDK behavior — the subagent runs in the same working directory). This means subagents see the developer's isolated git clone with all modifications in progress.

Subagent prompt templates (spec-compliance-reviewer, code-quality-reviewer, spec-document-reviewer) are **inline in the parent agent's `.md` prompt file** — not separate YAML agents. The developer/architect prompt contains the exact text to pass to the `Agent` tool. This keeps the templates co-located with the discipline that uses them.

### 5.3 Session runner change

Uncomment `maxTurns` pass-through in `buildQueryOptions` (session.ts, line ~60). The line already exists but is commented out:
```typescript
// maxTurns: agent.maxTurns,  →  maxTurns: agent.maxTurns,
```

This was disabled during early development when agents had no per-role maxTurns defaults. Now safe to enable since agent YAML configs will set appropriate limits (75–100 for long sessions, 20–50 for short ones). The SDK accepts `maxTurns` in query options natively.

**When maxTurns is reached:** The SDK terminates the session with a `result` message of subtype `error_max_turns`. The agent's last output is preserved. The session runner already handles this as a non-retryable error. For developer sessions, this means partial work may be committed but the final status report may be missing — the supervisor should treat `error_max_turns` as `BLOCKED` and re-dispatch if needed.

---

## 6. Supervisor workflow — simplified

### 6.1 Dispatch pipeline

```
Ticket arrives (webhook, message, task memory)
  │
  ├─ 1. Architect (handles triage + design + plan)
  │     ├─ Score < 2 → escalate
  │     ├─ Score 2-3 → decision poll for clarifications
  │     ├─ Score 4-5 → design + spec + plan + execution strategy
  │     └─ Spawns spec-reviewer subagent internally
  │
  ├─ 2. Supervisor analyzes execution strategy
  │     ├─ Verify no file overlap in parallel groups
  │     ├─ Dispatch developers per parallel group
  │     └─ Choose model per task (architect's model_hints)
  │
  ├─ 3. Developers report back
  │     ├─ DONE → mark task done, proceed to next group
  │     ├─ DONE_WITH_CONCERNS → evaluate concerns, decide
  │     ├─ BLOCKED → route via decision system
  │     └─ NEEDS_CONTEXT → provide context, re-dispatch
  │
  ├─ 4. All developers done
  │     ├─ Full test suite on branch
  │     ├─ Reviewer standalone (if supervisor judges necessary)
  │     └─ Re-dispatch developer with feedback (if issues)
  │
  └─ 5. Push + PR
```

### 6.2 What the supervisor no longer does

- Dispatch reviewer after every developer (developer handles review internally)
- Dispatch fixer (re-dispatch developer instead)
- Manage review → fix → re-review cycle (internal to developer session)
- Run refiner before architect (architect handles triage)

### 6.3 Parallel dispatch guardrails (prompt addition)

```
Before dispatching tasks in parallel, verify:
1. No file overlap between parallel tasks (check architect's plan)
2. No depends_on between parallel tasks
3. All tasks in a parallel group target the same branch

After ALL parallel tasks in a group complete:
1. Run full test suite on the branch
2. If conflicts or test failures → dispatch developer to resolve
3. Only then proceed to next group or final review
```

---

## 7. Configurable disciplines

### 7.1 TDD — NOT mandatory by default

TDD (RED-GREEN-REFACTOR) is available as a discipline but not enforced by default. Repos can enable it via `.neo/INSTRUCTIONS.md`:

```markdown
## Testing discipline
Use TDD for all implementation: write failing test first, then minimal code, then refactor.
```

The developer prompt references TDD as a recommended practice, not an iron law.

### 7.2 Mandatory disciplines (non-configurable)

These are always active regardless of repo config:
- **Verification-before-completion** — evidence before claims
- **Systematic debugging** — root cause before fixes
- **Self-review before spawning reviewers** — completeness, YAGNI, test quality
- **Spec compliance before code quality** — review order enforced
- **Decision polling when blocked** — don't guess, ask

---

## 8. Files to modify

### Prompts (packages/agents/prompts/)

| File | Action |
|------|--------|
| `architect.md` | Rewrite — add triage, design-first, spec document, plan discipline, execution strategy, spec-reviewer spawning, decision polling |
| `developer.md` | Major enrichment — add self-review, reviewer spawning, handling feedback, systematic debugging, verification-before-completion, decision polling, status protocol |
| `reviewer.md` | Enrichment — add 2-pass structure (spec compliance → code quality), output change |
| `fixer.md` | Delete |
| `refiner.md` | Delete |
| `scout.md` | Unchanged |

### Agent YAML (packages/agents/agents/)

| File | Change |
|------|--------|
| `architect.yml` | Add `Agent` to tools, set `maxTurns: 75` |
| `developer.yml` | Add `Agent` to tools, set `maxTurns: 100` |
| `reviewer.yml` | Set `maxTurns: 30` |
| `fixer.yml` | Delete |
| `refiner.yml` | Delete |
| `scout.yml` | Set `maxTurns: 50` |

### Core engine (packages/core/src/)

| File | Change |
|------|--------|
| `runner/session.ts` | Uncomment `maxTurns` pass-through to `sdk.query()` (line ~60, already present but commented out). This was disabled during early development — now safe to enable since agent YAML configs will set appropriate per-role limits. |

Note: `agents/loader.ts` and `agents/resolver.ts` are generic (scan directory dynamically) — no code changes needed. Removing fixer/refiner is purely a file deletion.

### Tests (packages/core/src/__tests__/)

| File | Change |
|------|--------|
| `agents.test.ts` | Update built-in agent list assertions (remove fixer, refiner) |
| `e2e.test.ts` | Remove or update fixer/refiner test scenarios |

### CLI

| Command | Change |
|---------|--------|
| `neo decision create` | Add `--wait` flag (poll loop, 10s interval) + `--timeout` flag (default 30min) |
| `neo decision get <id>` | Verify exists, implement if missing |

### Supervisor prompt (packages/core/src/supervisor/prompt-builder.ts)

| Section | Change |
|---------|--------|
| `OPERATING_PRINCIPLES` | Add decision routing rules, parallel dispatch guardrails |
| `HEARTBEAT_RULES` | Add DECISIONS step between EVENTS and DISPATCH |

### Supervisor domain knowledge (packages/agents/SUPERVISOR.md)

This file is the supervisor's reference for agent contracts, dispatch patterns, and pipeline state machine. Major rewrite needed:

| Section | Change |
|---------|--------|
| **Available Agents** table | Remove `fixer` and `refiner` rows. Update `architect` description to include triage. Update `developer` description to include self-review + subagent spawning. |
| **Agent Output Contracts** | Remove `fixer →` and `refiner →` sections. Update `developer →` to use new status protocol (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT). Update `architect →` to include `strategy` field (parallel_groups, model_hints). Update `reviewer →` to include `spec_compliance` field. |
| **Routing table** (§2) | Remove "Dispatch refiner" row. Change "Unclear criteria or vague scope" → "Dispatch architect (handles triage)". Remove fixer from all dispatch flows. |
| **On Refiner Completion** (§3) | Delete entire section |
| **On Developer/Fixer Completion** (§4, §5) | Rename to "On Developer Completion". Remove fixer references. Add handling for DONE_WITH_CONCERNS and NEEDS_CONTEXT statuses. |
| **On Review Completion** (§6) | Change "dispatch fixer" → "re-dispatch developer with review feedback as context" |
| **On Fixer Completion** (§7) | Delete entire section |
| **Pipeline State Machine** | Simplify: remove "fixing" state. Changes requested → re-dispatch developer on same branch. |
| **Dispatch examples** | Remove fixer example. Update routing to show architect handling vague tickets. Add example with `--model` override for model_hints. |
| **Anti-Loop Guard** | Change "fixer→review cycles" → "developer re-dispatch cycles" |
| **Idle Behavior** | Remove all fixer/refiner references from missed dispatch checks. Add: check for pending decisions not yet answered. |
| **NEW: Execution Strategy** | Add section: how supervisor interprets architect's `parallel_groups` and `model_hints`, dispatches developer groups, verifies file overlap. |
| **NEW: Decision Routing** | Add section: how supervisor handles pending decisions (direct answer, scout investigation, human escalation). |

---

## 9. Migration notes

- Repos with custom `.neo/agents/fixer.yml` or `.neo/agents/refiner.yml` extensions: these will no longer match a built-in. They become standalone custom agents (still functional, just not part of the default pipeline).
- Repos with `.neo/INSTRUCTIONS.md` referencing fixer/refiner by name: update documentation.
- The `neo decision create --wait` command is new CLI surface — no breaking change.
- `maxTurns` in agent YAML already exists in the schema and resolver — the session runner line is commented out (session.ts:~60), just needs uncommenting.
- `model_hints` in execution strategy: the supervisor passes the model to `neo run --model` (or equivalent). This requires the `neo run` command to accept a `--model` override — verify this exists or add it.

## 10. Out of scope

- Visual companion (neo has no interactive UI)
- Git worktree system (neo uses git clone isolation, already in place)
- Finishing-a-development-branch workflow (supervisor controls this, not the agent)
- Writing-skills meta-skill (meta concern, not needed for v1)
- TDD as mandatory default (explicitly configurable, not enforced)
