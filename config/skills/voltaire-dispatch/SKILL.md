---
name: voltaire-dispatch
description: Dispatch Notion tickets to Claude Agent SDK pipelines via the Voltaire Dispatch Service
---

## Dispatch Protocol

When a Notion ticket is detected:

1. **Read the full ticket** via Notion MCP: title, description, type, priority, acceptance criteria.
2. **Idempotency check** — before any work:
   - Is this ticket ID already in memory as dispatched?
   - Is there an active session for this ticket? (Check dispatch service: `GET /status`)
   - If yes to either: skip, log the duplicate, and notify Slack. Do NOT proceed.
3. **Classify the ticket** to determine the pipeline:
   - Feature/Refactor (M/L/XL) — Full pipeline: feature endpoint with /oneshot
   - Feature (XS/S) — Direct feature session, no team needed
   - Bug (Critical/High) — Hotfix pipeline
   - Bug (Medium/Low) — Standard pipeline
   - Chore — Direct session
4. **Update Notion ticket** status: "Backlog" -> "In Progress". Set the "Agent" field to the pipeline type.
5. **Read approval policy** from the project `.voltaire.yml` (see Approval Policy below).
6. **Call the Voltaire Dispatch Service** HTTP API with the appropriate endpoint and payload.
7. **Store dispatch record** in memory: ticket ID, timestamp, pipeline type.
8. **Announce to Slack**: "Started working on {TICKET_TITLE} [{PIPELINE_TYPE}]".

## Input Sanitization

CRITICAL: Input sanitization is handled by the **Voltaire Dispatch Service** (TypeScript). The dispatcher agent sends raw ticket data to the service, which applies the **allowlist model** before constructing any SDK prompt.

The dispatch service:
1. **Extracts structured fields only** from the payload:
   - `title` (plain text, max 200 characters)
   - `type` (enum: feature, bug, refactor, chore)
   - `priority` (enum: XS, S, M, L, XL, Critical, High, Medium, Low)
   - `criteria` (plain text, max 2000 characters)
   - `description` (plain text, max 2000 characters)

2. **Strips dangerous content**: code blocks, URLs, markdown formatting, excessive whitespace.

3. **Quarantines suspicious content** — rejects the request (HTTP 422) if:
   - Any field contains prompt-like instructions ("ignore previous", "you are", "system:")
   - Any field exceeds 3x the expected max length before truncation
   - Content contains base64-encoded strings or escape sequences

4. **Logs audit trail** — both raw and sanitized content to the event journal.

The dispatcher agent does NOT need to sanitize content itself — it passes ticket data to the service, which handles sanitization before calling the Claude Agent SDK `query()`.

## Approval Policy

Read `review.approval` from the project `.voltaire.yml` to determine merge behavior:

- **"human"** — Agents review and test, but a human must approve and merge. Post to Slack: "PR #{N} ready for your review" with PR link. Ticket stays in "Awaiting Review" until merged.
- **"agent"** — Auto-merge to `develop` if all checks pass. Human review is still required for `develop` -> `main`. Bot approves PR on GitHub.
- **"hybrid"** — Auto-merge if 0 CRITICAL issues found in review AND QA passes. If any CRITICAL was found (even if fixed by fixer): escalate to human review.

The approval policy is applied after the review pipeline and QA pipeline complete. The dispatcher must read and respect this setting for every dispatch cycle.

## Project-Specific Skills

Before dispatching, read the project's `.voltaire.yml` → `project.skills` array.
If the project defines skills, include them in the dispatch payload so the Dispatch Service
passes them to the SDK session.

Available project skills (only include if listed in .voltaire.yml):
- typescript-best-practices — TypeScript patterns, type safety, strict mode
- tailwind-css-patterns — Tailwind utility-first styling
- shadcn-ui — shadcn/ui component library
- nestjs-best-practices — NestJS architecture patterns
- nestjs-testing-expert — NestJS testing with Jest
- supabase-postgres-best-practices — Postgres optimization
- vercel-react-best-practices — React/Next.js performance
- vercel-composition-patterns — React composition patterns
- frontend-design — Production-grade frontend UI
- web-design-guidelines — Web Interface Guidelines compliance
- dnd-kit-implementation — Drag-and-drop with dnd-kit
- remotion-best-practices — Video creation with Remotion
- rilaykit — RilayKit forms and workflows
- stndrds-schema, stndrds-react, stndrds-ui, stndrds-backend — @stndrds/* libraries

## Voltaire Dispatch Service HTTP API

The dispatcher agent communicates with the Dispatch Service via HTTP calls.
The service runs on `http://localhost:3001`.

### Dispatch Endpoints

All dispatch endpoints accept a JSON payload and return a dispatch receipt.

#### POST /dispatch/feature

```json
{
  "ticketId": "PROJ-42",
  "title": "Add dark mode toggle",
  "type": "feature",
  "priority": "m",
  "size": "m",
  "repository": "github.com/org/my-app",
  "criteria": "User can toggle dark mode from settings...",
  "description": "Implement dark mode with persistent preference...",
  "skills": ["typescript-best-practices", "vercel-react-best-practices"]
}
```

Response:
```json
{
  "status": "dispatched",
  "sessionId": "uuid-...",
  "pipeline": "feature",
  "estimatedDuration": "30-60 min"
}
```

#### POST /dispatch/review

```json
{
  "prNumber": 123,
  "repository": "github.com/org/my-app",
  "skills": ["typescript-best-practices"]
}
```

The service automatically sizes the review (1/2/4 subagents) based on diff size.

#### POST /dispatch/qa

```json
{
  "prNumber": 123,
  "repository": "github.com/org/my-app"
}
```

#### POST /dispatch/hotfix

```json
{
  "ticketId": "PROJ-99",
  "title": "Login broken on mobile",
  "priority": "critical",
  "repository": "github.com/org/my-app",
  "description": "Users cannot log in on iOS Safari...",
  "skills": ["typescript-best-practices"]
}
```

#### POST /dispatch/fixer

```json
{
  "prNumber": 123,
  "repository": "github.com/org/my-app",
  "issues": [
    {
      "source": "reviewer-security",
      "severity": "CRITICAL",
      "file": "src/api/auth.ts",
      "line": 42,
      "description": "SQL injection in login query"
    }
  ]
}
```

### Status & Control Endpoints

```
GET  /status              — active sessions, queue depth, costs
POST /kill/:sessionId     — kill a running session
POST /pause               — pause all dispatching (emergency)
POST /resume              — resume dispatching
```

### Error Responses

| HTTP Code | Meaning |
|-----------|---------|
| 200 | Dispatched successfully |
| 409 | Duplicate — ticket already dispatched |
| 422 | Quarantined — suspicious content detected |
| 429 | Queue full — max 50 pending dispatches |
| 503 | Dispatch service paused |

When the service returns 409 (duplicate), do NOT retry. Log and skip.
When the service returns 422 (quarantined), alert Slack #alerts with the ticket ID.
When the service returns 429 (queue full), alert Slack #alerts and retry after 5 minutes.

## Review Sizing

Review sizing is handled automatically by the Dispatch Service based on PR diff size.
The dispatcher does NOT need to determine the size — just call `POST /dispatch/review`.

For reference, the service applies these rules internally:

1. **XS/S PR** (< 50 changed lines): Single combined review subagent
   - Covers quality + security together
   - Uses Opus model

2. **M PR** (50-300 changed lines): Two review subagents
   - Subagent 1: quality + performance (Sonnet)
   - Subagent 2: security + coverage (Opus)

3. **L/XL PR** (> 300 changed lines): Full 4-lens review
   - 4 parallel subagents: quality, security, performance, coverage

## Output Schema

Every pipeline run produces a result stored by the Dispatch Service. The dispatcher can read results via `GET /status`.

```json
{
  "ticketId": "PROJ-42",
  "sessionId": "uuid-...",
  "pipeline": "feature|hotfix|bug|chore|review|qa",
  "status": "success|failure|timeout|cancelled",
  "prUrl": "https://github.com/org/repo/pull/123",
  "prNumber": 123,
  "branch": "feat/PROJ-42-dark-mode",
  "summary": "Implemented dark mode with theme toggle and persistent preference.",
  "filesChanged": 12,
  "insertions": 340,
  "deletions": 45,
  "testsRun": 24,
  "testsPassed": 24,
  "testsFailed": 0,
  "reviewFindings": {
    "critical": 0,
    "high": 1,
    "medium": 3,
    "low": 5
  },
  "durationMs": 180000,
  "costUsd": 127.43,
  "timestamp": "2026-03-01T10:30:00Z"
}
```

Fields are nullable — only relevant fields are populated per pipeline type. The `status` field is always required.

## Session Recovery

Session recovery is handled entirely by the Dispatch Service. It uses the Claude Agent SDK's native `resume: sessionId` mechanism.

### Recovery Protocol (handled by Dispatch Service)

1. **On failure**: Resume the same session via `resume: sessionId`
2. **On repeated failure**: Start a fresh session (new sessionId)
3. **After 3 failures**: Mark ticket as "Blocked" in Notion, alert Slack

### Rate Limit Handling (handled by Dispatch Service)

The SDK emits `SDKRateLimitEvent` in real-time. The Dispatch Service handles backoff:
- Warning at 80% utilization → reduce concurrent sessions
- Rejected → wait and retry (60s → 120s → 300s)

### What the Dispatcher Should Do on Failure

When a pipeline fails (reported by the Dispatch Service via Slack or status check):

1. **Check `GET /status`** for the session status
2. If status is `failure` with retries exhausted:
   - Update Notion ticket: "In Progress" → "Blocked"
   - Set Notion "Agent" field to: "FAILED: {error summary}"
   - Store failure record in memory: `failed:{TICKET_ID}` → {error, timestamp}
   - Alert Slack #alerts: "FAILED: Ticket {TICKET_ID}. Manual intervention required."
   - Do NOT retry — the Dispatch Service already retried 3 times
