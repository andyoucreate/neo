# Neo Surpuissant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make neo agents unstoppable — no maxTurns limits, plan resumption after crash, proactive CI monitoring, mandatory decision creation when blocked, and strict task/run hygiene.

**Architecture:** Five independent improvements across agent YAML configs, core recovery logic, developer prompt (crash resumption), and supervisor prompt-builder (CI proactive monitoring + decision enforcement + task hygiene). No new infrastructure — changes are confined to existing files.

**Tech Stack:** TypeScript, Zod, YAML (agent configs), Markdown (prompts)

---

## File Map

| File | Change |
|------|--------|
| `packages/agents/agents/developer.yml` | Remove `maxTurns: 200` |
| `packages/agents/agents/scout.yml` | Remove `maxTurns: 50` |
| `packages/agents/agents/reviewer.yml` | Remove `maxTurns: 30` |
| `packages/agents/agents/architect.yml` | Remove `maxTurns: 100` |
| `packages/core/src/runner/recovery.ts` | Remove `"error_max_turns"` from `DEFAULT_NON_RETRYABLE` |
| `packages/agents/prompts/developer.md` | Add plan-mode crash detection + resumption section |
| `packages/core/src/supervisor/prompt-builder.ts` | Strengthen heartbeat CI audit + decision enforcement + task/run linkage rules |
| `packages/agents/SUPERVISOR.md` | Add proactive CI protocol + decision creation rules + task/run linkage contract |

---

### Task 1: Remove maxTurns from all agent YAMLs and recovery

**Files:**
- Modify: `packages/agents/agents/developer.yml`
- Modify: `packages/agents/agents/scout.yml`
- Modify: `packages/agents/agents/reviewer.yml`
- Modify: `packages/agents/agents/architect.yml`
- Modify: `packages/core/src/runner/recovery.ts`

- [ ] **Step 1: Remove `maxTurns` from developer.yml**

Current content of `packages/agents/agents/developer.yml` line 13: `maxTurns: 200`

Remove that line entirely. The file should go from:
```yaml
name: developer
description: "Executes implementation plans step by step or direct tasks in an isolated git clone. Spawns spec-reviewer and code-quality-reviewer subagents."
model: opus
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
sandbox: writable
maxTurns: 200
prompt: ../prompts/developer.md
```
To:
```yaml
name: developer
description: "Executes implementation plans step by step or direct tasks in an isolated git clone. Spawns spec-reviewer and code-quality-reviewer subagents."
model: opus
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
sandbox: writable
prompt: ../prompts/developer.md
```

- [ ] **Step 2: Remove `maxTurns` from scout.yml**

Remove `maxTurns: 50` from `packages/agents/agents/scout.yml`.

- [ ] **Step 3: Remove `maxTurns` from reviewer.yml**

Remove `maxTurns: 30` from `packages/agents/agents/reviewer.yml`.

- [ ] **Step 4: Remove `maxTurns` from architect.yml**

Remove `maxTurns: 100` from `packages/agents/agents/architect.yml`.

- [ ] **Step 5: Remove `error_max_turns` from DEFAULT_NON_RETRYABLE**

In `packages/core/src/runner/recovery.ts` line 60, change:
```ts
const DEFAULT_NON_RETRYABLE = ["error_max_turns", "budget_exceeded"];
```
To:
```ts
const DEFAULT_NON_RETRYABLE = ["budget_exceeded"];
```

`error_max_turns` no longer happens (no maxTurns set), but removing it from non-retryable means if the SDK ever emits it, recovery will retry rather than fail immediately.

- [ ] **Step 6: Verify agent schema still accepts absent maxTurns**

Run:
```bash
cd /Users/karl/Documents/neo && pnpm typecheck 2>&1 | head -30
```
Expected: no errors related to `maxTurns`.

- [ ] **Step 7: Run tests**

```bash
cd /Users/karl/Documents/neo && pnpm test 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/agents/agents/developer.yml packages/agents/agents/scout.yml packages/agents/agents/reviewer.yml packages/agents/agents/architect.yml packages/core/src/runner/recovery.ts
git commit -m "feat(agents): remove maxTurns limits — agents run until task complete or budget exceeded

Generated with [neo](https://neotx.dev)"
```

---

### Task 2: Plan-mode crash resumption in developer prompt

**Files:**
- Modify: `packages/agents/prompts/developer.md`

The developer currently has no logic to detect that it's resuming a crashed run. When the supervisor relaunches with a prompt like "Previous run failed at T3 — resume from T3", the developer needs to handle this explicitly.

- [ ] **Step 1: Read the current developer.md Plan Mode section**

Read `packages/agents/prompts/developer.md` lines 1-100 to understand the exact structure of the Plan Mode section before editing.

- [ ] **Step 2: Add crash resumption section to Plan Mode**

In `packages/agents/prompts/developer.md`, after the `## Mode Detection` section and before `## Pre-Flight`, add a new section:

```markdown
## Crash Resumption Detection

Before Pre-Flight, check if the prompt contains a `RESUMING FROM CRASH` header:

```
RESUMING FROM CRASH
Previous run: <runId>
Completed tasks: <T1, T2, ...> (commits: <sha1>, <sha2>, ...)
Failed at: <Tn> — error: <error message>
Resume: start from <Tn>, skip completed tasks above.
```

If this header is present:
1. **Do not re-execute completed tasks.** They are already committed on the branch.
2. **Verify completed commits exist:** `git log --oneline` — confirm the listed commits are present.
3. **If commits are missing** (branch diverged or reset): report BLOCKED immediately, do not guess.
4. **Start at the failed task** — read its spec from the plan file, understand the error, try a different approach.
5. **Log the resumption:** `neo log milestone "Resuming from crash at <Tn> — skipping T1..T(n-1)"`
```

- [ ] **Step 3: Add checkpoint logging rule in Plan Mode Execute section**

In the `### 2. Execute Tasks` section, after step **f. Commit**, add:

```markdown
**g. Checkpoint** — after each successful commit, log progress so the supervisor can reconstruct state on crash:
```bash
neo log milestone "T{n} done — commit {sha}"
```
This checkpoint is the supervisor's source of truth for crash resumption.
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/karl/Documents/neo && pnpm test 2>&1 | tail -10
```
Expected: all tests pass (no TypeScript touches, prompt changes don't affect tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/prompts/developer.md
git commit -m "feat(agents): add crash resumption protocol to developer prompt

When supervisor relaunches with RESUMING FROM CRASH header, developer
skips completed tasks and resumes at the failed task with error context.
Checkpoints logged after each commit for supervisor reconstruction.

Generated with [neo](https://neotx.dev)"
```

---

### Task 3: Supervisor crash resumption protocol in SUPERVISOR.md

**Files:**
- Modify: `packages/agents/SUPERVISOR.md`

The supervisor needs a concrete protocol: when a developer run fails mid-plan, reconstruct which tasks completed (from git log + neo logs), then relaunch with the `RESUMING FROM CRASH` header.

- [ ] **Step 1: Read the current SUPERVISOR.md developer completion section**

Read `packages/agents/SUPERVISOR.md` lines 38-65 (the `### developer → status + branch_completion` section) to understand the current failure handling.

- [ ] **Step 2: Add crash resumption protocol after developer failure handling**

In `packages/agents/SUPERVISOR.md`, in the `### developer → status + branch_completion` section, add after the existing status routing table:

```markdown
### Crash Resumption Protocol

When a developer run **fails** on a plan-mode task (run `status: "failed"`, error contains `error_max_turns` or any runtime crash):

**Step 1 — Reconstruct completed tasks:**
```bash
# Read the neo logs for the failed run to find checkpoints
neo logs <failedRunId> 2>&1 | grep "milestone"
# Cross-check with git log on the branch
git -C <repoPath> log --oneline <branch> 2>&1 | head -20
```

**Step 2 — Build resumption context:**
From the logs, identify:
- Which tasks have a "done — commit <sha>" milestone → completed
- Which task has no milestone or an error → failed task

**Step 3 — Relaunch with RESUMING FROM CRASH header:**
```bash
neo run developer \
  --prompt "RESUMING FROM CRASH
Previous run: <failedRunId>
Completed tasks: T1 (commit abc1234), T2 (commit def5678)
Failed at: T3 — error: <last error from logs>
Resume: start from T3, skip completed tasks above.

Original task:
Execute the implementation plan at .neo/specs/<plan>.md. Create a PR when all tasks pass." \
  --repo <repoPath> \
  --branch <sameBranch> \
  --meta '{"ticketId":"<id>","stage":"develop","resumedFrom":"<failedRunId>"}'
```

**Rules:**
- Always use the **same branch** — completed commits are already there
- Max 3 resumption attempts per plan — on 3rd failure, create a decision for human
- Never resume if the branch has diverged (commits missing from git log) — create a decision instead
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/karl/Documents/neo && pnpm test 2>&1 | tail -10
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/SUPERVISOR.md
git commit -m "feat(agents): add crash resumption protocol to supervisor

Supervisor reconstructs completed tasks from neo logs on developer failure,
then relaunches with RESUMING FROM CRASH context. Max 3 resumption attempts
before escalating to human decision.

Generated with [neo](https://neotx.dev)"
```

---

### Task 4: Proactive CI monitoring in prompt-builder.ts

**Files:**
- Modify: `packages/core/src/supervisor/prompt-builder.ts`

The current heartbeat step 5 says "check CI (`gh pr checks`)" but gives no systematic protocol. We need a named CI audit block that the supervisor runs every heartbeat.

- [ ] **Step 1: Read current HEARTBEAT_RULES constant**

Read `packages/core/src/supervisor/prompt-builder.ts` lines 140-185 to see the exact `HEARTBEAT_RULES` constant.

- [ ] **Step 2: Replace step 5 with a proactive CI audit block**

In the `HEARTBEAT_RULES` constant in `packages/core/src/supervisor/prompt-builder.ts`, replace:

```
5. FOLLOW-UPS? — check CI (\`gh pr checks\`), deferred dispatches.
5b. DECISIONS? — check \`neo decision list\` for pending decisions from agents. Route each: answer directly, dispatch scout to investigate, or wait for human. Agents are blocked waiting — prioritize these.
```

With:

```
5. CI AUDIT — for every open PR across all repos, run:
   \`gh pr list --repo <repo> --json number,headRefName,title,statusCheckRollup --state open\`
   Then for each PR:
   - CI **failed** + no active developer run on that branch → re-dispatch developer with CI error context
   - CI **passed** + no active reviewer run + no reviewer dispatched this cycle → dispatch reviewer
   - CI **pending** → log and skip (check next heartbeat)
   - PR has \`CHANGES_REQUESTED\` verdict + no active developer run → re-dispatch developer with review feedback (check anti-loop guard first)
   Never leave a PR orphaned: every open PR must have either an active run or a clear status.
5b. DECISIONS — check \`neo decision list\` for pending decisions. **Prioritize above dispatch.** Agents are BLOCKED waiting — stale decisions waste budget. Route each: answer directly if scope/strategy, dispatch scout if needs codebase context, escalate to human if genuinely uncertain.
```

- [ ] **Step 3: Verify the file compiles**

```bash
cd /Users/karl/Documents/neo && pnpm typecheck 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
cd /Users/karl/Documents/neo && pnpm test 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/prompt-builder.ts
git commit -m "feat(supervisor): add proactive CI audit to heartbeat lifecycle

Every heartbeat: enumerate all open PRs, dispatch developer on CI failure,
dispatch reviewer on CI pass, re-dispatch developer on CHANGES_REQUESTED.
No PR left orphaned between heartbeats.

Generated with [neo](https://neotx.dev)"
```

---

### Task 5: Decision creation enforcement + task/run linkage in prompt-builder.ts and SUPERVISOR.md

**Files:**
- Modify: `packages/core/src/supervisor/prompt-builder.ts`
- Modify: `packages/agents/SUPERVISOR.md`

Two rules to enforce:
1. When blocked with no pending decision → create one
2. Every dispatched run must have a linked task

- [ ] **Step 1: Read OPERATING_PRINCIPLES constant**

Read `packages/core/src/supervisor/prompt-builder.ts` lines 48-70 to see the exact `OPERATING_PRINCIPLES` constant.

- [ ] **Step 2: Add decision creation enforcement to OPERATING_PRINCIPLES**

In `packages/core/src/supervisor/prompt-builder.ts`, in the `OPERATING_PRINCIPLES` constant, after the line:
```
- **Decision routing**: when a pending decision arrives from an agent, answer within 1-2 heartbeats. Route: (1) answer directly if strategic/scope/priority, (2) dispatch scout to investigate if codebase context needed, (3) wait for human if autoDecide is off or genuinely uncertain. Agents are BLOCKED waiting — stale decisions waste session budget.
```

Add:
```
- **Decision creation (mandatory)**: when the supervisor cannot proceed without human input — ambiguous scope, conflicting requirements, unknown target repo, task failed 3+ times — it MUST create a decision immediately:
  \`neo decision create "<clear question>" --options "key1:label1,key2:label2" --expires-in 24h --context "<why this matters>"\`
  Staying silent or guessing when uncertain is NEVER acceptable. If you don't know → ask.
- **Task/run linkage (mandatory)**: EVERY \`neo run\` dispatch MUST have a corresponding task in \`in_progress\` state. Before dispatching:
  1. Check if a task exists: \`neo task list --status pending,in_progress\`
  2. If no matching task → create one first: \`neo task create --scope <repo> --priority <p> --initiative <name> "<description>"\`
  3. Update it: \`neo task update <id> --status in_progress\` with \`--context "neo runs <runId>"\` after dispatch
  A run without a task is an orphan — it cannot be tracked, resumed, or escalated.
```

- [ ] **Step 3: Add task/run linkage contract to SUPERVISOR.md dispatch examples**

In `packages/agents/SUPERVISOR.md`, in the `### Examples` section after the existing bash examples, add:

```markdown
### Task/Run Linkage — Mandatory Protocol

Every dispatch follows this sequence:

```bash
# 1. Create or identify the task
neo task create --scope /path/to/repo --priority high --initiative auth-v2 "T1: Implement JWT middleware"
# → returns: mem_abc123

# 2. Dispatch the run
neo run developer --prompt "..." --repo /path --branch feat/auth --meta '{"ticketId":"T1","stage":"develop"}'
# → returns: run-uuid-here

# 3. Link run to task immediately
neo task update mem_abc123 --status in_progress
# (use --context "neo runs run-uuid-here" when neo task supports it)
```

**On run completion:**
```bash
neo task update mem_abc123 --status done       # if run succeeded
neo task update mem_abc123 --status blocked    # if run failed
```

**Never dispatch without a task. Never leave a failed run's task as `in_progress`.**
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/karl/Documents/neo && pnpm test 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/prompt-builder.ts packages/agents/SUPERVISOR.md
git commit -m "feat(supervisor): enforce decision creation and task/run linkage

Supervisor must create decisions when blocked rather than guessing.
Every neo run dispatch requires a linked task in in_progress state.
No silent stalls, no orphaned runs.

Generated with [neo](https://neotx.dev)"
```

---

### Task 6: Full validation pass + PR

**Files:** None (validation only)

- [ ] **Step 1: Full build + typecheck + test**

```bash
cd /Users/karl/Documents/neo && pnpm build && pnpm typecheck && pnpm test 2>&1 | tail -30
```
Expected: build succeeds, 0 type errors, all tests pass.

- [ ] **Step 2: Verify all maxTurns removed**

```bash
grep -rn "maxTurns" packages/agents/agents/ 2>&1
```
Expected: no output (all `maxTurns` lines removed from YAMLs).

- [ ] **Step 3: Verify error_max_turns removed from non-retryable**

```bash
grep -n "error_max_turns" packages/core/src/runner/recovery.ts
```
Expected: no output.

- [ ] **Step 4: Verify RESUMING FROM CRASH in developer prompt**

```bash
grep -n "RESUMING FROM CRASH" packages/agents/prompts/developer.md
```
Expected: at least 2 matches (section header + example header).

- [ ] **Step 5: Verify CI audit in prompt-builder**

```bash
grep -n "CI AUDIT" packages/core/src/supervisor/prompt-builder.ts
```
Expected: 1 match.

- [ ] **Step 6: Create PR**

```bash
git push -u origin feat/neo-surpuissant
gh pr create \
  --title "feat(neo): unstoppable agents — no maxTurns, crash resumption, proactive CI, decision enforcement" \
  --body "## Summary

- Remove all \`maxTurns\` limits from agent YAMLs (developer, scout, reviewer, architect) — agents run until task complete or budget exceeded
- Remove \`error_max_turns\` from non-retryable errors in recovery
- Developer prompt: crash resumption protocol — detects \`RESUMING FROM CRASH\` header, verifies completed commits, resumes at failed task
- Developer prompt: checkpoint logging after each task commit
- Supervisor: crash resumption protocol — reconstructs completed tasks from logs, relaunches developer with context
- Supervisor heartbeat: proactive CI audit every heartbeat — no open PR left orphaned
- Supervisor: mandatory decision creation when blocked — no silent stalls
- Supervisor: mandatory task/run linkage — every dispatch has a task

## Test plan
- [ ] All existing tests pass
- [ ] No maxTurns in any agent YAML
- [ ] error_max_turns not in DEFAULT_NON_RETRYABLE
- [ ] RESUMING FROM CRASH section present in developer.md
- [ ] CI AUDIT step present in heartbeat lifecycle

🤖 Generated with [neo](https://neotx.dev)"
```
