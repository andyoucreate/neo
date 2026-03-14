# Neo — Architecture Decisions Record

Key decisions and their rationale. Updated as the project evolves.

---

## ADR-001: Framework, not product

**Decision:** Neo is an orchestration framework (`@neotx/core`), not a complete product with UI/dashboard/tracker.

**Context:** The initial vision included a terminal UI supervisor, ticket tracker integrations, and webhook server. This would make neo compete with project management tools and force opinions about workflow.

**Rationale:**
- Every team has different tools (Linear vs Jira vs GitHub Issues vs Notion)
- Every team has different notification preferences (Slack vs email vs webhook)
- Every team has different approval workflows
- Building all of this is a product, not a framework — and it's a massive scope
- The hard problem is reliable agent orchestration, not UI

**Consequence:** Users write their own supervisor layer. Neo provides events, metrics, and control methods to make this easy. The CLI is a thin convenience wrapper, not the primary interface.

---

## ADR-002: YAML for both agents and workflows

**Decision:** YAML for both agents and workflows. TypeScript API for programmatic dispatch only.

**Context:** We considered three options:
1. Everything in YAML
2. Everything in TypeScript
3. Hybrid: YAML for agents, TypeScript for workflows

**Rationale:**
- An agent = prompt + model + tools. No logic. YAML is perfect and accessible to non-devs.
- A workflow = dependency graph + conditions + prompts. YAML with template syntax (`{{steps.plan.rawOutput}}`) and condition expressions covers the vast majority of use cases.
- YAML workflows are readable and editable by non-developers (PMs, leads).
- The TypeScript API (`neo.dispatch()`) remains available for programmatic dispatch but is not needed to define workflows.
- One format for all definitions reduces cognitive overhead.

**Consequence:** Custom agents are `.neo/agents/*.yml`. Custom workflows are `.neo/workflows/*.yml`. The TypeScript API is used for dispatch and event handling, not workflow definition.

---

## ADR-003: No built-in tracker integrations

**Decision:** Neo does not ship Linear/Jira/GitHub Issues adapters. Users connect their own.

**Context:** The initial design included a `TrackerAdapter` interface with built-in adapters for 4 providers.

**Rationale:**
- Each tracker has its own auth flow (OAuth, API keys, PATs)
- Each team maps fields differently (priority, type, status)
- Maintaining 4+ API integrations is a significant ongoing burden
- The event system makes it trivial for users to bridge: `neo.on("session:complete", () => linear.updateIssue(...))`
- If demand proves high, tracker adapters can be community packages

**Consequence:** Neo dispatches tasks with a `prompt` string and optional `metadata`. How that prompt originates (from a ticket, from a CLI argument, from a Slack message) is the user's concern.

---

## ADR-004: EventEmitter as the integration primitive

**Decision:** The Orchestrator extends EventEmitter and emits typed events for everything.

**Context:** We needed a way for users to build UIs, dashboards, Slack bots, and monitoring on top of neo.

**Rationale:**
- EventEmitter is Node.js native, zero dependencies
- Typed events give autocomplete and compile-time safety
- Wildcard support (`session:*`) enables flexible filtering
- Events are the most composable primitive — callbacks, streams, and polling all work on top
- The JSONL journal is just an event subscriber

**Consequence:** Every significant action emits an event. The event types are part of the public API and follow semver.

---

## ADR-005: Middleware over hardcoded hooks

**Decision:** Security guardrails and auditing are middleware, not hardcoded behavior.

**Context:** The dispatch-service has hardcoded hooks (loop detection, audit logger, notification forwarder).

**Rationale:**
- Users need different guardrails (some want to block `rm -rf`, others don't)
- Hardcoded behavior can't be disabled or reordered
- Middleware composition is a proven pattern (Express, Koa, etc.)
- Built-in middleware ships as functions users opt into, not magic defaults

**Consequence:** Neo ships middleware factories (`Orchestrator.middleware.loopDetection()`) but nothing is active by default. Users compose their middleware stack explicitly.

---

## ADR-006: Worktree isolation by default

**Decision:** Every writable agent session runs in its own git worktree.

**Context:** Multiple agents working on the same repo will corrupt each other's git state (uncommitted changes, conflicting branches, dirty index).

**Rationale:**
- Git worktrees provide true filesystem isolation with shared .git
- No Docker or VM overhead
- The worktree is created before the session and cleaned up after
- Read-only agents (reviewers) don't need worktrees — they read the repo directly

**Consequence:** `createWorktree()` and `removeWorktree()` are core infrastructure. The orchestrator manages the lifecycle automatically.

---

## ADR-007: No database, JSONL journals

**Decision:** All persistence uses append-only JSONL files, not a database.

**Context:** We considered SQLite, LevelDB, or a full database for session/cost/event storage.

**Rationale:**
- Zero infrastructure — no server, no migrations, no connection pooling
- Append-only is crash-safe (partial writes lose one line, not the whole file)
- JSONL is human-readable, `grep`-able, and trivially parseable
- Monthly rotation for cost journals keeps file sizes manageable
- If users need a database, they subscribe to events and write to their own

**Consequence:** Metrics and analytics read from JSONL files. This is fine for the expected scale (hundreds of sessions/day, not millions).

---

## ADR-008: SDK-first, don't reinvent

**Decision:** Neo wraps the Claude Agent SDK, doesn't replace or abstract it.

**Context:** We could abstract the SDK behind our own interfaces to support future model providers.

**Rationale:**
- The Agent SDK already handles session management, tool execution, and permission modes
- Abstracting it adds complexity with no current benefit (we only support Claude)
- SDK updates (new features, bug fixes) flow through naturally
- Users can pass SDK-native options through `overrides` if needed
- If multi-model support becomes needed, we add it then (YAGNI)

**Consequence:** Core types reference SDK types directly (`AgentDefinition`, `Options`, `SDKMessage`). This is a deliberate coupling.

---

## ADR-009: Structured output via Zod schemas

**Decision:** Workflow steps can declare a Zod schema for their agent's output. Neo injects format instructions and validates the result.

**Context:** The dispatch-service parses PR URLs and review findings with regex on raw agent output. This is fragile and untyped.

**Rationale:**
- Zod schemas are already a dependency (config validation)
- The schema doubles as documentation of what the agent should return
- Auto-injected format instructions reduce prompt engineering burden
- Validated output means downstream steps get typed data, not raw text
- Failed validation can trigger a retry with a "fix your output format" prompt

**Consequence:** `outputSchema` is optional. Steps without it get raw text output. Steps with it get parsed, validated, typed objects.

---

## ADR-010: Approval gates as events, not UI

**Decision:** Gates emit a `gate:waiting` event with `approve()` / `reject()` callbacks. Neo provides no UI for this.

**Context:** Human-in-the-loop checkpoints need some form of interaction. We could build a CLI prompt, a web form, or just emit an event.

**Rationale:**
- Different users want different approval UIs (CLI prompt, Slack button, web dashboard, auto-approve in CI)
- Building any specific UI forces an opinion
- Events + callbacks are the most flexible primitive
- The CLI can provide a simple `readline` prompt as a convenience
- `autoApprove: true` makes gates transparent in testing/CI

**Consequence:** Gates block the workflow until the event handler calls `approve()` or the timeout expires. In step-by-step mode, the run persists and exits — the supervisor resumes later via `neo gate approve` or `neo run --from`.

---

## ADR-011: Agent extends (partial override, not replace)

**Decision:** Users reconfigure built-in agents with `extends` — a partial merge, not a full replacement.

**Context:** The initial design had "same name = full override." Users would have to copy-paste the entire built-in agent config just to change the model.

**Rationale:**
- Most customizations are small: change model, add a tool, append to the prompt
- Copy-pasting forces users to track upstream changes to built-in prompts
- The `$inherited` token in tools gives explicit control: "keep parent's tools + add mine"
- `promptAppend` lets users add project-specific rules without replacing the battle-tested base prompt
- Implicit extends (same name as built-in without explicit `extends:`) provides backward compat

**Consequence:** Agent resolution has a merge step. Priority: custom field > inherited field > built-in default. The `neo agents` command shows the resolved state so users can debug.

---

## ADR-012: Workflows are declarative YAML, driven by the supervisor via CLI

**Decision:** Workflows are YAML files that define a launchable flow (DAG). The supervisor orchestrates by invoking `neo run` with `--step`, `--from`, `--retry`, `--run-id` flags. Runs are persisted to `.neo/runs/`.

**Context:** The initial design had workflows as TypeScript-only with an in-process event loop for gates. This assumed the orchestrator runs as a long-lived process.

**Rationale:**
- The supervisor is user code — it might be a bash script, a cron job, a Slack bot, or a human at the terminal
- CLI invocations are the universal interface: any language, any automation tool can shell out to `neo run`
- Persisted runs enable cross-process, cross-time orchestration: run plan today, review tonight, implement tomorrow
- YAML workflows are readable and editable by non-developers (PMs, leads)
- YAML with template syntax and condition expressions covers the vast majority of use cases
- Step-by-step mode gives the supervisor full control: inspect outputs, decide whether to proceed, modify the prompt for the next step

**Consequence:**
- Every step completion triggers a write to `.neo/runs/<runId>.json`
- The CLI must support: `--step`, `--from`, `--retry`, `--run-id`, `neo gate approve/reject`, `neo runs`
- Gates in full-auto mode still use events. In step-by-step mode, the run exits and waits for `neo gate` or `neo run --from`
- Workflows must be loadable from YAML without importing TypeScript — the YAML format is the serialization format

---

## ADR-013: Neo launches Claude Code — user's CLAUDE.md and skills apply

**Decision:** Neo does not manage prompts, conventions, or skills. It launches Claude Code sessions via the Agent SDK, which naturally loads the user's `CLAUDE.md`, project `CLAUDE.md`, and installed skills.

**Context:** We considered adding prompt enrichment (injecting conventions, project context) and tech-stack presets into neo.

**Rationale:**
- Claude Code already has a sophisticated system for loading project context (CLAUDE.md at global and project level)
- Claude Code's skill system already handles tech-stack specific instructions
- Duplicating this in neo would create conflicts and maintenance burden
- The user's existing Claude Code setup "just works" — neo adds orchestration on top, not prompting

**Consequence:** Neo's agent prompts define the agent's *role* (architect, developer, reviewer), not the project's conventions. The project context comes from the user's existing Claude Code configuration.

---

## ADR-014: One worktree per run

**Decision:** All steps in a workflow run share a single git worktree and branch. Parallel writable steps are not allowed.

**Context:** The initial design supported separate worktrees for parallel writable steps with merging. This was complex.

**Rationale:**
- Merging parallel worktrees is fragile (conflicts, ordering issues)
- In practice, parallel steps are almost always readonly (reviewers)
- One worktree per run is simple to reason about and implement
- Sequential writable steps naturally build on each other's changes
- Workflow validation catches parallel writable steps early

**Consequence:** The engine enforces: if two steps have no dependency between them (can run in parallel), at most one can be writable. Violation = validation error at workflow load time.

---

## ADR-017: CLI --output json for machine-readable output

**Decision:** All CLI commands support `--output json` for machine-readable output. Default is human-readable.

**Context:** The supervisor may be a script (bash, Python, Node.js) that parses neo's output to make decisions.

**Rationale:**
- CLI-driven orchestration requires reliable parsing
- Human-readable is the default (friendly for manual use)
- JSON output enables any language/tool to drive neo
- Consistent across all commands (run, runs, agents, workflows, status, cost)

**Consequence:** Every CLI command has two output paths: a formatted human view and a JSON serialization. The `--output json` flag selects the latter.

---

## ADR-018: Interactive `neo init`

**Decision:** `neo init` is an interactive wizard that scaffolds `.neo/` with sensible defaults based on user choices.

**Context:** First-run experience is critical for adoption. A blank config requires documentation.

**Rationale:**
- Users don't know what agents, models, or budget settings to choose
- Detecting project type (React, NestJS, Python, etc.) helps generate relevant defaults
- Interactive prompts lower the barrier to entry significantly
- The generated config is editable — init is a starting point, not a lock-in
- Can also run non-interactively: `neo init --model sonnet --budget 100` for CI/scripting

**Consequence:** `neo init` detects the project stack, asks a few questions, and generates config.yml + example workflow + optionally an extended developer agent tuned for the detected stack.

---

## ADR-019: Branch strategy is per-repo configuration

**Decision:** Branch naming, base branch, push remote, and PR target are configured per-repo in `.neo/config.yml`. Neo never merges.

**Context:** Different repos have different branching strategies (main, develop, release branches). Neo needs to know where to branch from and where PRs should target.

**Rationale:**
- `defaultBranch`, `branchPrefix`, `pushRemote`, `prBaseBranch` cover 95% of branching strategies
- Neo creates branches and optionally PRs, but never merges — merging is destructive and irreversible
- The supervisor or human decides when to merge
- Branch naming uses the runId for uniqueness and traceability

**Consequence:** Repo config in YAML. Worktree creates branch from `defaultBranch`. PR targets `prBaseBranch` (or `defaultBranch` if not set).

---

## ADR-020: Three-level recovery strategy

**Decision:** Session recovery escalates through three levels: normal retry, session resume, then fresh session.

**Context:** The dispatch-service proved that not all retries should use the same strategy. Some failures benefit from resuming the same session (preserving context), while others need a fresh start.

**Rationale:**
- Level 1 (attempt 1): Normal execution — create a new session
- Level 2 (attempt 2): Resume the same session (`resume: lastSessionId`) — preserves the agent's context and partial work
- Level 3 (attempt 3): Fresh session — abandon the previous session entirely, start clean
- `error_max_turns` is non-retryable — the agent hit its limit, retrying won't help
- Backoff: 30s → 60s → 90s between levels

**Consequence:** The recovery module tracks the last sessionId per step and escalates strategy on each attempt. Non-retryable errors (max_turns, budget_exceeded) skip directly to failure.

---

## ADR-021: Per-step recovery configuration

**Decision:** Recovery settings (maxRetries, retryable/non-retryable errors) can be configured per workflow step, overriding the global defaults.

**Context:** Some steps are inherently more retryable than others. A readonly architect step can safely retry many times, while a writable developer step with partial changes is risky to retry.

**Rationale:**
- Readonly steps (architect, reviewers) are always safe to retry
- Writable steps may leave partial state — fewer retries make sense
- Some errors are never retryable (max_turns means the approach is wrong, not transient)
- Users need control over this without modifying global config

**Consequence:** Workflow YAML supports optional `recovery` per step:
```yaml
steps:
  plan:
    agent: architect
    recovery:
      maxRetries: 5
  implement:
    agent: developer
    recovery:
      maxRetries: 2
      nonRetryable: [max_turns]
```
If omitted, the global `recovery` config applies.

---

## ADR-022: Safe EventEmitter wrapper

**Decision:** Neo wraps Node.js EventEmitter to catch listener errors, preventing a single buggy listener from crashing the entire orchestrator.

**Context:** Native EventEmitter propagates thrown errors from listeners, which can crash the process if uncaught.

**Rationale:**
- Users write event listeners for logging, Slack notifications, dashboard updates
- A bug in a Slack listener should not crash a running pipeline
- Caught errors are emitted as `error` events (standard Node.js pattern)
- Wildcard support (`session:*`) is not native — requires a custom wrapper anyway

**Consequence:** The event emitter wraps each listener call in try/catch. Errors from listeners are logged and emitted as `error` events but do not interrupt workflow execution.
