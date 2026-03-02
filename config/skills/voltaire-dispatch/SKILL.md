# Voltaire Dispatch Service Skill

Interact with the Voltaire Dispatch Service to trigger development pipelines.

## Service Endpoint

The Dispatch Service runs at `http://127.0.0.1:3001`.

## API Endpoints

### Feature Pipeline
```bash
curl -X POST http://127.0.0.1:3001/dispatch/feature \
  -H "Content-Type: application/json" \
  -d '{
    "ticketId": "PROJ-42",
    "title": "Add user avatar",
    "type": "feature",
    "priority": "medium",
    "size": "m",
    "repository": "github.com/org/repo",
    "criteria": "Users can upload avatars",
    "description": "Full description..."
  }'
```

### Review Pipeline
```bash
curl -X POST http://127.0.0.1:3001/dispatch/review \
  -H "Content-Type: application/json" \
  -d '{
    "prNumber": 42,
    "repository": "github.com/org/repo"
  }'
```

### QA Pipeline
```bash
curl -X POST http://127.0.0.1:3001/dispatch/qa \
  -H "Content-Type: application/json" \
  -d '{
    "prNumber": 42,
    "repository": "github.com/org/repo"
  }'
```

### Hotfix Pipeline
```bash
curl -X POST http://127.0.0.1:3001/dispatch/hotfix \
  -H "Content-Type: application/json" \
  -d '{
    "ticketId": "BUG-99",
    "title": "Fix login crash",
    "priority": "critical",
    "repository": "github.com/org/repo",
    "description": "Login crashes when email contains special characters"
  }'
```

### Fixer Pipeline
```bash
curl -X POST http://127.0.0.1:3001/dispatch/fixer \
  -H "Content-Type: application/json" \
  -d '{
    "prNumber": 42,
    "repository": "github.com/org/repo",
    "issues": [
      {
        "source": "reviewer-security",
        "severity": "CRITICAL",
        "file": "src/auth.ts",
        "line": 42,
        "description": "SQL injection vulnerability",
        "suggestion": "Use parameterized queries"
      }
    ]
  }'
```

## Status & Control

### Check Status
```bash
curl http://127.0.0.1:3001/status
```

### Health Check
```bash
curl http://127.0.0.1:3001/health
```

### Kill a Session
```bash
curl -X POST http://127.0.0.1:3001/kill/{sessionId}
```

### Pause/Resume
```bash
curl -X POST http://127.0.0.1:3001/pause
curl -X POST http://127.0.0.1:3001/resume
```

## Response Codes

| Code | Meaning |
|------|---------|
| 200 | Dispatch accepted |
| 400 | Invalid payload |
| 409 | Ticket already dispatched (idempotency) |
| 422 | Content quarantined (suspicious input) |
| 429 | Queue full |
| 503 | Service paused |

## Workflow

1. When receiving a Notion ticket event:
   - Read the ticket from Notion
   - Classify the ticket type (feature/bug/refactor/chore)
   - Map to the appropriate pipeline (feature → `/dispatch/feature`, bug → `/dispatch/hotfix`)
   - Call the Dispatch Service with the ticket data

2. When receiving a GitHub PR event:
   - Extract PR number and repository
   - Call `/dispatch/review` to trigger code review

3. When review completes with all checks passing:
   - Call `/dispatch/qa` to trigger QA testing

4. When issues are found by reviewers:
   - Call `/dispatch/fixer` with the list of issues

5. When receiving a `dispatch-result` callback:
   - Update the Notion ticket status accordingly
   - Post a notification to the appropriate Slack channel (#dev-agents for success, #alerts for failures)
   - Write a completion report to the Notion page if pipeline succeeded

## Callback Mechanism

The Dispatch Service sends HTTP callbacks to OpenClaw when events occur. It does NOT post to Slack or update Notion directly.

### Callback Events

| Event | When | Payload |
|-------|------|---------|
| `pipeline.completed` | Pipeline finishes successfully | Full `PipelineResult` |
| `pipeline.failed` | Pipeline fails, times out, or is cancelled | Full `PipelineResult` |
| `service.started` | Dispatch Service starts | `{ action, version, host }` |
| `service.stopped` | Dispatch Service shuts down | `{ action, version, host, signal }` |
| `agent.notification` | SDK agent sends a notification | `{ sessionId, message }` |

### Callback Payload Format

```json
{
  "event": "pipeline.completed",
  "timestamp": "2026-03-01T14:32:00Z",
  "data": {
    "ticketId": "PROJ-42",
    "sessionId": "dispatch-1709...",
    "pipeline": "feature",
    "status": "success",
    "costUsd": 127.43,
    "durationMs": 180000,
    "prNumber": 123
  }
}
```

### Responsibility Split

- **Dispatch Service** = pure execution engine (SDK sessions, security, cost tracking, callbacks)
- **OpenClaw** = all external communication (Slack notifications, Notion status updates, reports)
