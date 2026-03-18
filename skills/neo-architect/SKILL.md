---
name: neo-architect
description: Guide for leveraging the architect agent to design systems and decompose complex features into atomic tasks. Use when planning features, understanding architect output, or deciding between architect and developer dispatch.
---

# Neo Architect

Guide for using the architect agent effectively. The architect analyzes features, designs architecture, and decomposes work into atomic developer tasks. It **never writes code**.

## When to Use Architect

| Scenario | Use Architect? | Why |
|----------|----------------|-----|
| Multi-file feature | ✅ Yes | Decomposition prevents file conflicts and ordering issues |
| System design decision | ✅ Yes | Evaluates tradeoffs, documents risks, plans components |
| Refactor across modules | ✅ Yes | Maps dependencies, orders changes safely |
| Simple bug fix | ❌ No | Developer handles directly — no planning overhead |
| Single-file change | ❌ No | Architect adds latency without value |
| Typo or config change | ❌ No | Direct developer dispatch |

**Rule of thumb**: If the task affects 3+ files or requires design decisions, use architect first.

## Writing Effective Architect Prompts

The architect prompt has three parts:

### 1. Feature description (what)

Describe the feature or system you need. Be specific about user-facing behavior.

```
"Implement multi-tenant authentication with tenant isolation"
"Add real-time notifications via WebSocket"
"Refactor the payment service to support multiple providers"
```

### 2. Constraints (boundaries)

Specify what the architect must consider or avoid:

```
"Must work with existing Postgres database"
"Cannot add new dependencies"
"Must maintain backward compatibility with v1 API"
"SSO support is required"
```

### 3. Scope (deliverables)

Tell the architect what output you expect:

```
"Output a list of atomic implementation tasks with dependencies"
"Design the API contracts and data flow"
"Create a milestone-based implementation roadmap"
```

## Prompt Templates

### New Feature

```bash
neo run architect \
  --prompt "Design and decompose: <feature description>.

Requirements:
- <requirement 1>
- <requirement 2>

Constraints:
- <constraint 1>
- <constraint 2>

Output atomic implementation tasks ordered by dependency." \
  --repo /path/to/repo \
  --branch feat/PROJ-100-feature-name \
  --meta '{"ticketId":"PROJ-100","stage":"refine"}'
```

### System Refactor

```bash
neo run architect \
  --prompt "Plan refactoring of <system/module>.

Current issues:
- <issue 1>
- <issue 2>

Target state: <description of desired architecture>

Constraints:
- Must not break existing API consumers
- Maintain test coverage

Output milestones with ordered tasks." \
  --repo /path/to/repo \
  --branch chore/PROJ-200-refactor-name \
  --meta '{"ticketId":"PROJ-200","stage":"refine"}'
```

### Technical Decision

```bash
neo run architect \
  --prompt "Evaluate approaches for <problem>.

Options to consider:
- Option A: <description>
- Option B: <description>

Evaluation criteria: performance, maintainability, complexity.

Recommend an approach and output implementation tasks." \
  --repo /path/to/repo \
  --branch feat/PROJ-300-decision-name \
  --meta '{"ticketId":"PROJ-300","stage":"refine"}'
```

## Understanding Architect Output

The architect produces structured JSON with two sections:

### Design

```json
{
  "design": {
    "summary": "High-level approach in 1-3 sentences",
    "components": ["list", "of", "components"],
    "data_flow": "inputs → processing → outputs",
    "risks": ["identified risks and mitigations"],
    "files_affected": ["all/file/paths.ts"]
  }
}
```

Use this section to:
- Validate the approach before implementation starts
- Identify risks early
- Understand the scope of changes

### Milestones and Tasks

```json
{
  "milestones": [
    {
      "id": "M1",
      "title": "Core authentication layer",
      "description": "What this milestone delivers",
      "tasks": [
        {
          "id": "T1",
          "title": "Add tenant context middleware",
          "files": ["src/middleware/tenant.ts"],
          "depends_on": [],
          "acceptance_criteria": ["Tenant ID extracted from JWT", "Context available in all routes"],
          "size": "S"
        },
        {
          "id": "T2",
          "title": "Create tenant-scoped database queries",
          "files": ["src/db/tenant-scope.ts"],
          "depends_on": ["T1"],
          "acceptance_criteria": ["All queries filter by tenant ID"],
          "size": "M"
        }
      ]
    }
  ]
}
```

**Key properties**:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (M1, T1, T2...) |
| `title` | Imperative verb + what (matches commit message style) |
| `files` | Exact paths — no overlap unless ordered by `depends_on` |
| `depends_on` | Task IDs that must complete first |
| `acceptance_criteria` | Testable conditions for completion |
| `size` | XS, S, M — anything larger should be split |

## How Supervisor Processes Architect Output

When you dispatch architect, the supervisor loop continues:

```
1. Architect analyzes feature → outputs milestones[].tasks[]
2. Supervisor creates sub-tickets from each task
3. For each task (respecting depends_on order):
   a. Dispatch developer with task details as prompt
   b. Wait for completion
   c. Dispatch reviewer on the PR
   d. If issues found → dispatch fixer
4. Move to next milestone when all tasks complete
```

### From Architect Task to Developer Prompt

The supervisor transforms architect output into developer prompts:

**Architect task**:
```json
{
  "id": "T1",
  "title": "Add tenant context middleware",
  "files": ["src/middleware/tenant.ts"],
  "acceptance_criteria": ["Tenant ID extracted from JWT", "Context available in all routes"]
}
```

**Developer prompt**:
```bash
neo run developer \
  --prompt "Add tenant context middleware in src/middleware/tenant.ts.

Acceptance criteria:
- Tenant ID extracted from JWT
- Context available in all routes

Create a PR when done." \
  --branch feat/PROJ-100-multi-tenant \
  --meta '{"ticketId":"PROJ-100-T1","parentTicketId":"PROJ-100","stage":"develop"}'
```

## Task Sizing and Dependencies

### Size Guidelines

| Size | Scope | Duration |
|------|-------|----------|
| XS | Single function, <20 lines | 1-2 turns |
| S | Single file, 20-100 lines | 3-5 turns |
| M | 2-3 files, 100-300 lines | 5-10 turns |
| L | **Too big** — architect should split | N/A |

If the architect outputs an L or XL task, ask it to decompose further.

### Dependency Ordering

Tasks with dependencies must complete in order:

```
T1 (no deps) ─┬─→ T3 (depends_on: [T1, T2])
T2 (no deps) ─┘
```

Independent tasks (T1, T2) can run in parallel if you have the budget.

The final "wiring" task (barrel exports, route registration, config updates) typically depends on all implementation tasks.

## Common Patterns

### Decomposition Pattern

Large features become:

```
M1: Core infrastructure
  T1: Types and schemas
  T2: Database migrations
  T3: Base service class

M2: Business logic
  T4: Feature service (depends_on: T3)
  T5: Validation rules (depends_on: T1)

M3: Integration
  T6: API endpoints (depends_on: T4, T5)
  T7: Wiring and exports (depends_on: T6)
```

### File Isolation Pattern

Each task owns specific files — no overlap unless ordered:

```
✅ Good:
  T1: src/services/auth.ts
  T2: src/services/user.ts
  T3: src/routes/index.ts (depends_on: T1, T2)

❌ Bad:
  T1: src/services/auth.ts
  T2: src/services/auth.ts  ← conflict!
```

### Shared Files Pattern

Barrel exports, route registration, and config files go in a final task:

```
T99: "Wire up all exports"
  files: [src/index.ts, src/routes/index.ts]
  depends_on: [T1, T2, T3, ...]  ← all implementation tasks
```

## Examples

### Example 1: New Feature

**Prompt**:
```bash
neo run architect \
  --prompt "Design user invitation system.

Requirements:
- Admin can invite users by email
- Invitations expire after 7 days
- Invited users set their password on first login

Constraints:
- Use existing email service (src/services/email.ts)
- Store invitations in Postgres

Output atomic tasks with dependencies." \
  --branch feat/PROJ-50-invitations \
  --meta '{"ticketId":"PROJ-50","stage":"refine"}'
```

### Example 2: System Design

**Prompt**:
```bash
neo run architect \
  --prompt "Design real-time notification system.

Consider:
- WebSocket vs Server-Sent Events
- Message persistence and replay
- Offline handling
- Delivery guarantees

Constraints:
- Must scale to 10k concurrent connections
- No new infrastructure (use existing Redis)

Output design rationale and implementation milestones." \
  --branch feat/PROJ-75-notifications \
  --meta '{"ticketId":"PROJ-75","stage":"refine"}'
```

### Example 3: Refactoring

**Prompt**:
```bash
neo run architect \
  --prompt "Plan migration from REST to GraphQL for user-facing API.

Current state: 15 REST endpoints in src/api/
Target state: GraphQL schema with resolvers

Constraints:
- Keep REST endpoints during transition (deprecate, don't remove)
- Maintain existing authentication
- No breaking changes for mobile clients

Output phased migration plan with milestones." \
  --branch chore/PROJ-100-graphql-migration \
  --meta '{"ticketId":"PROJ-100","stage":"refine"}'
```

## Troubleshooting

### Architect asks clarifying questions

This is expected behavior. If the request is ambiguous, architect will list specific questions rather than guess. Answer them and re-dispatch.

### Output exceeds 20 tasks

The scope is too large. Either:
- Narrow the initial request
- Ask architect to focus on a specific milestone
- Split into multiple architect runs

### Tasks have file overlap

Ask architect to reorder tasks so that overlapping files are handled in sequence with proper `depends_on` declarations.

### Size is L or larger

Ask architect to decompose the large task further:

```bash
neo run architect \
  --prompt "Task T5 from the previous plan is too large. Decompose it into S/M tasks."
```
