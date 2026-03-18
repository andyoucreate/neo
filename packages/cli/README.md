# @neotx/cli

The `neo` command-line interface for orchestrating autonomous developer agents. This thin wrapper over `@neotx/core` provides a user-friendly CLI for dispatching agents, monitoring runs, managing costs, and running the supervisor daemon.

## Installation

```bash
npm install -g @neotx/cli
```

Or with pnpm:

```bash
pnpm add -g @neotx/cli
```

Requires Node.js 22 or later.

## Quick Start

```bash
# Initialize a repository for neo
neo init

# Check your environment
neo doctor

# Run an agent
neo run developer --prompt "Add input validation to the login form"

# Watch a detached run
neo logs -f --run <run-id>

# Start the supervisor daemon
neo supervise
```

## Commands

### `neo init`

Initialize a `.neo/` project directory and register the repo in your global config.

```bash
neo init
neo init --force  # Re-register even if already initialized
```

Creates:
- `.neo/agents/` directory for project-local agent definitions
- Registers the repo in global config
- Registers the repo in `~/.neo/config.yml`

### `neo run <agent>`

Dispatch an agent to execute a task in an isolated clone.

```bash
neo run developer --prompt "Implement user authentication"
neo run architect --prompt "Design the caching layer" --repo /path/to/repo
neo run reviewer --prompt "Review the auth changes" --priority high
```

**Arguments:**
- `<agent>` - Agent name (e.g., `developer`, `architect`, `reviewer`)

**Options:**
| Flag | Description |
|------|-------------|
| `--prompt` | Task description for the agent (required) |
| `--repo` | Target repository path (default: `.`) |
| `--priority` | Priority level: `critical`, `high`, `medium`, `low` |
| `--meta` | Metadata as JSON string |
| `--output json` | Output as JSON |
| `-d, --detach` | Run in background (default: `true`) |
| `-s, --sync` | Run in foreground (blocking) |

By default, runs are **detached** — the command returns immediately with a run ID while the agent works in the background. Use `--sync` to run in the foreground.

```bash
# Detached (default) - returns immediately
neo run developer --prompt "Fix the login bug"
# Output: Detached run started: abc123...
#         Logs: neo logs -f abc123

# Foreground - blocks until complete
neo run developer --prompt "Fix the login bug" --sync
```

### `neo runs [run-id]`

List runs or show details of a specific run.

```bash
neo runs                     # List recent runs
neo runs abc123              # Show details for run abc123 (prefix match works)
neo runs --all               # Show runs from all repos
neo runs --repo my-project   # Filter by repo
neo runs --last 10           # Show only the last 10 runs
neo runs --status running    # Filter by status
neo runs --output json       # Output as JSON
neo runs --short             # Compact output (useful for scripts)
```

**Options:**
| Flag | Description |
|------|-------------|
| `--all` | Show runs from all repos |
| `--repo` | Filter by repo name or path |
| `--last` | Show only the last N runs |
| `--status` | Filter: `completed`, `failed`, `running` |
| `--short` | Compact output |
| `--output json` | Output as JSON |

### `neo logs`

Show event logs from journals (session starts, completions, failures, costs).

```bash
neo logs                           # Show last 20 events
neo logs --last 50                 # Show last 50 events
neo logs --type session:complete   # Filter by event type
neo logs --run abc123              # Filter by run ID (prefix match)
neo logs -f --run abc123           # Follow a detached run's log in real time
neo logs --output json             # Output as JSON
```

**Options:**
| Flag | Description |
|------|-------------|
| `--last` | Number of events to show (default: 20) |
| `--type` | Filter: `session:start`, `session:complete`, `session:fail`, `cost:update`, `budget:alert` |
| `--run` | Filter by run ID (prefix match) |
| `-f, --follow` | Follow a detached run log in real time (requires `--run`) |
| `--short` | Compact output |
| `--output json` | Output as JSON |

### `neo log <type> <message>`

Log a structured progress report to the supervisor activity log.

```bash
neo log progress "3/5 endpoints done"
neo log action "Pushed to branch"
neo log decision "Chose JWT over sessions — simpler for MVP"
neo log blocker "Tests failing, missing dependency"
neo log milestone "All tests passing, PR opened"
neo log discovery "Repo uses Prisma + PostgreSQL"
```

**Arguments:**
- `<type>` - Report type: `progress`, `action`, `decision`, `blocker`, `milestone`, `discovery`
- `<message>` - Message to log

**Options:**
| Flag | Description |
|------|-------------|
| `--name` | Supervisor instance name (default: `supervisor`) |

### `neo cost`

Show cost breakdown from journals (today, by agent, by run).

```bash
neo cost                # Show costs for current repo
neo cost --all          # Show costs from all repos
neo cost --repo my-app  # Filter by repo
neo cost --short        # Compact output
neo cost --output json  # Output as JSON
```

**Options:**
| Flag | Description |
|------|-------------|
| `--all` | Show costs from all repos |
| `--repo` | Filter by repo name or path |
| `--short` | Compact output |
| `--output json` | Output as JSON |

### `neo agents`

List available agents (built-in and custom from `.neo/agents/`).

```bash
neo agents              # List all agents
neo agents --output json
```

Shows agent name, model, sandbox mode, and source (built-in or custom).

### `neo repos [action] [target]`

Manage registered repositories.

```bash
neo repos                           # List registered repos
neo repos add /path/to/repo         # Add a repo
neo repos add . --name my-project   # Add with custom name
neo repos add . --branch develop    # Add with specific default branch
neo repos remove my-project         # Remove by name or path
neo repos --output json             # Output as JSON
```

**Actions:**
- `add` - Register a repository
- `remove` - Unregister a repository
- (omit) - List all registered repos

**Options for `add`:**
| Flag | Description |
|------|-------------|
| `--name` | Custom name for the repo |
| `--branch` | Default branch (auto-detected if omitted) |

### `neo supervise`

Manage the autonomous supervisor daemon.

```bash
neo supervise              # Start daemon + open TUI (default)
neo supervise -d           # Start daemon headless (no TUI)
neo supervise --status     # Show supervisor status
neo supervise --kill       # Stop the running supervisor
neo supervise --message "Focus on the auth module"  # Send a message
neo supervise --name prod  # Use a named instance
```

**Options:**
| Flag | Description |
|------|-------------|
| `--name` | Supervisor instance name (default: `supervisor`) |
| `-d, --detach` | Start daemon without opening the TUI |
| `--status` | Show supervisor status |
| `--kill` | Stop the running supervisor |
| `--attach` | Open the TUI (same as default, explicit flag) |
| `--message` | Send a message to the supervisor inbox |

By default, `neo supervise` starts the daemon (if not running) and opens the TUI. If the daemon is already running, it opens the TUI directly. Use `-d` for headless mode.

#### Supervisor TUI

The TUI provides a live dashboard for monitoring the supervisor:

- **Header**: PID, port, heartbeat count, uptime, live status
- **Budget panel**: Real-time cost tracking with progress bar and sparkline
- **Activity feed**: Live stream of supervisor actions, decisions, and events
- **Input**: Send messages to the supervisor

**Controls:**
- `Enter` - Send message
- `Esc` - Quit TUI (daemon keeps running)

### `neo mcp <action>`

Manage MCP (Model Context Protocol) server integrations.

```bash
neo mcp list                    # List configured MCP servers
neo mcp add linear              # Add using a preset
neo mcp add github              # Add GitHub integration
neo mcp add custom --type stdio --command "node" --serverArgs "server.js"
neo mcp add api --type http --url "https://api.example.com/mcp"
neo mcp remove linear           # Remove an MCP server
```

**Available presets:**
- `linear` - Linear issue tracking (requires `LINEAR_API_KEY`)
- `notion` - Notion workspace (requires `NOTION_TOKEN`)
- `github` - GitHub repositories (requires `GITHUB_TOKEN`)
- `jira` - Jira projects (requires `JIRA_API_TOKEN`, `JIRA_URL`)
- `slack` - Slack workspace (requires `SLACK_BOT_TOKEN`)

**Custom server options:**
| Flag | Description |
|------|-------------|
| `--type` | Server type: `stdio` or `http` |
| `--command` | Command for stdio servers |
| `--serverArgs` | Comma-separated args for stdio servers |
| `--url` | URL for http servers |

### `neo doctor`

Check environment prerequisites and configuration.

```bash
neo doctor
neo doctor --output json
```

Checks:
- Node.js version (requires >= 22)
- Git version (requires >= 2.20)
- Global config validity
- Repo registration status
- Claude CLI installation
- Agent definitions
- Journal directory permissions

## Detached Runs

By default, `neo run` executes agents in **detached mode**:

```bash
neo run developer --prompt "Add tests for the API"
# ✓ Detached run started: eeb76521-e806-46cd-8451-87490cfe7281
#   PID:  12345
#   Logs: neo logs -f eeb76521
```

The agent runs in a background process while you continue working. To monitor:

```bash
# Follow logs in real time
neo logs -f --run eeb76521

# Check run status
neo runs eeb76521

# List all running
neo runs --status running
```

For blocking execution, use `--sync`:

```bash
neo run developer --prompt "Quick fix" --sync
# Blocks until complete, shows progress inline
```

## JSON Output

All commands support `--output json` for scripting and automation:

```bash
neo runs --output json | jq '.[] | select(.status == "failed")'
neo cost --output json | jq '.today.total'
neo agents --output json | jq '.[].name'
neo doctor --output json | jq '.checks[] | select(.status == "fail")'
```

## Global Configuration

Neo stores global configuration in `~/.neo/config.yml`:

```yaml
budget:
  dailyCapUsd: 50

repos:
  - path: /Users/you/projects/my-app
    defaultBranch: main

supervisor:
  port: 7420
  idleIntervalMs: 60000
  idleSkipMax: 5

mcpServers:
  linear:
    type: stdio
    command: npx
    args: ["-y", "@anthropic/linear-mcp-server"]
    env:
      LINEAR_API_KEY: "${LINEAR_API_KEY}"
```

Run `neo init` or `neo repos add` to register repositories. The config is auto-created with defaults if missing.

## Project-Local Agents

Define custom agents in `.neo/agents/` within your repository:

```
.neo/
  agents/
    my-custom-agent.yml
```

These are loaded alongside built-in agents and can be used with `neo run my-custom-agent`.

## License

MIT
