---
name: neo-workflows
description: "List and inspect neo workflow definitions"
---

# neo workflows — Workflow Definition

## List available workflows

```bash
neo workflows                 # all workflows (built-in + custom)
neo workflows --output json
```

## Built-in workflows

### feature
architect → [gate: approve-plan] → developer → reviewer-quality → [conditional: fixer]

### review
reviewer-quality + reviewer-security + reviewer-perf + reviewer-coverage (parallel)

### hotfix
developer (fast-track, no architect)

### refine
refiner → structured output (pass_through | decompose | escalate)

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
