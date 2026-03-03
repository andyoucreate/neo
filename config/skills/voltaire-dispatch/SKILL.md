# Voltaire Dispatch Service Skill

Interact with the Voltaire Dispatch Service to trigger development pipelines.

## Service Endpoint

The Dispatch Service runs at `http://127.0.0.1:3001`.

## API Endpoints

### Feature Pipeline
```bash
curl -X POST http://127.0.0.1:3001/dispatch/feature \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <DISPATCH_AUTH_TOKEN>" \
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

### Refine Pipeline

Evaluate ticket clarity and decompose vague tickets into precise sub-tickets.
Use this when a ticket lacks clear acceptance criteria or has a broad scope.

```bash
curl -X POST http://127.0.0.1:3001/dispatch/refine \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <DISPATCH_AUTH_TOKEN>" \
  -d '{
    "ticketId": "PROJ-42",
    "title": "Improve user management",
    "type": "feature",
    "priority": "medium",
    "repository": "github.com/org/repo",
    "criteria": "Users should be managed better",
    "description": "The user management needs improvement..."
  }'
```

Note: `size` is **optional** for refine — the refiner agent estimates it from codebase analysis.

The refine callback returns a `RefineResult` with:
- `action: "pass_through"` — ticket is clear, dispatch directly to feature
- `action: "decompose"` — ticket split into sub-tickets (in `subTickets` array)
- `action: "escalate"` — ticket too vague, clarifying `questions` returned

### Review Pipeline
```bash
curl -X POST http://127.0.0.1:3001/dispatch/review \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <DISPATCH_AUTH_TOKEN>" \
  -d '{
    "prNumber": 42,
    "repository": "github.com/org/repo"
  }'
```

### Hotfix Pipeline
```bash
curl -X POST http://127.0.0.1:3001/dispatch/hotfix \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <DISPATCH_AUTH_TOKEN>" \
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
  -H "Authorization: Bearer <DISPATCH_AUTH_TOKEN>" \
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
curl -X POST http://127.0.0.1:3001/kill/{sessionId} \
  -H "Authorization: Bearer <DISPATCH_AUTH_TOKEN>"
```

### Pause/Resume
```bash
curl -X POST http://127.0.0.1:3001/pause \
  -H "Authorization: Bearer <DISPATCH_AUTH_TOKEN>"
curl -X POST http://127.0.0.1:3001/resume \
  -H "Authorization: Bearer <DISPATCH_AUTH_TOKEN>"
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
   - Resolve the repository from the Project Registry (in dispatcher instructions)
   - Assess ticket clarity:
     - **Clear ticket** (testable criteria, small scope) → `/dispatch/feature` with estimated size
     - **Vague ticket** (broad scope, unclear criteria) → `/dispatch/refine`
     - **Critical bug** → `/dispatch/hotfix`

2. When receiving a refine callback:
   - `pass_through` → dispatch to `/dispatch/feature` with enriched data
   - `decompose` → create sub-tickets in Notion, dispatch each to `/dispatch/feature`
   - `escalate` → add questions to Notion ticket, set status "Needs Clarification"

3. When receiving a GitHub PR event:
   - Extract PR number and repository
   - Call `/dispatch/review` to trigger code review

4. When issues are found by reviewers:
   - Call `/dispatch/fixer` with the list of issues

5. When receiving a `dispatch-result` callback:
   - Update the Notion ticket status accordingly
   - Write a completion report to the Notion page if pipeline succeeded

## Callback Mechanism

The Dispatch Service sends HTTP callbacks to OpenClaw when events occur. It does NOT post to Slack or update Notion directly.

### Callback Events

| Event | When | Payload |
|-------|------|---------|
| `pipeline.completed` | Pipeline finishes successfully | Full `PipelineResult` (or `RefineResult` for refine) |
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

### Refine Callback Payload

For refine pipelines, the `summary` field in the PipelineResult contains a JSON-serialized `RefineResult`:

```json
{
  "event": "pipeline.completed",
  "timestamp": "2026-03-01T14:32:00Z",
  "data": {
    "ticketId": "PROJ-42",
    "sessionId": "dispatch-1709...",
    "pipeline": "refine",
    "status": "success",
    "summary": "{\"action\":\"decompose\",\"score\":2,\"subTickets\":[...],...}",
    "costUsd": 12.50,
    "durationMs": 45000
  }
}
```

### Responsibility Split

- **Dispatch Service** = pure execution engine (SDK sessions, security, cost tracking, callbacks)
- **OpenClaw Dispatcher** = intelligence layer (project resolution, ticket routing, Notion updates)
