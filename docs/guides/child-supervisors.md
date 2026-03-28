# Child Supervisors

Neo supports running specialized child supervisors that operate autonomously under a parent supervisor. Each child is a separate process with its own budget, objective, and acceptance criteria.

## Overview

The multi-supervisor architecture allows:
- **Specialization**: Different supervisors for different tasks (cleanup, security, docs, etc.)
- **Budget isolation**: Each child has its own daily spending cap
- **Process isolation**: Children run as separate processes with independent failure domains
- **Configuration-driven**: Define children in `~/.neo/config.yml`

## Configuration

Add child supervisors to your global config:

```yaml
# ~/.neo/config.yml
childSupervisors:
  - name: cleanup-neo
    type: cleanup
    repo: /path/to/neo
    enabled: true
    autoStart: true
    budget:
      dailyCapUsd: 10
      maxCostPerTaskUsd: 1
    heartbeatIntervalMs: 60000
```

### Configuration Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Unique identifier for this child |
| `type` | `cleanup` \| `custom` | required | Supervisor type (determines default behavior) |
| `repo` | string | required | Repository path to operate on |
| `enabled` | boolean | `true` | Whether the child is active |
| `autoStart` | boolean | `true` | Start automatically with parent |
| `budget.dailyCapUsd` | number | `10` | Daily spending limit |
| `budget.maxCostPerTaskUsd` | number | `1` | Max cost per individual task |
| `heartbeatIntervalMs` | number | `60000` | Health report interval |
| `objective` | string | (type default) | Custom objective |
| `acceptanceCriteria` | string[] | (type default) | Custom acceptance criteria |
| `instructionsPath` | string | (type default) | Path to custom SUPERVISOR.md |

## Built-in Types

### Cleanup Supervisor

The `cleanup` type performs maintenance tasks:
- Lint fixes (`pnpm lint:fix`)
- Test validation
- Dead code detection
- Safe dependency updates

Default behavior:
- Runs when repo is idle (5 minutes of no activity)
- Max 10 tasks per day
- Never modifies business logic

## Health Monitoring

The parent supervisor monitors children via heartbeat files:

```typescript
// Child writes heartbeat periodically
await writeChildHeartbeat(childDir, {
  timestamp: new Date().toISOString(),
  status: "running",
  currentTask: "Running lint fixes",
  costSinceLastUsd: 0.05,
});

// Parent reads heartbeat to check health
const health = await manager.checkHealth("cleanup-neo", {
  stallThresholdMs: 60_000
});

if (health.isStalled) {
  await manager.restart("cleanup-neo");
}
```

### Health Status

| Status | Meaning |
|--------|---------|
| `running` | Child is actively working |
| `idle` | Child is waiting for work |
| `stopped` | Child was stopped normally |
| `failed` | Child crashed or exited with error |
| `stalled` | No heartbeat within threshold |

## File Protocol

Children communicate with parents via JSON files:

```
~/.neo/supervisors/<parent>/children/<childName>/
├── state.json      # Current state (status, pid, cost, task count)
└── heartbeat.json  # Periodic health reports
```

### State Schema

```typescript
interface ChildSupervisorState {
  name: string;
  pid: number;
  status: "running" | "idle" | "stopped" | "failed" | "stalled";
  startedAt: string;      // ISO timestamp
  lastHeartbeatAt: string;
  costTodayUsd: number;
  taskCount: number;
  currentObjective?: string;
  lastError?: string;
}
```

### Heartbeat Schema

```typescript
interface ChildHeartbeat {
  timestamp: string;      // ISO timestamp
  status: "running" | "idle" | "stopped" | "failed" | "stalled";
  currentTask?: string;
  costSinceLastUsd: number;
  blockedReason?: string;
}
```

## Programmatic Usage

```typescript
import {
  ChildSupervisorManager,
  type ChildSupervisorConfig,
} from "@neotx/core";

// Create manager
const manager = new ChildSupervisorManager({
  parentName: "supervisor",
  childrenDir: "~/.neo/supervisors/supervisor/children",
});

// Register a child
const config: ChildSupervisorConfig = {
  name: "cleanup-neo",
  type: "cleanup",
  repo: "/path/to/neo",
  enabled: true,
  budget: { dailyCapUsd: 10, maxCostPerTaskUsd: 1 },
  heartbeatIntervalMs: 60_000,
  autoStart: true,
};
await manager.register(config);

// Spawn the child process
await manager.spawn("cleanup-neo");

// Check health
const health = await manager.checkHealth("cleanup-neo", {
  stallThresholdMs: 60_000,
});
console.log(`Status: ${health.status}, Stalled: ${health.isStalled}`);

// Stop all children
await manager.stopAll();
```

## Lifecycle

1. **Registration**: Config is stored, child directory created
2. **Spawn**: `neo supervise` process started in detached mode
3. **Running**: Child writes heartbeats, parent monitors
4. **Stall Detection**: Parent restarts if heartbeat too old
5. **Shutdown**: Parent sends SIGTERM, child cleans up

## Best Practices

1. **Use budget limits**: Always set `dailyCapUsd` to prevent runaway costs
2. **Monitor heartbeats**: Set appropriate `heartbeatIntervalMs` for your use case
3. **Separate concerns**: One child per responsibility (cleanup, security, etc.)
4. **Test locally**: Use `neo supervise --parent=supervisor` to test child behavior
5. **Check logs**: Activity is logged to `~/.neo/supervisors/<parent>/activity.jsonl`
