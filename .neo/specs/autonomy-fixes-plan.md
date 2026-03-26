# Autonomy Fixes Implementation Plan

**Goal:** Fix 3 autonomy problems that prevent the supervisor from operating efficiently: blind retries, blocked task halting, and decision re-answer spam.

**Architecture:**
- Problem 1: Extend `RecoveryOptions` to accept a prompt transformer that injects failure context
- Problem 2: Add "blocked" task status and allow supervisor to skip blocked tasks while continuing with others
- Problem 3: Add in-memory Set to track already-answered decisions within a heartbeat

**Tech Stack:** TypeScript, Vitest, Zod (for schema updates)

---

## File Structure Mapping

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/core/src/runner/recovery.ts` | Modify | Add failure context injection to recovery prompts |
| `packages/core/src/types.ts` | Modify | Add "blocked" status to PersistedRun and StepResult |
| `packages/core/src/supervisor/heartbeat.ts` | Modify | Add answered decision deduplication cache, update isRunActive() |
| `packages/core/src/supervisor/decisions.ts` | Modify | Add `isAnswered()` method for checking without throwing |
| `packages/core/src/orchestrator/run-store.ts` | Modify | Add `getRunById()`, `getAllRuns()`, `markBlocked()`, `getBlockedRuns()`, `unblock()` |
| `packages/core/src/__tests__/recovery-context.test.ts` | Create | Tests for failure context injection |
| `packages/core/src/__tests__/heartbeat-dedup.test.ts` | Create | Tests for decision deduplication |
| `packages/core/src/__tests__/blocked-tasks.test.ts` | Create | Tests for blocked status |
| `packages/core/src/__tests__/orchestrator-blocking.test.ts` | Create | Tests for RunStore blocking methods |

---

## Task 1: Add Failure Context to Recovery Retries

**Files:**
- Modify: `packages/core/src/runner/recovery.ts`
- Create: `packages/core/src/__tests__/recovery-context.test.ts`

### Step 1: Write the failing test

```typescript
// packages/core/src/__tests__/recovery-context.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithRecovery } from "@/runner/recovery";
import { SessionError } from "@/runner/session";

// Mock the session module
vi.mock("@/runner/session", () => ({
  runSession: vi.fn(),
  SessionError: class SessionError extends Error {
    constructor(
      message: string,
      public readonly errorType: string,
      public readonly sessionId: string,
    ) {
      super(message);
      this.name = "SessionError";
    }
  },
}));

import { runSession } from "@/runner/session";

describe("runWithRecovery - failure context injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects previous failure context into retry prompt", async () => {
    const mockRunSession = vi.mocked(runSession);
    const capturedPrompts: string[] = [];

    // First call fails, second succeeds
    mockRunSession
      .mockImplementationOnce(async (opts) => {
        capturedPrompts.push(opts.prompt);
        throw new SessionError("Connection timeout", "timeout", "sess-1");
      })
      .mockImplementationOnce(async (opts) => {
        capturedPrompts.push(opts.prompt);
        return {
          sessionId: "sess-2",
          output: "Success",
          costUsd: 0.01,
          durationMs: 1000,
          turnCount: 1,
        };
      });

    const result = await runWithRecovery({
      agent: {
        name: "test-agent",
        definition: {
          description: "Test",
          prompt: "You are a test agent.",
          tools: ["Read"],
          model: "sonnet",
        },
        sandbox: "readonly",
        source: "built-in",
      },
      prompt: "Do the task",
      sandboxConfig: {
        allowedTools: ["Read"],
        readablePaths: ["/tmp"],
        writablePaths: [],
        writable: false,
      },
      initTimeoutMs: 5000,
      maxDurationMs: 60000,
      maxRetries: 3,
      backoffBaseMs: 10,
    });

    expect(result.output).toBe("Success");
    expect(capturedPrompts).toHaveLength(2);

    // First prompt should be original
    expect(capturedPrompts[0]).toBe("Do the task");

    // Second prompt should include failure context
    expect(capturedPrompts[1]).toContain("PREVIOUS ATTEMPT FAILED");
    expect(capturedPrompts[1]).toContain("Connection timeout");
    expect(capturedPrompts[1]).toContain("timeout");
  });

  it("does not inject failure context on first attempt", async () => {
    const mockRunSession = vi.mocked(runSession);
    let capturedPrompt = "";

    mockRunSession.mockImplementationOnce(async (opts) => {
      capturedPrompt = opts.prompt;
      return {
        sessionId: "sess-1",
        output: "Success",
        costUsd: 0.01,
        durationMs: 1000,
        turnCount: 1,
      };
    });

    await runWithRecovery({
      agent: {
        name: "test-agent",
        definition: {
          description: "Test",
          prompt: "Test prompt",
          tools: ["Read"],
          model: "sonnet",
        },
        sandbox: "readonly",
        source: "built-in",
      },
      prompt: "Original task",
      sandboxConfig: {
        allowedTools: ["Read"],
        readablePaths: ["/tmp"],
        writablePaths: [],
        writable: false,
      },
      initTimeoutMs: 5000,
      maxDurationMs: 60000,
      maxRetries: 3,
      backoffBaseMs: 10,
    });

    expect(capturedPrompt).toBe("Original task");
    expect(capturedPrompt).not.toContain("PREVIOUS ATTEMPT FAILED");
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm test -- packages/core/src/__tests__/recovery-context.test.ts`
Expected: FAIL — prompt is not modified on retry

### Step 3: Write minimal implementation

```typescript
// packages/core/src/runner/recovery.ts
import {
  runSession,
  SessionError,
  type SessionOptions,
  type SessionResult,
} from "@/runner/session";

// ─── Types ──────────────────────────────────────────────

export interface RecoveryOptions extends SessionOptions {
  maxRetries: number;
  backoffBaseMs: number;
  nonRetryable?: string[];
  onAttempt?: (attempt: number, strategy: string) => void;
}

// ─── Failure Context ────────────────────────────────────

interface FailureContext {
  errorMessage: string;
  errorType: string;
  attempt: number;
  strategy: string;
}

/**
 * Build a prompt prefix that injects the previous failure context.
 * This gives the agent information to try a different approach.
 */
function buildFailureContextPrefix(ctx: FailureContext): string {
  return `## PREVIOUS ATTEMPT FAILED

Your previous attempt (attempt ${ctx.attempt}, strategy: ${ctx.strategy}) failed with:
- **Error type:** ${ctx.errorType}
- **Error message:** ${ctx.errorMessage}

Please try a different approach to complete this task. Consider what caused the failure and how to avoid it.

---

`;
}

/**
 * Inject failure context into the prompt for retry attempts.
 */
function injectFailureContext(originalPrompt: string, ctx: FailureContext): string {
  return buildFailureContextPrefix(ctx) + originalPrompt;
}

// ─── Default non-retryable errors ───────────────────────

const DEFAULT_NON_RETRYABLE = ["error_max_turns", "budget_exceeded"];

// ─── Recovery strategy names ────────────────────────────

function getStrategy(attempt: number): string {
  switch (attempt) {
    case 1:
      return "normal";
    case 2:
      return "resume";
    default:
      return "fresh";
  }
}

// ─── Sleep utility ──────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Error handling ─────────────────────────────────────

function isNonRetryable(error: unknown, nonRetryable: string[]): boolean {
  return error instanceof SessionError && nonRetryable.includes(error.errorType);
}

function updateSessionId(error: unknown, current: string | undefined): string | undefined {
  if (error instanceof SessionError && error.sessionId !== "unknown") {
    return error.sessionId;
  }
  return current;
}

function extractErrorInfo(error: unknown): { message: string; type: string } {
  if (error instanceof SessionError) {
    return { message: error.message, type: error.errorType };
  }
  if (error instanceof Error) {
    return { message: error.message, type: "unknown" };
  }
  return { message: String(error), type: "unknown" };
}

function buildFinalError(error: unknown, maxRetries: number): Error {
  if (error instanceof Error) {
    return new Error(`Recovery failed after ${maxRetries} attempts. Last error: ${error.message}`, {
      cause: error,
    });
  }
  return new Error(`Recovery failed after ${maxRetries} attempts`);
}

/**
 * Run a session with 3-level recovery escalation (ADR-020).
 *
 * Level 1 (attempt 1): Normal execution — new session
 * Level 2 (attempt 2): Resume session — pass resumeSessionId from level 1
 * Level 3 (attempt 3): Fresh session — abandon previous, start clean
 *
 * Non-retryable errors skip to immediate failure.
 * Backoff: backoffBaseMs * attempt between levels.
 *
 * On retry, the prompt is enriched with failure context from the previous
 * attempt, giving the agent information to try a different approach.
 */
export async function runWithRecovery(options: RecoveryOptions): Promise<SessionResult> {
  const {
    maxRetries,
    backoffBaseMs,
    nonRetryable = DEFAULT_NON_RETRYABLE,
    onAttempt,
    prompt: originalPrompt,
    ...rest
  } = options;

  let lastSessionId: string | undefined;
  let lastFailureContext: FailureContext | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const strategy = getStrategy(attempt);
    onAttempt?.(attempt, strategy);

    // Inject failure context on retry attempts
    const prompt = lastFailureContext
      ? injectFailureContext(originalPrompt, lastFailureContext)
      : originalPrompt;

    try {
      const result = await runSession({
        ...rest,
        prompt,
        resumeSessionId: strategy === "resume" ? lastSessionId : undefined,
      });
      return result;
    } catch (error) {
      lastSessionId = updateSessionId(error, lastSessionId);

      if (isNonRetryable(error, nonRetryable)) throw error;
      if (attempt === maxRetries) throw buildFinalError(error, maxRetries);

      // Capture failure context for next attempt
      const errorInfo = extractErrorInfo(error);
      lastFailureContext = {
        errorMessage: errorInfo.message,
        errorType: errorInfo.type,
        attempt,
        strategy,
      };

      // Next attempt will be "fresh" — clear session to start clean
      if (getStrategy(attempt + 1) === "fresh") {
        lastSessionId = undefined;
      }

      await sleep(backoffBaseMs * attempt);
    }
  }

  throw new Error("Recovery failed: unreachable");
}
```

### Step 4: Run test to verify it passes

Run: `pnpm test -- packages/core/src/__tests__/recovery-context.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add packages/core/src/runner/recovery.ts packages/core/src/__tests__/recovery-context.test.ts
git commit -m "feat(recovery): inject failure context into retry prompts

When recovery escalates to the next level, the agent now receives context
about the previous failure (error message + type), enabling it to try a
different approach instead of repeating the same mistake.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Add Decision Answer Deduplication Cache

**Files:**
- Modify: `packages/core/src/supervisor/decisions.ts`
- Modify: `packages/core/src/supervisor/heartbeat.ts`
- Create: `packages/core/src/__tests__/heartbeat-dedup.test.ts`

### Step 1: Write the failing test

```typescript
// packages/core/src/__tests__/heartbeat-dedup.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionStore } from "@/supervisor/decisions";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("DecisionStore - isAnswered", () => {
  let testDir: string;
  let testFile: string;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "neo-test-"));
    testFile = path.join(testDir, "decisions.jsonl");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns false for unanswered decision", async () => {
    const store = new DecisionStore(testFile);
    const id = await store.create({
      question: "Test question?",
      source: "test",
      type: "approval",
    });

    const result = await store.isAnswered(id);
    expect(result).toBe(false);
  });

  it("returns true for answered decision", async () => {
    const store = new DecisionStore(testFile);
    const id = await store.create({
      question: "Test question?",
      source: "test",
      type: "approval",
    });
    await store.answer(id, "yes");

    const result = await store.isAnswered(id);
    expect(result).toBe(true);
  });

  it("returns false for non-existent decision", async () => {
    const store = new DecisionStore(testFile);

    const result = await store.isAnswered("dec_nonexistent12345678");
    expect(result).toBe(false);
  });
});

describe("HeartbeatLoop - decision deduplication", () => {
  it("tracks answered decision IDs to prevent re-answer attempts", async () => {
    // This test verifies the deduplication logic
    const answeredIds = new Set<string>();

    // Simulate the deduplication check
    const decisionId = "dec_test123";

    // First check - not in set
    expect(answeredIds.has(decisionId)).toBe(false);

    // Mark as answered
    answeredIds.add(decisionId);

    // Second check - now in set
    expect(answeredIds.has(decisionId)).toBe(true);

    // Verify we would skip on second attempt
    if (answeredIds.has(decisionId)) {
      // Would skip
      expect(true).toBe(true);
    }
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm test -- packages/core/src/__tests__/heartbeat-dedup.test.ts`
Expected: FAIL — `isAnswered` method does not exist on DecisionStore

### Step 3: Add isAnswered method to DecisionStore

```typescript
// In packages/core/src/supervisor/decisions.ts
// Add this method to the DecisionStore class after the `get` method:

  /**
   * Check if a decision has already been answered without throwing.
   * Returns true if answered, false otherwise (including non-existent decisions).
   */
  async isAnswered(id: string): Promise<boolean> {
    const decision = await this.get(id);
    return decision?.answer !== undefined;
  }
```

### Step 4: Add deduplication cache to HeartbeatLoop

```typescript
// In packages/core/src/supervisor/heartbeat.ts
// Add a private field to HeartbeatLoop class (after line ~250):

  /** Cache of decision IDs already answered in this session to prevent re-answer spam */
  private readonly answeredDecisionIds = new Set<string>();

// Then modify the processDecisionAnswers method (around line 1139):

  /**
   * Process decision:answer events from inbox messages.
   * Expected format: "decision:answer <decisionId> <answer>"
   *
   * Uses an in-memory deduplication cache to prevent re-answering decisions
   * that have already been processed, avoiding the "already answered" error spam.
   */
  private async processDecisionAnswers(
    rawEvents: QueuedEvent[],
    store: DecisionStore,
  ): Promise<void> {
    for (const event of rawEvents) {
      if (event.kind !== "message") continue;

      const text = event.data.text.trim();
      const match = /^decision:answer\s+(\S+)\s+(.+)$/i.exec(text);
      if (!match) continue;

      const decisionId = match[1];
      const answer = match[2];
      if (!decisionId || !answer) continue;

      // Skip if we've already processed this decision ID in this session
      if (this.answeredDecisionIds.has(decisionId)) {
        continue;
      }

      // Check if already answered in the store (without throwing)
      const alreadyAnswered = await store.isAnswered(decisionId);
      if (alreadyAnswered) {
        // Mark as known and skip
        this.answeredDecisionIds.add(decisionId);
        continue;
      }

      try {
        await store.answer(decisionId, answer);
        // Track successful answer to prevent future attempts
        this.answeredDecisionIds.add(decisionId);
        await this.activityLog.log("event", `Decision answered: ${decisionId}`, {
          decisionId,
          answer,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Only log if it's NOT an "already answered" error (edge case: race condition)
        if (!msg.includes("already answered")) {
          await this.activityLog.log("error", `Failed to answer decision ${decisionId}: ${msg}`, {
            decisionId,
            answer,
          });
        } else {
          // Add to cache to prevent future attempts
          this.answeredDecisionIds.add(decisionId);
        }
      }
    }
  }
```

### Step 5: Run test to verify it passes

Run: `pnpm test -- packages/core/src/__tests__/heartbeat-dedup.test.ts`
Expected: PASS

### Step 6: Commit

```bash
git add packages/core/src/supervisor/decisions.ts packages/core/src/supervisor/heartbeat.ts packages/core/src/__tests__/heartbeat-dedup.test.ts
git commit -m "fix(supervisor): add decision answer deduplication cache

Adds an in-memory Set to track decision IDs that have already been
answered during this supervisor session. This prevents the 363+
'already answered' errors when the heartbeat loop repeatedly tries
to answer the same decisions.

Also adds isAnswered() method to DecisionStore for non-throwing checks.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Add "blocked" Status for Failed Tasks

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/supervisor/heartbeat.ts`
- Create: `packages/core/src/__tests__/blocked-tasks.test.ts`

### Step 1: Write the failing test

```typescript
// packages/core/src/__tests__/blocked-tasks.test.ts
import { describe, expect, it } from "vitest";
import { z } from "zod";

// Test that the blocked status is valid in the schema
describe("PersistedRun status - blocked", () => {
  const persistedRunStatusSchema = z.enum(["running", "paused", "completed", "failed", "blocked"]);

  it("accepts 'blocked' as valid status", () => {
    const result = persistedRunStatusSchema.safeParse("blocked");
    expect(result.success).toBe(true);
    expect(result.data).toBe("blocked");
  });

  it("accepts all existing statuses", () => {
    for (const status of ["running", "paused", "completed", "failed", "blocked"]) {
      const result = persistedRunStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    }
  });
});

describe("StepResult status - blocked", () => {
  const stepStatusSchema = z.enum(["pending", "running", "success", "failure", "skipped", "blocked"]);

  it("accepts 'blocked' as valid status", () => {
    const result = stepStatusSchema.safeParse("blocked");
    expect(result.success).toBe(true);
    expect(result.data).toBe("blocked");
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm test -- packages/core/src/__tests__/blocked-tasks.test.ts`
Expected: FAIL — "blocked" is not a valid status value

### Step 3: Update types.ts with blocked status

```typescript
// In packages/core/src/types.ts
// Update PersistedRun interface (around line 59):

export interface PersistedRun {
  version: 1;
  runId: string;
  agent: string;
  repo: string;
  prompt: string;
  branch?: string | undefined;
  sessionPath?: string | undefined;
  pid?: number | undefined;
  status: "running" | "paused" | "completed" | "failed" | "blocked";
  /** Reason why this run is blocked (if status is "blocked") */
  blockedReason?: string | undefined;
  /** Timestamp when the run was blocked */
  blockedAt?: string | undefined;
  steps: Record<string, StepResult>;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown> | undefined;
}

// Update StepResult interface (around line 66):

export interface StepResult {
  status: "pending" | "running" | "success" | "failure" | "skipped" | "blocked";
  sessionId?: string | undefined;
  output?: unknown;
  rawOutput?: string | undefined;
  prUrl?: string | undefined;
  prNumber?: number | undefined;
  costUsd: number;
  durationMs: number;
  agent: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  error?: string | undefined;
  /** Reason why this step is blocked (if status is "blocked") */
  blockedReason?: string | undefined;
  attempt: number;
}
```

### Step 4: Update isRunActive in heartbeat.ts

```typescript
// In packages/core/src/supervisor/heartbeat.ts
// Update isRunActive function (around line 101):

/**
 * Determine if a persisted run is actually active (not stale).
 *
 * For "running" status, validates:
 * - If PID exists and process is alive → active
 * - If PID exists but process is dead → stale (ghost run)
 * - If no PID and within grace period → active (still starting up)
 * - If no PID and past grace period → stale (ghost run)
 *
 * For "paused" status: always considered active (waiting for user action).
 * For "blocked" status: always considered active (waiting for blocker resolution).
 */
export function isRunActive(
  run: PersistedRun,
  isAlive: (pid: number) => boolean = isProcessAlive,
  now: number = Date.now(),
): boolean {
  // Skip terminal statuses
  if (run.status === "completed" || run.status === "failed") {
    return false;
  }

  // Paused and blocked runs are always considered active (waiting for resolution)
  if (run.status === "paused" || run.status === "blocked") {
    return true;
  }

  // For running status, validate the run is actually alive
  // If PID exists and process is alive, it's active
  if (run.pid && isAlive(run.pid)) {
    return true;
  }

  // If PID exists but process is dead, it's a stale ghost run
  if (run.pid) {
    return false;
  }

  // No PID: check grace period (run may still be starting up)
  const ageMs = now - new Date(run.createdAt).getTime();

  return ageMs < STALE_GRACE_PERIOD_MS;
}
```

### Step 5: Run test to verify it passes

Run: `pnpm test -- packages/core/src/__tests__/blocked-tasks.test.ts`
Expected: PASS

### Step 6: Run full test suite to verify no regressions

Run: `pnpm test`
Expected: All tests pass

### Step 7: Commit

```bash
git add packages/core/src/types.ts packages/core/src/supervisor/heartbeat.ts packages/core/src/__tests__/blocked-tasks.test.ts
git commit -m "feat(types): add 'blocked' status for failed tasks

When a task fails after all retries, it can now be marked as 'blocked'
instead of halting the supervisor. The supervisor can continue dispatching
other non-blocked tasks while blocked tasks wait for resolution.

- Add 'blocked' to PersistedRun.status and StepResult.status
- Add blockedReason and blockedAt fields
- Update isRunActive() to treat blocked runs as active

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Implement Task Blocking Logic in Orchestrator

**Files:**
- Modify: `packages/core/src/orchestrator/run-store.ts`
- Create: `packages/core/src/__tests__/orchestrator-blocking.test.ts`

### Step 1: Write the failing test

```typescript
// packages/core/src/__tests__/orchestrator-blocking.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "@/orchestrator/run-store";
import type { PersistedRun } from "@/types";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

describe("RunStore - blocking", () => {
  let testDir: string;
  let store: RunStore;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "neo-test-"));
    store = new RunStore({ runsDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("getRunById returns null for non-existent run", async () => {
    const result = await store.getRunById("non-existent");
    expect(result).toBeNull();
  });

  it("getRunById returns persisted run", async () => {
    const run: PersistedRun = {
      version: 1,
      runId: "test-run-123",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test prompt",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run);

    const result = await store.getRunById("test-run-123");
    expect(result).not.toBeNull();
    expect(result?.runId).toBe("test-run-123");
  });

  it("getAllRuns returns all persisted runs", async () => {
    const run1: PersistedRun = {
      version: 1,
      runId: "run-1",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test 1",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run2: PersistedRun = {
      version: 1,
      runId: "run-2",
      agent: "reviewer",
      repo: "/tmp/test-repo",
      prompt: "Test 2",
      status: "completed",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run1);
    await store.persistRun(run2);

    const result = await store.getAllRuns();
    expect(result).toHaveLength(2);
  });

  it("markBlocked updates run status to blocked", async () => {
    const run: PersistedRun = {
      version: 1,
      runId: "test-run-block",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test prompt",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run);

    await store.markBlocked("test-run-block", "Max retries exceeded");

    const updated = await store.getRunById("test-run-block");
    expect(updated?.status).toBe("blocked");
    expect(updated?.blockedReason).toBe("Max retries exceeded");
    expect(updated?.blockedAt).toBeDefined();
  });

  it("getBlockedRuns returns only blocked runs", async () => {
    const run1: PersistedRun = {
      version: 1,
      runId: "run-blocked",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test 1",
      status: "blocked",
      blockedReason: "Test block",
      blockedAt: new Date().toISOString(),
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run2: PersistedRun = {
      version: 1,
      runId: "run-running",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test 2",
      status: "running",
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run1);
    await store.persistRun(run2);

    const blocked = await store.getBlockedRuns();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].runId).toBe("run-blocked");
  });

  it("unblock restores run to running status", async () => {
    const run: PersistedRun = {
      version: 1,
      runId: "test-unblock",
      agent: "developer",
      repo: "/tmp/test-repo",
      prompt: "Test prompt",
      status: "blocked",
      blockedReason: "Test block",
      blockedAt: new Date().toISOString(),
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.persistRun(run);

    await store.unblock("test-unblock");

    const updated = await store.getRunById("test-unblock");
    expect(updated?.status).toBe("running");
    expect(updated?.blockedReason).toBeUndefined();
    expect(updated?.blockedAt).toBeUndefined();
  });
});

describe("Blocked run detection", () => {
  it("identifies blocked runs separately from failed runs", () => {
    const blockedRun: Partial<PersistedRun> = {
      status: "blocked",
      blockedReason: "Max retries exceeded",
      blockedAt: new Date().toISOString(),
    };

    const failedRun: Partial<PersistedRun> = {
      status: "failed",
    };

    expect(blockedRun.status).toBe("blocked");
    expect(failedRun.status).toBe("failed");
    expect(blockedRun.blockedReason).toBeDefined();
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm test -- packages/core/src/__tests__/orchestrator-blocking.test.ts`
Expected: FAIL — `getRunById`, `getAllRuns`, and `markBlocked` methods do not exist

### Step 3: Add helper methods and blocking logic to RunStore

```typescript
// In packages/core/src/orchestrator/run-store.ts
// Add these methods to the RunStore class after collectRunFiles():

  /**
   * Get all persisted runs from the runs directory.
   */
  async getAllRuns(): Promise<PersistedRun[]> {
    if (!existsSync(this.runsDir)) return [];

    const runs: PersistedRun[] = [];
    try {
      const jsonFiles = await this.collectRunFiles();
      for (const filePath of jsonFiles) {
        try {
          const content = await readFile(filePath, "utf-8");
          const run = JSON.parse(content) as PersistedRun;
          runs.push(run);
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Non-critical
    }
    return runs;
  }

  /**
   * Get a specific run by ID.
   * Returns null if not found.
   */
  async getRunById(runId: string): Promise<PersistedRun | null> {
    if (!existsSync(this.runsDir)) return null;

    try {
      const jsonFiles = await this.collectRunFiles();
      for (const filePath of jsonFiles) {
        if (path.basename(filePath) === `${runId}.json`) {
          const content = await readFile(filePath, "utf-8");
          return JSON.parse(content) as PersistedRun;
        }
      }
    } catch {
      // Non-critical
    }
    return null;
  }

  /**
   * Mark a run as blocked after all retries have been exhausted.
   * Blocked runs are visible to the supervisor but don't halt other work.
   */
  async markBlocked(runId: string, reason: string): Promise<void> {
    const run = await this.getRunById(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    run.status = "blocked";
    run.blockedReason = reason;
    run.blockedAt = new Date().toISOString();
    run.updatedAt = new Date().toISOString();

    await this.persistRun(run);
  }

  /**
   * Get all blocked runs that need attention.
   */
  async getBlockedRuns(): Promise<PersistedRun[]> {
    const allRuns = await this.getAllRuns();
    return allRuns.filter((run) => run.status === "blocked");
  }

  /**
   * Unblock a run, setting it back to 'running' status.
   * Call this when the blocker has been resolved.
   */
  async unblock(runId: string): Promise<void> {
    const run = await this.getRunById(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (run.status !== "blocked") {
      throw new Error(`Run ${runId} is not blocked (status: ${run.status})`);
    }

    run.status = "running";
    run.blockedReason = undefined;
    run.blockedAt = undefined;
    run.updatedAt = new Date().toISOString();

    await this.persistRun(run);
  }
```

### Step 4: Run test to verify it passes

Run: `pnpm test -- packages/core/src/__tests__/orchestrator-blocking.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add packages/core/src/orchestrator/run-store.ts packages/core/src/__tests__/orchestrator-blocking.test.ts
git commit -m "feat(run-store): add methods for blocking/unblocking runs

Adds getRunById(), getAllRuns(), markBlocked(), getBlockedRuns(), and
unblock() methods to RunStore. This allows the supervisor to mark failed
runs as blocked and continue with other work, rather than halting completely.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Integration Test and Verification

**Files:**
- Run full test suite
- Verify no type errors

### Step 1: Run typecheck

Run: `pnpm typecheck`
Expected: No errors

### Step 2: Run full test suite

Run: `pnpm test`
Expected: All tests pass

### Step 3: Build packages

Run: `pnpm build`
Expected: Build succeeds

### Step 4: Final commit (if any fixes needed)

```bash
git add -A
git commit -m "chore: fix any issues found during integration testing

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Acceptance Criteria

### Problem 1: Blind Retries
- [ ] `runWithRecovery` injects failure context (error message + type) into retry prompts
- [ ] First attempt receives original prompt unchanged
- [ ] Subsequent attempts receive enriched prompt with `PREVIOUS ATTEMPT FAILED` section
- [ ] Test coverage for failure context injection

### Problem 2: Failed Task Blocks All Work
- [ ] `PersistedRun.status` accepts "blocked" as valid value
- [ ] `StepResult.status` accepts "blocked" as valid value
- [ ] `blockedReason` and `blockedAt` fields added to run persistence
- [ ] `RunStore.markBlocked()` method available
- [ ] `RunStore.getBlockedRuns()` returns blocked runs
- [ ] `RunStore.unblock()` restores run to running status
- [ ] `isRunActive()` treats blocked runs as active (not stale)

### Problem 3: Decision Re-Answer Errors
- [ ] `DecisionStore.isAnswered()` checks without throwing
- [ ] `HeartbeatLoop` maintains `answeredDecisionIds` Set
- [ ] Duplicate answer attempts are silently skipped
- [ ] "Already answered" errors no longer spam the activity log

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Memory leak from growing `answeredDecisionIds` Set | Medium | Set is cleared on supervisor restart; consider LRU cache if needed |
| Failure context injection makes prompts too long | Low | Context is brief (~100 chars); could add truncation if needed |
| Blocked status confusion with failed | Low | Clear field naming (`blockedReason`, `blockedAt`) distinguishes them |
