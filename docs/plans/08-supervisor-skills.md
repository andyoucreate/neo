# Neo — Supervisor Skills

Claude Code skills that teach the supervisor how to use neo effectively. These ship with `neotx` and are installed into the user's Claude Code environment when they run `neo init`.

> **Status (NEO-DOCS initiative):**
> - ✅ M1: Supervisor file clarification — DONE (SUPERVISOR.md header, SKILL.md header, architecture doc)
> - ✅ M1b: neo-recover consolidation — DONE (full skill content in skills/neo-recover/SKILL.md)
> - 🔄 M2: README sync — IN PROGRESS (agents README updated, root README synced, this doc is T2.3)
> - ⏳ M3-M5: Remaining documentation tasks — PENDING

## Why Skills?

When a human (or an AI agent acting as supervisor) drives neo via the CLI, they need to know:
- Which commands exist and what flags they accept
- How to inspect a run before deciding to continue
- When to use `--retry` and recovery strategies
- How to debug a stuck or failed run

Skills embed this knowledge directly into the Claude Code context, so the supervisor gets guidance without leaving the terminal.

## Installation

`neo init` installs skills into the project's `.claude/skills/` directory:

```
.claude/skills/
├── neo-run.md            # Running workflows
├── neo-inspect.md        # Inspecting runs and outputs
├── neo-recover.md        # Recovery and retry strategies
├── neo-agents.md         # Managing and configuring agents
├── neo-workflows.md      # Defining workflows
├── neo-gate.md           # Gate approval/rejection
└── neo-troubleshoot.md   # Diagnosing common failures
```

The skills reference the project's `.neo/config.yml` for context-aware suggestions (e.g., which agents are available, what workflows are defined).

---

## Skill: `/neo-run` — Running Workflows

**Trigger:** User wants to dispatch a workflow, run a step, or resume a run.

```markdown
# neo run — Workflow Execution

## Quick Start

# Run a full workflow
neo run feature --repo . --prompt "Add OAuth2 login with Google"

# Run a single step (plan only, then stop)
neo run feature --step plan --repo . --prompt "Add OAuth2 login"

# Resume from a specific step
neo run feature --run-id <id> --from implement

# Retry a failed step
neo run feature --run-id <id> --retry implement

## Flags

| Flag | Description |
|------|-------------|
| `--repo <path>` | Target repository (default: `.`) |
| `--prompt <text>` | Task description for the agent |
| `--step <name>` | Run only this step, then persist and exit |
| `--from <name>` | Resume: run this step + all downstream |
| `--retry <name>` | Re-run a failed step with the same prompt |
| `--run-id <id>` | Continue an existing run |
| `--meta <key>=<value>` | Attach metadata (repeatable) |
| `--output json` | Machine-readable output |

## Typical Flow

1. `neo run feature --step plan --prompt "..."` → get run-id
2. `neo runs <run-id> --step plan` → inspect the plan
3. `neo gate approve <run-id> approve-plan` → approve
4. `neo run feature --run-id <run-id> --from implement` → continue
5. `neo runs <run-id>` → check final status
```

---

## Skill: `/neo-inspect` — Inspecting Runs

**Trigger:** User wants to check run status, view step outputs, or list runs.

```markdown
# neo inspect — Run Inspection

## List all runs
neo runs
neo runs --status paused          # filter by status
neo runs --workflow feature       # filter by workflow
neo runs --filter ticket=NEO-42   # filter by metadata

## Inspect a specific run
neo runs <run-id>                 # full run state
neo runs <run-id> --step plan     # step output only
neo runs <run-id> --output json   # machine-readable

## Run states

| Status | Meaning |
|--------|---------|
| `running` | Steps are actively executing |
| `paused` | Stopped at a gate or after --step |
| `completed` | All steps finished successfully |
| `failed` | A step failed and retries exhausted |

## Step states

| Status | Meaning |
|--------|---------|
| `pending` | Not yet executed |
| `running` | Currently executing |
| `success` | Completed successfully |
| `failure` | Failed (check error output) |
| `skipped` | Skipped (condition not met or upstream rejected) |
| `waiting` | Gate waiting for approval |

## Reading step output

The step output depends on the agent:
- **architect**: structured plan with tasks array
- **developer**: raw text (commit summary, files changed)
- **reviewer**: findings with severity and suggestions
- **fixer**: raw text (what was fixed)
- **refiner**: ticket evaluation and decomposition

If the step has an `outputSchema`, the output is parsed and validated JSON.
```

---

## Skill: `/neo-recover` — Recovery Strategies

**Trigger:** User has a failed or stuck run and needs to recover.

> **Note:** The full skill content is maintained in `skills/neo-recover/SKILL.md`.
> This section provides the design overview; see the skill file for the complete reference.

Key concepts covered by this skill:
- 3-level recovery strategy (normal → resume session → fresh session)
- Diagnosis commands (`neo runs`, `neo logs`)
- Common failures: looping, rate limits, budget, invalid output, git conflicts, timeouts
- Per-step recovery configuration in workflow YAML
- Nuclear option (`neo kill`) for stuck sessions

See also: ADR-020 (Three-level recovery strategy) and ADR-021 (Per-step recovery configuration) in `07-decisions.md`.

---

## Skill: `/neo-agents` — Agent Management

**Trigger:** User wants to list, configure, or create agents.

```markdown
# neo agents — Agent Management

## List available agents
neo agents                    # all resolved agents (built-in + custom)
neo agents --output json      # machine-readable

## Built-in agents

| Agent | Role | Sandbox |
|-------|------|---------|
| `architect` | Plans implementation, produces task breakdown | readonly |
| `developer` | Implements code changes | writable |
| `reviewer` | Single-pass code review (quality, security, performance, coverage) | readonly |
| `fixer` | Fixes issues found by reviewers | writable |
| `refiner` | Evaluates and decomposes tickets | readonly |

## Extending a built-in agent

Create `.neo/agents/<name>.yml`:

```yaml
# .neo/agents/developer.yml — tweak the built-in developer
extends: developer
model: sonnet               # cheaper model
maxTurns: 50                # more turns
tools:
  - $inherited              # keep all built-in tools
  - WebSearch               # add web search
promptAppend: |
  Always write tests for new functions.
  Use Prisma for database access.
```

## Creating a new agent

```yaml
# .neo/agents/e2e-tester.yml
name: e2e-tester
description: "Runs and fixes e2e tests"
model: sonnet
tools: [Read, Write, Edit, Bash, Glob, Grep]
sandbox: writable
prompt: e2e-tester.md        # prompt file in same directory
```

## Key concepts

- `extends`: inherit from a built-in, override only what you need
- `$inherited`: in tools array, means "keep parent's tools + add mine"
- `promptAppend`: add text to the end of the inherited prompt (don't replace it)
- `sandbox`: `writable` = agent can modify files, `readonly` = read-only access
- Same name as built-in without `extends:` = implicit extend
```

---

## Skill: `/neo-workflows` — Workflow Definition

**Trigger:** User wants to create, modify, or understand workflows.

```markdown
# neo workflows — Workflow Definition

## List available workflows
neo workflows                 # all workflows (built-in + custom)
neo workflows --output json

## Built-in workflows

### feature
architect → developer → reviewer → [conditional: fixer]

### review
reviewer (single-pass: quality, security, performance, coverage)

### hotfix
developer (fast-track, no architect)

### refine
refiner → structured output (ticket evaluation and decomposition)

## Creating a custom workflow

Create `.neo/workflows/<name>.yml`:

```yaml
# .neo/workflows/full-feature.yml
name: full-feature
description: "Feature with QA and multi-reviewer"

steps:
  plan:
    agent: architect
    sandbox: readonly

  approve-plan:
    type: gate
    dependsOn: [plan]
    description: "Review the architecture plan"
    timeout: 30m

  implement:
    agent: developer
    dependsOn: [approve-plan]

  test:
    agent: e2e-tester            # custom agent
    dependsOn: [implement]

  review-quality:
    agent: reviewer-quality
    dependsOn: [test]
    sandbox: readonly

  review-security:
    agent: reviewer-security
    dependsOn: [test]
    sandbox: readonly

  fix:
    agent: fixer
    dependsOn: [review-quality, review-security]
    condition: "hasIssues"       # only if reviewers found issues
```

## Rules

- Steps with no dependency between them run in parallel
- At most ONE writable step can run at a time (parallel steps must be readonly)
- Gates pause the workflow — supervisor approves via `neo gate approve`
- `dependsOn` defines execution order
- `condition` skips the step if the condition is not met
- Template syntax: `{{steps.plan.rawOutput}}`, `{{prompt}}`
```

---

## Skill: `/neo-gate` — Gate Management

**Trigger:** User needs to approve or reject a gate.

```markdown
# neo gate — Approval Gates

## Approve a gate
neo gate approve <run-id> <gate-name>
neo gate approve run-abc123 approve-plan

## Reject a gate
neo gate reject <run-id> <gate-name> --reason "Plan is too complex, simplify"

## Check waiting gates
neo runs --status paused

## Gate behavior

- **In full-auto mode**: gate emits an event, waits for approve()/reject()
- **In step-by-step mode**: run persists and exits. Resume with:
  neo gate approve <run-id> <gate-name>
  # then
  neo run <workflow> --run-id <run-id> --from <next-step>

## Tips

- Always inspect the upstream step's output before approving:
  neo runs <run-id> --step plan
- Gates have optional timeouts — if not approved in time, they auto-reject
- Use `autoApprove: true` in workflow YAML for CI/testing environments
```

---

## Skill: `/neo-troubleshoot` — Diagnostics

**Trigger:** User encounters problems with neo setup or execution.

```markdown
# neo troubleshoot — Diagnostics

## Health check
neo doctor                    # check all prerequisites

Checks:
- ✓ Claude CLI installed and authenticated
- ✓ Git version ≥ 2.20 (worktree support)
- ✓ Node.js ≥ 22
- ✓ .neo/config.yml valid
- ✓ Agent definitions valid
- ✓ Workflow definitions valid (no cycles, no parallel writable)

## Common issues

### "Agent not found: my-agent"
Agent name in workflow doesn't match any agent definition.
- Check `neo agents` for available names
- Verify `.neo/agents/my-agent.yml` exists and is valid YAML

### "Cycle detected in workflow"
Steps have circular dependencies.
- Review `dependsOn` chains in your workflow YAML
- Use `neo workflows --output json` to see the resolved graph

### "Parallel writable steps detected"
Two writable steps with no dependency can run at the same time.
- Add `dependsOn` to make them sequential, OR
- Set one to `sandbox: readonly`

### "Worktree already exists"
A previous run left a worktree behind.
- Check `.neo/worktrees/` for orphaned directories
- Remove manually or run the stuck run's cleanup

### "Budget exceeded"
Daily cap reached.
- Check `neo cost --today`
- Increase `budget.dailyCapUsd` in `.neo/config.yml`
- Wait for the next day (resets at midnight UTC)

### Permission denied on tool call
SDK sandbox blocked a tool.
- writable agents: should have file write tools
- readonly agents: cannot write, by design
- Check agent's `tools` list and `sandbox` setting

## Logs

neo logs                              # all recent events
neo logs <run-id>                     # events for a specific run
neo logs <session-id>                 # events for a specific session
neo logs --level error                # errors only
```

---

## Installation Strategy

### `neo init` installs skills automatically

```typescript
// During neo init:
// 1. Copy skill .md files to .claude/skills/neo/
// 2. Each skill has YAML frontmatter for Claude Code skill registration

// Skill frontmatter format:
// ---
// name: neo-run
// description: "Run neo workflows — dispatch, step, resume, retry"
// ---
```

### Skill files are versioned

When the user upgrades `neotx`, running `neo init --upgrade-skills` updates the skill files without touching the rest of the config.

### Skills are project-scoped

Skills live in `.claude/skills/neo/` so they're available when working in the project but don't pollute global Claude Code config.

---

## Implementation (Phase 10 addition)

Add to Phase 10 (CLI) in the roadmap:

- [ ] `cli/src/skills/` — skill template .md files (7 files)
- [ ] `neo init` — copy skills to `.claude/skills/neo/` with frontmatter
- [ ] `neo init --upgrade-skills` — update skills without touching config
- [ ] Skills reference project's `.neo/config.yml` for dynamic context
- [ ] Tests: verify skill installation, upgrade, content validity
