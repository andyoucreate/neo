---
name: neo-agents
description: Guide for understanding and selecting neo agents. Use when deciding which agent to dispatch, understanding agent capabilities, reviewing agent output formats, or designing agent interaction flows.
---

# Neo Agents

Guide for understanding the 5 built-in agents in the neo system. Each agent has a specific role, model, sandbox mode, and output contract. Choose the right agent for the task.

## Agent Overview

| Agent | Model | Sandbox | Primary Role |
|-------|-------|---------|--------------|
| **architect** | opus | readonly | Strategic planner. Designs architecture and decomposes work into atomic tasks. Never writes code. |
| **developer** | opus | writable | Implementation worker. Executes atomic task specs in isolated clones. Strict scope discipline. |
| **fixer** | opus | writable | Auto-correction agent. Fixes issues found by reviewers. Targets root causes, not symptoms. |
| **refiner** | opus | readonly | Ticket quality evaluator. Assesses clarity, enriches context, decomposes vague tickets. Never writes code. |
| **reviewer** | sonnet | readonly | Code reviewer. Single-pass review covering quality, security, performance, and test coverage. Challenges by default. |

## Detailed Agent Profiles

### Architect

**Purpose**: Analyze feature requests, design technical architecture, and decompose work into atomic developer tasks.

**Capabilities**:
- Analyzes tickets to identify goals, scope, dependencies, and risks
- Designs component/module breakdown and data flow
- Decomposes large features into ordered milestones with atomic tasks
- Validates file paths and project structure before designing

**Tools**: Read, Glob, Grep, WebSearch, WebFetch

**Key constraints**:
- NEVER writes code — not even examples or snippets
- NEVER modifies files
- Zero file overlap between tasks (unless dependency-ordered)
- Every task must be completable in a single developer session
- Scope limit: 20 tasks max before escalation

**When to use**:
- Multi-file features (3+ files affected)
- System design decisions
- Refactors across modules
- Any work requiring architectural planning

**Output contract**:

```json
{
  "design": {
    "summary": "High-level approach in 1-3 sentences",
    "components": ["list", "of", "components"],
    "data_flow": "inputs → processing → outputs",
    "risks": ["identified risks and mitigations"],
    "files_affected": ["all/file/paths.ts"]
  },
  "milestones": [
    {
      "id": "M1",
      "title": "Milestone title",
      "description": "What this milestone delivers",
      "tasks": [
        {
          "id": "T1",
          "title": "Imperative task title",
          "files": ["src/path.ts"],
          "depends_on": [],
          "acceptance_criteria": ["testable criterion"],
          "size": "S"
        }
      ]
    }
  ]
}
```

---

### Developer

**Purpose**: Implement atomic task specifications in an isolated git clone. Execute exactly what the spec says — nothing more, nothing less.

**Capabilities**:
- Discovers project setup (language, framework, conventions)
- Reads task spec files and absorbs patterns from adjacent code
- Applies changes in order: types → logic → exports → tests → config
- Runs verification (typecheck, tests, lint)
- Commits with conventional commit format
- Creates PRs when instructed

**Tools**: Read, Write, Edit, Bash, Glob, Grep

**Key constraints**:
- Read BEFORE editing — no exceptions
- NEVER touches files outside task scope
- NEVER commits with failing tests
- NEVER pushes to main/master
- One task = one commit
- Max 3 attempts to resolve errors before escalation

**When to use**:
- Implementing tasks from architect decomposition
- Single-file bug fixes with clear scope
- Feature implementation with specific file list
- Any task with clear acceptance criteria

**Output contract**:

```json
{
  "task_id": "T1",
  "status": "completed | failed | escalated",
  "commit": "abc1234",
  "commit_message": "feat(auth): add JWT middleware",
  "files_changed": 3,
  "insertions": 45,
  "deletions": 2,
  "tests": "all passing",
  "notes": "observations for subsequent tasks"
}
```

---

### Fixer

**Purpose**: Fix issues identified by reviewer agents. Target ROOT CAUSES, never symptoms.

**Capabilities**:
- Reads PR review comments to understand issues
- Diagnoses root causes (not just symptoms)
- Applies targeted fixes across up to 3 files
- Adds regression tests for every fix
- Pushes fixes to the same PR branch

**Tools**: Read, Write, Edit, Bash, Glob, Grep

**Key constraints**:
- Fix ROOT CAUSES, never symptoms
- NEVER commits with failing tests
- NEVER modifies unrelated files
- Always adds regression tests
- Max 6 fix attempts before escalation
- Max 3 files modified per fix cycle

**When to use**:
- After reviewer returns `CHANGES_REQUESTED`
- Fixing specific issues with clear descriptions
- Addressing security vulnerabilities
- Resolving test failures

**Output contract**:

```json
{
  "status": "FIXED | PARTIAL | ESCALATED",
  "commit": "abc1234",
  "commit_message": "fix(scope): root cause description",
  "issues_fixed": [
    {
      "source": "reviewer",
      "severity": "CRITICAL",
      "file": "src/utils/html.ts",
      "root_cause": "html-escape did not handle script tags",
      "fix_description": "Added HTML entity encoding",
      "test_added": "src/utils/html.test.ts:42"
    }
  ],
  "issues_not_fixed": [],
  "attempts": 1
}
```

---

### Refiner

**Purpose**: Evaluate ticket clarity and decompose vague tickets into precise, atomic sub-tickets enriched with codebase context.

**Capabilities**:
- Reads and scores tickets on a 1-5 clarity scale
- Explores codebase to understand patterns and conventions
- Enriches clear tickets with technical context
- Decomposes vague tickets into atomic sub-tickets
- Identifies existing patterns for implementation guidance

**Tools**: Read, Glob, Grep, WebSearch, WebFetch

**Key constraints**:
- NEVER writes code
- NEVER modifies files
- ALWAYS reads the codebase before evaluating
- Every sub-ticket has exact file paths and concrete criteria
- Max 10 sub-tickets before escalation

**When to use**:
- Ticket is vague or ambiguous
- Scope is unclear or too large
- Sprint planning requires estimation
- Backlog grooming sessions

**Scoring system**:

| Score | Meaning | Action |
|-------|---------|--------|
| 5 | Crystal clear — specific files, testable criteria | Pass through |
| 4 | Clear enough — can infer from codebase | Pass through + enrich |
| 3 | Ambiguous — missing key details | Decompose |
| 2 | Vague — just a title or idea | Decompose |
| 1 | Incoherent or contradictory | Escalate |

**Output contract (pass through)**:

```json
{
  "score": 4,
  "action": "pass_through",
  "reason": "Clear scope and criteria",
  "enriched_context": {
    "tech_stack": "TypeScript, React, Vitest",
    "relevant_files": ["src/modules/auth/auth.service.ts"],
    "patterns_to_follow": "See src/modules/posts/ for CRUD pattern"
  }
}
```

**Output contract (decompose)**:

```json
{
  "score": 2,
  "action": "decompose",
  "reason": "No scope definition",
  "tech_stack": {
    "language": "TypeScript",
    "framework": "NestJS",
    "test_runner": "vitest"
  },
  "sub_tickets": [
    {
      "id": "ST-1",
      "title": "Create User entity and migration",
      "type": "feature",
      "size": "S",
      "files": ["src/db/schema/user.ts"],
      "criteria": [
        "User table exists with id, email, name columns",
        "Migration runs cleanly"
      ],
      "depends_on": [],
      "description": "Follow pattern in src/db/schema/post.ts. Use Drizzle pgTable()."
    }
  ]
}
```

**Output contract (escalate)**:

```json
{
  "score": 1,
  "action": "escalate",
  "reason": "Contradicts existing architecture",
  "questions": [
    "Specific question that must be answered before proceeding"
  ]
}
```

---

### Reviewer

**Purpose**: Perform a thorough single-pass code review covering quality, standards, security, performance, and test coverage.

**Capabilities**:
- Reads PR diffs and full file context
- Reviews across 5 lenses simultaneously (quality, standards, security, performance, coverage)
- Runs optional verification (typecheck, secrets scan)
- Posts review comments directly to GitHub PRs
- Challenges by default — approves only when standards are met

**Tools**: Read, Glob, Grep, Bash

**Key constraints**:
- Read-only — never modifies files
- ONLY flags issues in changed code (not pre-existing issues)
- Single pass — does NOT loop or re-read files
- Max 15 issues total (prioritize by severity)
- Every issue must have file path and line number

**When to use**:
- After developer creates a PR
- Post-merge audit of hotfixes
- External contribution review
- Security or compliance audit

**Review lenses**:
- **Quality**: Logic errors, edge cases, DRY violations, complexity
- **Standards**: Naming, structure, TypeScript types, consistency
- **Security**: Injection, auth bypass, hardcoded secrets, unsafe patterns
- **Performance**: N+1 queries, O(n²) algorithms, memory leaks, re-renders
- **Coverage**: Missing tests, missing regression tests, untested edge cases

**Severity levels**:
- **CRITICAL**: Production failure, exploitable vulnerability, data loss. Blocks merge.
- **WARNING**: Should fix — DRY violations, convention breaks, missing types.
- **SUGGESTION**: Max 3 total. Genuine improvements worth considering.

**Verdict logic**:
- Any CRITICAL → `CHANGES_REQUESTED`
- ≥3 WARNINGs → `CHANGES_REQUESTED`
- Otherwise → `APPROVED`

**Output contract**:

```json
{
  "verdict": "APPROVED | CHANGES_REQUESTED",
  "summary": "1-2 sentence assessment",
  "pr_comment": "posted | failed",
  "verification": {
    "typecheck": "pass | fail | skipped",
    "secrets_scan": "clean | flagged | skipped"
  },
  "issues": [
    {
      "lens": "quality | standards | security | performance | coverage",
      "severity": "CRITICAL | WARNING | SUGGESTION",
      "category": "bug | edge_case | dry | complexity | error_handling | naming | structure | typing | dead_code | consistency | injection | auth | secrets | unsafe_deser | n+1 | algorithm | memory | rerender | missing_tests | missing_regression | missing_edge_cases",
      "file": "src/path.ts",
      "line": 42,
      "description": "One sentence.",
      "suggestion": "How to fix"
    }
  ]
}
```

## Agent Selection Guide

### By Ticket Type

| Ticket Type | Clarity | Recommended Agent |
|-------------|---------|-------------------|
| New feature (multi-file) | Clear | architect → developer |
| New feature (multi-file) | Vague | refiner → architect → developer |
| Bug fix (simple) | Clear | developer |
| Bug fix (complex) | Clear | architect → developer |
| Bug fix (any) | Vague | refiner → developer |
| Refactor | Any | architect → developer |
| PR needs review | N/A | reviewer |
| PR has issues | N/A | fixer |
| Unclear ticket | Vague | refiner |

### Decision Tree

```
Is the ticket clear and actionable?
├── No → refiner (evaluate and decompose)
└── Yes
    ├── Is it a PR to review?
    │   └── Yes → reviewer
    ├── Does PR have issues to fix?
    │   └── Yes → fixer
    ├── Does it affect 3+ files or need design?
    │   ├── Yes → architect (then developer for each task)
    │   └── No → developer (direct implementation)
```

## Agent Interaction Flow

The standard flow through agents:

```
         ┌─────────┐
         │ refiner │  ← vague tickets enter here
         └────┬────┘
              │ clear tickets
              ▼
       ┌───────────┐
       │ architect │  ← complex features
       └─────┬─────┘
             │ atomic tasks
             ▼
       ┌───────────┐
       │ developer │  ← implementation
       └─────┬─────┘
             │ PR created
             ▼
       ┌───────────┐
       │ reviewer  │  ← code review
       └─────┬─────┘
             │
    ┌────────┴────────┐
    │                 │
    ▼                 ▼
APPROVED         CHANGES_REQUESTED
    │                 │
    ▼                 ▼
  merge          ┌─────────┐
                 │  fixer  │
                 └────┬────┘
                      │
                      ▼
                  reviewer (re-review)
                      │
              (max 6 cycles)
```

### Flow Examples

**Complete feature flow**:
```
1. refiner: scores ticket 2 → decomposes into 3 sub-tickets
2. architect: designs implementation → produces M1 with T1, T2, T3
3. developer: implements T1 → commits, creates PR
4. reviewer: reviews PR → CHANGES_REQUESTED (2 issues)
5. fixer: fixes issues → pushes to branch
6. reviewer: re-reviews → APPROVED
7. merge
8. developer: implements T2...
```

**Simple bug fix flow**:
```
1. developer: implements fix → commits, creates PR
2. reviewer: reviews → APPROVED
3. merge
```

**Hotfix flow (urgent)**:
```
1. developer: implements fix → commits, creates PR, merges
2. reviewer: post-merge audit (optional)
```

## Common Pitfalls

### 1. Using architect for simple tasks

❌ Wasted budget:
```bash
neo run architect --prompt "Plan typo fix in README"
```

✅ Direct to developer:
```bash
neo run developer --prompt "Fix typo: 'teh' → 'the' in README.md line 5"
```

### 2. Skipping refiner for vague tickets

❌ Developer guesses:
```bash
neo run developer --prompt "Make the app faster"
```

✅ Refine first:
```bash
neo run refiner --prompt "Evaluate: Make the app faster"
# Refiner decomposes into specific optimization tasks
```

### 3. Developer without architect for complex work

❌ Uncoordinated changes:
```bash
neo run developer --prompt "Add multi-tenant authentication"
```

✅ Architect plans first:
```bash
neo run architect --prompt "Design multi-tenant authentication"
# Then developer for each task
```

### 4. Fixer without reviewer issues

❌ No target:
```bash
neo run fixer --prompt "Fix the code"
```

✅ Specific issues:
```bash
neo run fixer --prompt "Fix: 1) SQL injection in user search 2) Missing auth check on /admin"
```

### 5. Endless fix loops

❌ Cycle 7+:
```bash
neo run fixer --prompt "Fix issues" --meta '{"cycle":9}'
```

✅ Escalate after 6 cycles — root cause is deeper than fixer can address.

## Agent Configuration

Agents are defined in YAML with the following schema:

```yaml
name: agent-name
model: opus | sonnet | haiku
sandbox: writable | readonly
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - WebSearch
  - WebFetch
prompt: ../prompts/agent-name.md
```

### Model Selection Rationale

- **opus**: Complex reasoning tasks (architecture, implementation, security analysis)
- **sonnet**: Focused review tasks (faster, sufficient for code review patterns)
- **haiku**: Not used in built-in agents (too limited for autonomous work)

### Sandbox Modes

- **readonly**: Agent can read files but cannot write. Safe for analysis (architect, refiner, reviewer).
- **writable**: Agent can read and write files. Required for implementation (developer, fixer).

## Summary

| Agent | Input | Output | Model | Sandbox |
|-------|-------|--------|-------|---------|
| architect | Feature request | Milestones + tasks | opus | readonly |
| developer | Task spec | Commit + PR | opus | writable |
| fixer | Review issues | Fix commit | opus | writable |
| refiner | Vague ticket | Sub-tickets or enriched context | opus | readonly |
| reviewer | PR diff | Verdict + issues | sonnet | readonly |

Choose the right agent for the task. When in doubt:
- Unclear ticket → refiner
- Complex feature → architect
- Clear task → developer
- PR ready → reviewer
- PR blocked → fixer
