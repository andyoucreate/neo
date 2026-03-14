# neo

Neoscaling - the new way to scale your engineering team. Instead of hiring, you orchestrate autonomous developer agents that plan, implement, review, and fix code across your repositories.

neo is an orchestration framework that wraps the Claude Agent SDK with everything you need to run agents in production: git worktree isolation, 3-level recovery, concurrency control, budget guards, and cost tracking. Zero infrastructure required - no database, no Redis, no Docker.

## Quickstart

```bash
# Install
npm install -g @neo-cli/cli

# Initialize in your repo
cd your-project
neo init --budget 100

# Run an agent
neo run developer --prompt "Add input validation to the user registration endpoint"

# Check the result
git worktree list   # see the isolated branch
cat .neo/runs/*.json  # see run details and costs
```

## How it works

When you run `neo run developer --prompt "..."`, neo:

1. Loads the agent definition (model, tools, sandbox permissions, system prompt)
2. Creates an isolated git worktree on a new branch
3. Starts a Claude session with the agent's configuration
4. Streams events (start, progress, cost updates, completion)
5. Tracks costs in JSONL journals with daily budget enforcement
6. Persists the run result to `.neo/runs/<runId>.json`

The agent works in its own worktree. Your working directory is never touched.

## CLI

```
neo init       Initialize a .neo/ project directory
neo run        Dispatch an agent to execute a task
neo agents     List available agents
neo doctor     Check environment prerequisites
```

### neo init

```bash
neo init                    # defaults: $500/day budget, auto-detects branch
neo init --budget 50        # set daily budget cap
neo init --force            # overwrite existing config
```

Creates `.neo/config.yml`, agent and journal directories, and installs supervisor skills for Claude Code.

### neo run

```bash
neo run <agent> --prompt "..."

# Examples
neo run developer --prompt "Fix the N+1 query in UserService.findAll"
neo run architect --prompt "Design the notification system"
neo run reviewer-quality --prompt "Review the changes in src/auth/"
neo run fixer --prompt "Fix all issues from the quality review"

# Options
neo run developer --prompt "..." --repo ../other-repo
neo run developer --prompt "..." --priority critical
neo run developer --prompt "..." --output json
neo run developer --prompt "..." --meta '{"ticket": "PROJ-123"}'
```

### neo agents

```bash
neo agents              # table view
neo agents --output json  # JSON for scripting
```

### neo doctor

```bash
neo doctor              # check Node.js, git, config, Claude CLI, agents
neo doctor --output json
```

## Agents

8 built-in agents, each with a specific role, model, and sandbox:

| Agent | Role | Model | Sandbox |
|-------|------|-------|---------|
| `architect` | Plans architecture, decomposes features into tasks. Never writes code. | opus | readonly |
| `developer` | Implements features and fixes in isolated worktrees. | opus | writable |
| `fixer` | Fixes issues found by reviewers. Targets root causes. | opus | writable |
| `refiner` | Evaluates tickets and splits vague requirements into precise specs. | opus | readonly |
| `reviewer-quality` | Catches real bugs and DRY violations. Approves by default. | sonnet | readonly |
| `reviewer-security` | Flags exploitable vulnerabilities. Approves by default. | opus | readonly |
| `reviewer-perf` | Flags N+1 queries and O(n^2) on unbounded data. Approves by default. | sonnet | readonly |
| `reviewer-coverage` | Recommends missing tests for critical paths. Never blocks. | sonnet | readonly |

### Custom agents

Drop a YAML file in `.neo/agents/` to define custom agents or extend built-in ones:

```yaml
# .neo/agents/my-developer.yml
name: my-developer
extends: developer
promptAppend: |
  Always use our internal logger instead of console.log.
  Follow the patterns in src/shared/conventions.ts.
```

Agents support inheritance with `extends`, tool customization with `$inherited`, and per-agent `maxTurns` and `mcpServers`.

## Configuration

`.neo/config.yml` - created by `neo init`:

```yaml
repos:
  - path: "."
    defaultBranch: main      # auto-detected from git
    branchPrefix: feat        # prefix for worktree branches
    autoCreatePr: false       # auto PR creation (coming soon)

concurrency:
  maxSessions: 5              # total concurrent agent sessions
  maxPerRepo: 2               # max sessions per repository
  queueMax: 50                # max queued dispatches

budget:
  dailyCapUsd: 500            # hard daily spending limit
  alertThresholdPct: 80       # emit budget:alert at this threshold

recovery:
  maxRetries: 3               # retry attempts per session
  backoffBaseMs: 30000        # base delay between retries

sessions:
  initTimeoutMs: 120000       # timeout waiting for session init
  maxDurationMs: 3600000      # max session duration (1 hour)
```

## Programmatic API

neo is a framework, not just a CLI. Use `@neo-cli/core` directly:

```typescript
import { AgentRegistry, loadConfig, Orchestrator } from "@neo-cli/core";

const config = await loadConfig(".neo/config.yml");

const orchestrator = new Orchestrator(config, {
  journalDir: ".neo/journals",
  middleware: [
    Orchestrator.middleware.budgetGuard(),
    Orchestrator.middleware.loopDetection({ threshold: 5, scope: "session" }),
  ],
});

// Load and register agents
const registry = new AgentRegistry("path/to/agents");
await registry.load();
for (const agent of registry.list()) {
  orchestrator.registerAgent(agent);
}

// Register a workflow
orchestrator.registerWorkflow({
  name: "implement",
  steps: {
    code: { agent: "developer" },
    review: { agent: "reviewer-quality", dependsOn: ["code"], sandbox: "readonly" },
  },
});

// Listen to events
orchestrator.on("session:complete", (event) => {
  console.log(`Done: $${event.costUsd.toFixed(4)}`);
});

// Dispatch
await orchestrator.start();
const result = await orchestrator.dispatch({
  workflow: "implement",
  repo: "/path/to/repo",
  prompt: "Add rate limiting to the API",
  priority: "high",
});

console.log(result.status);  // "success" | "failure"
console.log(result.branch);  // "feat/run-<uuid>"
console.log(result.costUsd); // 0.1842

await orchestrator.shutdown();
```

### Events

The orchestrator emits typed events you can subscribe to:

```typescript
orchestrator.on("session:start", (e) => { /* agent started */ });
orchestrator.on("session:complete", (e) => { /* agent finished, e.costUsd */ });
orchestrator.on("session:fail", (e) => { /* agent failed, e.error, e.willRetry */ });
orchestrator.on("cost:update", (e) => { /* e.todayTotal, e.budgetRemainingPct */ });
orchestrator.on("budget:alert", (e) => { /* threshold crossed */ });
orchestrator.on("*", (e) => { /* all events */ });
```

### Middleware

Extend behavior with middleware hooks:

```typescript
import { Orchestrator } from "@neo-cli/core";

const orchestrator = new Orchestrator(config, {
  middleware: [
    Orchestrator.middleware.budgetGuard(),           // block when over budget
    Orchestrator.middleware.loopDetection({           // detect tool loops
      threshold: 5,
      scope: "session",
    }),
    Orchestrator.middleware.auditLog({                // JSONL audit trail
      dir: ".neo/audit",
      includeInput: true,
    }),
  ],
});
```

## Architecture

```
@neo-cli/cli          Thin CLI wrapper (citty)
  |
@neo-cli/core         Orchestration engine
  |--- orchestrator   Dispatch, lifecycle, budget, events
  |--- runner         SDK session management, 3-level recovery
  |--- isolation      Git worktrees, sandbox config, mutex
  |--- concurrency    Priority semaphore with per-repo limits
  |--- middleware      Chain execution, SDK hooks conversion
  |--- events         Typed emitter, JSONL journals
  |--- cost           Daily tracking, monthly rotation
  |
@neo-cli/agents       YAML agent definitions and prompts
```

### Design principles

- **Framework, not product** - no UI, no database, no opinions on trackers
- **SDK-first** - wraps the Claude Agent SDK, SDK updates flow through naturally
- **YAML for definitions, TypeScript for dispatch** - agents are YAML, orchestration is code
- **Zero infrastructure** - JSONL journals, git worktrees, in-memory semaphore
- **Events are the integration primitive** - everything emits typed events

### Recovery

Sessions use 3-level recovery escalation:

1. **Normal retry** - same session, same context
2. **Resume session** - new session, previous session ID for context continuity
3. **Fresh session** - clean slate, no previous context

Each level uses exponential backoff. Non-retryable errors (auth failures, invalid config) skip retries entirely.

## Requirements

- Node.js >= 22
- git >= 2.20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## License

MIT
