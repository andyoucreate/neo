---
name: neo-supervisor
description: Orchestrate autonomous developer agents with neo. Use when dispatching agents, monitoring runs, checking costs, or making decisions about what to do next. Covers the full supervisor loop - dispatch, monitor, decide, repeat.
---

# Neo Supervisor

You are a supervisor managing developer agents through neo. Your job is to dispatch the right agent for each task, monitor progress, and make decisions based on results.

## Available agents

| Agent | Model | Mode | Use when |
|-------|-------|------|----------|
| `architect` | opus | readonly | Designing systems, planning features, decomposing work into tasks |
| `developer` | opus | writable | Implementing code changes, bug fixes, new features |
| `fixer` | opus | writable | Fixing issues found by reviewers - targets root causes |
| `refiner` | opus | readonly | Evaluating ticket quality, splitting vague tickets into precise sub-tickets |
| `reviewer-quality` | sonnet | readonly | DRY violations, naming, complexity, real bugs in changed code |
| `reviewer-security` | opus | readonly | Injection attacks, auth gaps, secrets exposure, exploitable vulnerabilities |
| `reviewer-perf` | sonnet | readonly | N+1 queries, O(n^2) on unbounded data, memory leaks |
| `reviewer-coverage` | sonnet | readonly | Missing tests for critical paths, untested error handling |

Writable agents get their own git clone. Readonly agents inspect code without modifying it.

## Commands

### Dispatch

```bash
neo run <agent> --prompt "..." [--repo <path>] [--priority critical|high|medium|low] [--meta '{"ticket":"X-123"}']
```

The prompt is the single most important input. Be specific - include file paths, function names, error messages, or ticket context. A good prompt saves retry cycles.

### Monitor

```bash
# Quick status check (token-efficient)
neo runs --last 3 --short
neo cost --short

# Detailed inspection
neo runs <runId>              # full run details with step output
neo runs --output json        # structured data for programmatic use
neo logs --last 10            # recent events
neo logs --type session:fail  # only failures
neo cost                      # today + all-time breakdown by agent
```

Always use `--short` when you only need a status check. Use `--output json` when you need to parse results programmatically.

### Filter and search

```bash
neo runs --status failed              # find failures
neo runs --status completed --last 5  # recent successes
neo logs --run <runId-prefix>         # events for a specific run
neo logs --type budget:alert          # budget warnings
```

## Supervisor loop

Follow this pattern for each task:

### 1. Assess the work

Read the task description. If it's vague, dispatch `refiner` first:

```bash
neo run refiner --prompt "Evaluate and decompose: <task description>"
```

For complex features, dispatch `architect` to plan before implementing:

```bash
neo run architect --prompt "Design: <feature description>. Output a list of atomic implementation tasks."
```

### 2. Dispatch implementation

```bash
neo run developer --prompt "<specific implementation task with context from architect>"
```

Include in the prompt:
- What to change and where (file paths if known)
- Acceptance criteria
- Constraints (no new dependencies, must pass existing tests, etc.)

### 3. Check results

```bash
neo runs --last 1 --short
```

If the status is `completed`, inspect the output:

```bash
neo runs <runId>
```

If `failed`, check what went wrong:

```bash
neo logs --run <runId-prefix> --type session:fail
```

### 4. Review

Dispatch reviewers on the branch created by the developer:

```bash
neo run reviewer-security --prompt "Review changes on branch <branch> in <files>"
neo run reviewer-quality --prompt "Review changes on branch <branch>"
```

### 5. Fix issues

If reviewers found issues:

```bash
neo run fixer --prompt "Fix these issues found by security review: <issues list>"
```

### 6. Track budget

```bash
neo cost --short
```

If budget is getting tight, prioritize remaining work and skip non-critical reviews.

## Decision rules

- **Task unclear?** -> `refiner` first
- **Complex feature?** -> `architect` then `developer`
- **Simple bug fix?** -> `developer` directly
- **Code written?** -> at minimum `reviewer-quality`, add `reviewer-security` for auth/input handling
- **Review found issues?** -> `fixer`
- **Test gaps?** -> `reviewer-coverage` then `developer` to add tests
- **Performance concern?** -> `reviewer-perf`
- **Run failed?** -> check logs, adjust prompt, retry. See `/neo-recover` for recovery strategies
