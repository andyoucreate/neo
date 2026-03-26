# DX Improvements Implementation Plan

**Goal:** Implement 4 developer experience improvements: `neo do` command alias, macOS notifications, structured failure reports, and enhanced memory/log UX.

**Architecture:** Thin CLI wrappers over existing @neotx/core functionality. Feature 1-2 are CLI-only. Feature 3 adds a new schema and inbox writer in core. Feature 4 extends existing CLI commands with new subcommands and flags.

**Tech Stack:** TypeScript, citty (CLI framework), Zod (schemas), osascript (macOS notifications)

---

## File Structure Mapping

### Feature 1: `neo do` command
- Create: `packages/cli/src/commands/do.ts`
- Modify: `packages/cli/src/index.ts`

### Feature 2: Completion & failure notifications
- Create: `packages/core/src/supervisor/notify.ts`
- Modify: `packages/core/src/supervisor/heartbeat.ts`
- Modify: `packages/core/src/supervisor/index.ts`

### Feature 3: Structured failure report
- Modify: `packages/core/src/supervisor/schemas.ts`
- Create: `packages/core/src/supervisor/failure-report.ts`
- Modify: `packages/core/src/supervisor/heartbeat.ts`
- Modify: `packages/core/src/supervisor/index.ts`

### Feature 4: Memory & log UX improvements
- Modify: `packages/cli/src/commands/memory.ts`
- Modify: `packages/cli/src/commands/log.ts`
- Modify: `packages/core/src/supervisor/memory/store.ts`

---

## Feature 1: `neo do` Command

### Task 1.1: Create `neo do` command

**Files:**
- Create: `packages/cli/src/commands/do.ts`
- Test: `packages/cli/src/__tests__/do.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/src/__tests__/do.test.ts
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_do_test__");

// Mock getSupervisorDir to use our temp directory
vi.mock("@neotx/core", async () => {
  const actual = await vi.importActual<typeof import("@neotx/core")>("@neotx/core");
  return {
    ...actual,
    getSupervisorDir: (name: string) => path.join(TMP_DIR, name),
    getSupervisorInboxPath: (name: string) => path.join(TMP_DIR, name, "inbox.jsonl"),
    getSupervisorActivityPath: (name: string) => path.join(TMP_DIR, name, "activity.jsonl"),
    getSupervisorStatePath: (name: string) => path.join(TMP_DIR, name, "state.json"),
    getSupervisorLockPath: (name: string) => path.join(TMP_DIR, name, "daemon.lock"),
    isProcessAlive: () => true,
  };
});

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(path.join(TMP_DIR, "supervisor"), { recursive: true });
  // Create mock state file to simulate running supervisor
  await writeFile(
    path.join(TMP_DIR, "supervisor", "state.json"),
    JSON.stringify({ pid: process.pid, status: "running", sessionId: "test-session" }),
    "utf-8",
  );
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("neo do command", () => {
  it("sends message to supervisor inbox", async () => {
    const { default: doCommand } = await import("../commands/do.js");

    // Simulate running the command
    await doCommand.run?.({ args: { task: "add rate limiter", name: "supervisor", detach: false } });

    const inboxPath = path.join(TMP_DIR, "supervisor", "inbox.jsonl");
    expect(existsSync(inboxPath)).toBe(true);

    const content = await readFile(inboxPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.text).toBe("add rate limiter");
    expect(entry.from).toBe("api");
  });

  it("fails when supervisor is not running", async () => {
    // Remove state file to simulate no supervisor
    await rm(path.join(TMP_DIR, "supervisor", "state.json"), { force: true });

    const { default: doCommand } = await import("../commands/do.js");

    await doCommand.run?.({ args: { task: "test task", name: "supervisor", detach: false } });

    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/cli/src/__tests__/do.test.ts`
Expected: FAIL with "Cannot find module '../commands/do.js'"

- [ ] **Step 3: Write the implementation**

```typescript
// packages/cli/src/commands/do.ts
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import {
  getSupervisorActivityPath,
  getSupervisorInboxPath,
  getSupervisorStatePath,
  isProcessAlive,
  supervisorDaemonStateSchema,
} from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printSuccess } from "../output.js";

const DEFAULT_NAME = "supervisor";

async function isDaemonRunning(name: string): Promise<boolean> {
  const statePath = getSupervisorStatePath(name);
  if (!existsSync(statePath)) return false;

  try {
    const raw = await readFile(statePath, "utf-8");
    const state = supervisorDaemonStateSchema.parse(JSON.parse(raw));
    if (state.status === "stopped") return false;
    return isProcessAlive(state.pid);
  } catch {
    return false;
  }
}

export default defineCommand({
  meta: {
    name: "do",
    description: "Send a task to the supervisor (alias for neo supervise --message)",
  },
  args: {
    task: {
      type: "positional",
      description: "Task description to send to the supervisor",
      required: true,
    },
    name: {
      type: "string",
      description: "Supervisor instance name",
      default: DEFAULT_NAME,
    },
    detach: {
      type: "boolean",
      alias: "d",
      description: "Start supervisor in background if not running",
      default: false,
    },
  },
  async run({ args }) {
    const name = args.name;
    const task = args.task as string;

    const running = await isDaemonRunning(name);

    if (!running) {
      if (args.detach) {
        // Start supervisor in detached mode
        const { spawn } = await import("node:child_process");
        const { fileURLToPath } = await import("node:url");
        const path = await import("node:path");
        const { mkdir, openSync, closeSync } = await import("node:fs");
        const { getSupervisorDir } = await import("@neotx/core");

        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const workerPath = path.join(__dirname, "daemon", "supervisor-worker.js");
        const packageRoot = path.resolve(__dirname, "..");

        const logDir = getSupervisorDir(name);
        await new Promise<void>((resolve) => mkdir(logDir, { recursive: true }, () => resolve()));
        const logFd = openSync(path.join(logDir, "daemon.log"), "a");
        const child = spawn(process.execPath, [workerPath, name], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          cwd: packageRoot,
          env: process.env,
        });
        child.unref();
        closeSync(logFd);

        printSuccess(`Supervisor "${name}" started (PID ${child.pid})`);
        // Wait briefly for daemon to initialize
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        printError(`No supervisor daemon running (name: ${name}).`);
        printError("Use --detach to start one, or run: neo supervise");
        process.exitCode = 1;
        return;
      }
    }

    // Send message to inbox
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const message = { id, from: "api" as const, text: task, timestamp };

    await appendFile(getSupervisorInboxPath(name), `${JSON.stringify(message)}\n`, "utf-8");

    // Also write to activity.jsonl for TUI visibility
    const activityEntry = { id, type: "message", summary: task, timestamp };
    await appendFile(getSupervisorActivityPath(name), `${JSON.stringify(activityEntry)}\n`, "utf-8");

    printSuccess(`Task sent to supervisor "${name}"`);
    console.log(`  Task: ${task.slice(0, 80)}${task.length > 80 ? "..." : ""}`);
    console.log(`  Status: neo supervise --status`);
    console.log(`  TUI: neo supervise`);
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/cli/src/__tests__/do.test.ts`
Expected: PASS

- [ ] **Step 5: Register the command in index.ts**

```typescript
// In packages/cli/src/index.ts, add to subCommands:
do: () => import("./commands/do.js").then((m) => m.default),
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/do.ts packages/cli/src/__tests__/do.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): add 'neo do' command as alias for supervise --message

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Feature 2: Completion & Failure Notifications

### Task 2.1: Create notification utility

**Files:**
- Create: `packages/core/src/supervisor/notify.ts`
- Test: `packages/core/src/__tests__/notify.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/notify.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { notify, shouldNotify } from "@/supervisor/notify";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn((cmd, args, callback) => {
    callback?.(null, "", "");
    return { unref: vi.fn() };
  }),
}));

describe("notify", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("shouldNotify", () => {
    it("returns false when stdout is TTY", () => {
      expect(shouldNotify(true)).toBe(false);
    });

    it("returns true when stdout is not TTY (daemon mode)", () => {
      expect(shouldNotify(false)).toBe(true);
    });
  });

  describe("notify", () => {
    it("calls osascript on macOS", async () => {
      const { execFile } = await import("node:child_process");

      await notify("Neo ✓", "Task completed");

      expect(execFile).toHaveBeenCalledWith(
        "osascript",
        expect.arrayContaining(["-e"]),
        expect.any(Function),
      );
    });

    it("does not throw on error", async () => {
      const { execFile } = await import("node:child_process");
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error) => void) => {
          callback(new Error("osascript not found"));
          return { unref: vi.fn() };
        },
      );

      // Should not throw
      await expect(notify("Title", "Message")).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/notify.test.ts`
Expected: FAIL with "Cannot find module '@/supervisor/notify'"

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/supervisor/notify.ts
import { execFile } from "node:child_process";

/**
 * Determine if notifications should be sent.
 * Only notify in daemon/detached mode (when stdout is not a TTY).
 */
export function shouldNotify(isTTY: boolean): boolean {
  return !isTTY;
}

/**
 * Send a macOS notification using osascript.
 * Also prints terminal bell to daemon.log.
 *
 * Best-effort: silently catches all errors to never crash the daemon.
 */
export async function notify(title: string, message: string): Promise<void> {
  // Print terminal bell to daemon.log (visible in log file)
  process.stdout.write("\x07");

  // macOS notification via osascript
  const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;

  return new Promise((resolve) => {
    try {
      const child = execFile("osascript", ["-e", script], (error) => {
        if (error) {
          // Best-effort: silently ignore errors (e.g., not on macOS)
          console.debug(`[notify] osascript failed: ${error.message}`);
        }
        resolve();
      });
      child.unref();
    } catch {
      // Best-effort: silently ignore errors
      resolve();
    }
  });
}

/**
 * Send a success notification for run completion.
 */
export async function notifyRunComplete(runId: string, summary: string): Promise<void> {
  await notify("Neo ✓", `${runId}: ${summary.slice(0, 100)}`);
}

/**
 * Send a failure notification for run failure.
 */
export async function notifyRunFailed(runId: string, reason: string): Promise<void> {
  await notify("Neo ✗", `${runId}: ${reason.slice(0, 100)}`);
}

/**
 * Escape special characters for AppleScript string literals.
 */
function escapeAppleScript(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/notify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/notify.ts packages/core/src/__tests__/notify.test.ts
git commit -m "feat(core): add macOS notification utility for daemon mode

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 2.2: Integrate notifications into heartbeat

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`
- Modify: `packages/core/src/supervisor/index.ts`

- [ ] **Step 1: Add notification imports and shouldNotify check**

In `packages/core/src/supervisor/heartbeat.ts`, add at the top imports section:

```typescript
import { notify, notifyRunComplete, notifyRunFailed, shouldNotify } from "./notify.js";
```

- [ ] **Step 2: Add notification logic to emitRunCompleted**

In the `emitRunCompleted` method (around line 1326), add notification after webhook emission:

```typescript
/** Emit RunCompletedEvent when processing run_complete events */
private async emitRunCompleted(opts: {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  output?: string;
  costUsd: number;
  durationMs: number;
}): Promise<void> {
  const event: RunCompletedEvent = {
    type: "run_completed",
    supervisorId: this.sessionId,
    runId: opts.runId,
    status: opts.status,
    output: opts.output?.slice(0, 1000),
    costUsd: opts.costUsd,
    durationMs: opts.durationMs,
  };
  await this.emitWebhookEvent(event);

  // Send macOS notification in daemon mode
  if (shouldNotify(process.stdout.isTTY ?? false)) {
    try {
      if (opts.status === "failed") {
        await notifyRunFailed(opts.runId, opts.output ?? "Unknown error");
      } else if (opts.status === "completed") {
        await notifyRunComplete(opts.runId, opts.output ?? "Completed successfully");
      }
    } catch {
      // Best-effort: notification failure should never crash daemon
    }
  }
}
```

- [ ] **Step 3: Export from index.ts**

In `packages/core/src/supervisor/index.ts`, add:

```typescript
// ─── Notifications ───────────────────────────────────────
export { notify, notifyRunComplete, notifyRunFailed, shouldNotify } from "./notify.js";
```

- [ ] **Step 4: Run existing tests to ensure no regression**

Run: `pnpm test -- packages/core/src/__tests__/heartbeat`
Expected: PASS (all existing tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts packages/core/src/supervisor/index.ts
git commit -m "feat(core): integrate notifications into heartbeat for run completion

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Feature 3: Structured Failure Report

### Task 3.1: Add failure report schema

**Files:**
- Modify: `packages/core/src/supervisor/schemas.ts`

- [ ] **Step 1: Add failure report schema to schemas.ts**

Add at the end of the file, before exports:

```typescript
// ─── Failure report (written to inbox.jsonl on run failure) ──

export const failureReportSchema = z.object({
  type: z.literal("failure-report"),
  runId: z.string(),
  task: z.string(),
  reason: z.string(),
  attemptCount: z.number().int().min(1),
  lastErrorType: z.enum(["spawn_error", "timeout", "budget", "recovery_exhausted", "unknown"]),
  suggestedAction: z.string(),
  costUsd: z.number(),
  timestamp: z.string(),
});

export type FailureReport = z.infer<typeof failureReportSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/supervisor/schemas.ts
git commit -m "feat(core): add FailureReport schema for structured failure tracking

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 3.2: Create failure report writer

**Files:**
- Create: `packages/core/src/supervisor/failure-report.ts`
- Test: `packages/core/src/__tests__/failure-report.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/failure-report.test.ts
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFailureReport, buildSuggestedAction } from "@/supervisor/failure-report";
import type { FailureReport } from "@/supervisor/schemas";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_failure_report_test__");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("writeFailureReport", () => {
  it("writes structured failure report to inbox.jsonl", async () => {
    const report: Omit<FailureReport, "timestamp"> = {
      type: "failure-report",
      runId: "run_abc123",
      task: "Implement auth middleware",
      reason: "Module not found: @auth/jwt",
      attemptCount: 3,
      lastErrorType: "spawn_error",
      suggestedAction: "Check that @auth/jwt is installed",
      costUsd: 0.43,
    };

    await writeFailureReport(TMP_DIR, report);

    const content = await readFile(path.join(TMP_DIR, "inbox.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());

    expect(parsed.type).toBe("failure-report");
    expect(parsed.runId).toBe("run_abc123");
    expect(parsed.attemptCount).toBe(3);
    expect(parsed.timestamp).toBeDefined();
  });
});

describe("buildSuggestedAction", () => {
  it("suggests recovery for spawn_error", () => {
    const action = buildSuggestedAction("spawn_error", "Module not found");
    expect(action).toContain("dependency");
  });

  it("suggests budget review for budget error", () => {
    const action = buildSuggestedAction("budget", "Budget exceeded");
    expect(action).toContain("budget");
  });

  it("suggests fresh session for recovery_exhausted", () => {
    const action = buildSuggestedAction("recovery_exhausted", "Max retries");
    expect(action).toContain("fresh session");
  });

  it("suggests timeout increase for timeout", () => {
    const action = buildSuggestedAction("timeout", "Operation timed out");
    expect(action).toContain("timeout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/failure-report.test.ts`
Expected: FAIL with "Cannot find module '@/supervisor/failure-report'"

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/supervisor/failure-report.ts
import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { FailureReport } from "./schemas.js";

type ErrorType = FailureReport["lastErrorType"];

/**
 * Build a suggested action based on the error type and reason.
 */
export function buildSuggestedAction(errorType: ErrorType, reason: string): string {
  switch (errorType) {
    case "spawn_error":
      if (reason.toLowerCase().includes("module") || reason.toLowerCase().includes("not found")) {
        return "Check that all dependencies are installed. Run: pnpm install";
      }
      return "Review the error message and fix the underlying dependency or configuration issue.";

    case "timeout":
      return "Consider increasing the timeout limit or breaking the task into smaller steps.";

    case "budget":
      return "Review budget allocation. Consider increasing limits or optimizing token usage.";

    case "recovery_exhausted":
      return "All recovery attempts failed. Try a fresh session with simplified instructions.";

    default:
      return "Review the error details and consider manual intervention.";
  }
}

/**
 * Classify an error message into an error type.
 */
export function classifyError(reason: string): ErrorType {
  const lower = reason.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "timeout";
  }
  if (lower.includes("budget") || lower.includes("cost") || lower.includes("exceeded")) {
    return "budget";
  }
  if (lower.includes("spawn") || lower.includes("module") || lower.includes("not found")) {
    return "spawn_error";
  }
  if (lower.includes("recovery") || lower.includes("max retries") || lower.includes("attempts")) {
    return "recovery_exhausted";
  }

  return "unknown";
}

/**
 * Write a structured failure report to inbox.jsonl.
 * This surfaces the failure as an actionable item in the supervisor prompt.
 */
export async function writeFailureReport(
  supervisorDir: string,
  report: Omit<FailureReport, "timestamp">,
): Promise<void> {
  const entry: FailureReport = {
    ...report,
    timestamp: new Date().toISOString(),
  };

  const inboxPath = path.join(supervisorDir, "inbox.jsonl");

  try {
    await appendFile(inboxPath, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error) {
    // Best-effort: log but don't throw
    console.debug(
      `[failure-report] Failed to write: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Create a failure report from run completion data.
 */
export function createFailureReport(opts: {
  runId: string;
  task: string;
  reason: string;
  attemptCount: number;
  costUsd: number;
}): Omit<FailureReport, "timestamp"> {
  const errorType = classifyError(opts.reason);
  const suggestedAction = buildSuggestedAction(errorType, opts.reason);

  return {
    type: "failure-report",
    runId: opts.runId,
    task: opts.task,
    reason: opts.reason.slice(0, 500),
    attemptCount: opts.attemptCount,
    lastErrorType: errorType,
    suggestedAction,
    costUsd: opts.costUsd,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/failure-report.test.ts`
Expected: PASS

- [ ] **Step 5: Export from index.ts**

In `packages/core/src/supervisor/index.ts`, add:

```typescript
// ─── Failure reports ─────────────────────────────────────
export type { FailureReport } from "./schemas.js";
export { failureReportSchema } from "./schemas.js";
export {
  buildSuggestedAction,
  classifyError,
  createFailureReport,
  writeFailureReport,
} from "./failure-report.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/supervisor/failure-report.ts packages/core/src/__tests__/failure-report.test.ts packages/core/src/supervisor/index.ts
git commit -m "feat(core): add structured failure report writer

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 3.3: Integrate failure reports into heartbeat

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`

- [ ] **Step 1: Add failure report import**

In `packages/core/src/supervisor/heartbeat.ts`, add to imports:

```typescript
import { createFailureReport, writeFailureReport } from "./failure-report.js";
```

- [ ] **Step 2: Add failure report logic to emitRunCompleted**

Extend the `emitRunCompleted` method to write failure reports:

```typescript
/** Emit RunCompletedEvent when processing run_complete events */
private async emitRunCompleted(opts: {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  output?: string;
  costUsd: number;
  durationMs: number;
  task?: string;
  attemptCount?: number;
}): Promise<void> {
  const event: RunCompletedEvent = {
    type: "run_completed",
    supervisorId: this.sessionId,
    runId: opts.runId,
    status: opts.status,
    output: opts.output?.slice(0, 1000),
    costUsd: opts.costUsd,
    durationMs: opts.durationMs,
  };
  await this.emitWebhookEvent(event);

  // Write structured failure report for failed runs
  if (opts.status === "failed") {
    try {
      const report = createFailureReport({
        runId: opts.runId,
        task: opts.task ?? "Unknown task",
        reason: opts.output ?? "Unknown error",
        attemptCount: opts.attemptCount ?? 1,
        costUsd: opts.costUsd,
      });
      await writeFailureReport(this.supervisorDir, report);
    } catch {
      // Best-effort: failure report errors should never crash daemon
    }
  }

  // Send macOS notification in daemon mode
  if (shouldNotify(process.stdout.isTTY ?? false)) {
    try {
      if (opts.status === "failed") {
        await notifyRunFailed(opts.runId, opts.output ?? "Unknown error");
      } else if (opts.status === "completed") {
        await notifyRunComplete(opts.runId, opts.output ?? "Completed successfully");
      }
    } catch {
      // Best-effort
    }
  }
}
```

- [ ] **Step 3: Update emitCompletionEvents to pass additional context**

In `emitCompletionEvents`, update the `emitRunCompleted` call to include task info from persisted run:

```typescript
// Emit run completed events for any run completions processed
for (const event of input.rawEvents) {
  if (event.kind === "run_complete") {
    const runData = await this.readPersistedRun(event.runId);
    const emitOpts: Parameters<typeof this.emitRunCompleted>[0] = {
      runId: event.runId,
      status: runData?.status === "failed" ? "failed" : "completed",
      costUsd: runData?.totalCostUsd ?? 0,
      durationMs: runData?.durationMs ?? 0,
      task: runData?.task,
      attemptCount: runData?.attemptCount,
    };
    if (runData?.output) {
      emitOpts.output = runData.output;
    }
    await this.emitRunCompleted(emitOpts);
  }
}
```

- [ ] **Step 4: Update readPersistedRun return type**

Update the `readPersistedRun` method to include task and attemptCount:

```typescript
private async readPersistedRun(runId: string): Promise<{
  status: PersistedRun["status"];
  totalCostUsd: number;
  durationMs: number;
  output: string | undefined;
  task: string | undefined;
  attemptCount: number | undefined;
} | null> {
  // ... existing implementation ...

  return {
    status: run.status,
    totalCostUsd,
    durationMs,
    output,
    task: run.task,
    attemptCount: Object.keys(run.steps).length,
  };
}
```

- [ ] **Step 5: Run tests to ensure no regression**

Run: `pnpm test -- packages/core/src/__tests__/heartbeat`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts
git commit -m "feat(core): integrate structured failure reports into heartbeat

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Feature 4: Memory & Log UX Improvements

### Task 4.1: Add `neo memory list --full` flag

**Files:**
- Modify: `packages/cli/src/commands/memory.ts`

- [ ] **Step 1: Add --full flag to args**

In the `args` object, add:

```typescript
full: {
  type: "boolean",
  description: "Show full content without truncation",
  default: false,
},
```

- [ ] **Step 2: Update formatResultsTable to support full content**

Replace the `formatResultsTable` function:

```typescript
function formatResultsTable(results: MemoryEntry[], full = false): void {
  const maxContent = full ? 500 : 60;
  printTable(
    ["ID", "TYPE", "SCOPE", "CONTENT", "ACCESSES"],
    results.map((m) => [
      m.id,
      m.type,
      m.scope,
      truncate(m.content, maxContent),
      String(m.accessCount),
    ]),
  );
}
```

- [ ] **Step 3: Pass full flag to formatResultsTable calls**

Update `handleList` and `handleSearch` to pass the `full` flag:

```typescript
function handleList(args: ParsedArgs): void {
  const store = openStore(args.name);
  try {
    const results = store.query({
      ...(args.scope !== "global" && { scope: args.scope }),
      ...(args.type && { types: [args.type as MemoryType] }),
    });

    if (results.length === 0) {
      console.log("No memories found.");
      return;
    }

    formatResultsTable(results, args.full);
  } finally {
    store.close();
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/memory.ts
git commit -m "feat(cli): add --full flag to neo memory list

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 4.2: Add relevance score to `neo memory search`

**Files:**
- Modify: `packages/core/src/supervisor/memory/store.ts`
- Modify: `packages/cli/src/commands/memory.ts`

- [ ] **Step 1: Update MemoryStore.search to return scores**

In `packages/core/src/supervisor/memory/store.ts`, update the search method return type and implementation:

```typescript
// Update interface in entry.ts
export interface SearchResult extends MemoryEntry {
  score: number;
}

// In store.ts, update search method:
async search(text: string, opts: MemoryQuery = {}): Promise<SearchResult[]> {
  // Vector search path
  if (this.embedder && this.hasVec) {
    try {
      const [queryVec] = await this.embedder.embed([text]);
      const limit = opts.limit ?? 20;

      const candidates = this.db
        .prepare(
          `SELECT m.*, v.distance
         FROM memories_vec v
         JOIN memories m ON m.rowid = v.rowid
         WHERE v.embedding MATCH ?
         ORDER BY v.distance
         LIMIT ?`,
        )
        .all(new Float32Array(queryVec as number[]), limit * 3) as (RawMemoryRow & {
        distance: number;
      })[];

      const filtered = candidates.filter((row) => {
        if (opts.scope && row.scope !== opts.scope && row.scope !== "global") return false;
        if (
          opts.types &&
          opts.types.length > 0 &&
          !opts.types.includes(row.type as MemoryEntry["type"])
        )
          return false;
        return true;
      });

      return filtered.slice(0, limit).map((row) => ({
        ...rowToEntry(row),
        // Convert distance to similarity score (1 - distance for cosine)
        score: Math.max(0, 1 - row.distance),
      }));
    } catch {
      // Fall through to FTS
    }
  }

  // FTS fallback - use rank as score
  const limit = opts.limit ?? 20;
  const ftsQuery = text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w}"`)
    .join(" OR ");

  if (!ftsQuery) {
    return this.query(opts).map((e) => ({ ...e, score: 0 }));
  }

  try {
    const rows = this.db
      .prepare(
        `SELECT m.*, rank
       FROM memories_fts fts
       JOIN memories m ON m.rowid = fts.rowid
       WHERE memories_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      )
      .all(ftsQuery, limit) as (RawMemoryRow & { rank: number })[];

    const filtered = rows.filter((row) => {
      if (opts.scope && row.scope !== opts.scope && row.scope !== "global") return false;
      if (
        opts.types &&
        opts.types.length > 0 &&
        !opts.types.includes(row.type as MemoryEntry["type"])
      )
        return false;
      return true;
    });

    // Normalize FTS rank to 0-1 score (rank is negative, lower is better)
    const minRank = Math.min(...filtered.map((r) => r.rank), -1);
    const maxRank = Math.max(...filtered.map((r) => r.rank), 0);
    const range = maxRank - minRank || 1;

    return filtered.map((row) => ({
      ...rowToEntry(row),
      score: 1 - (row.rank - minRank) / range,
    }));
  } catch {
    return this.query(opts).map((e) => ({ ...e, score: 0 }));
  }
}
```

- [ ] **Step 2: Update handleSearch to display score**

In `packages/cli/src/commands/memory.ts`:

```typescript
async function handleSearch(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo memory search <query>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name, true);
  try {
    const results = await store.search(args.value, {
      ...(args.scope !== "global" && { scope: args.scope }),
      ...(args.type && { types: [args.type as MemoryType] }),
    });

    if (results.length === 0) {
      console.log("No memories found.");
      return;
    }

    // Display with relevance score
    const maxContent = args.full ? 500 : 60;
    printTable(
      ["ID", "TYPE", "SCOPE", "SCORE", "CONTENT", "ACCESSES"],
      results.map((m) => [
        m.id,
        m.type,
        m.scope,
        (m.score * 100).toFixed(0) + "%",
        truncate(m.content, maxContent),
        String(m.accessCount),
      ]),
    );
  } finally {
    store.close();
  }
}
```

- [ ] **Step 3: Export SearchResult type from index**

In `packages/core/src/supervisor/memory/index.ts`:

```typescript
export type { SearchResult } from "./entry.js";
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/supervisor/memory/store.ts packages/core/src/supervisor/memory/entry.ts packages/core/src/supervisor/memory/index.ts packages/cli/src/commands/memory.ts
git commit -m "feat(cli): show relevance score in neo memory search

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 4.3: Add `neo memory recent` subcommand

**Files:**
- Modify: `packages/cli/src/commands/memory.ts`

- [ ] **Step 1: Add handleRecent function**

```typescript
function handleRecent(args: ParsedArgs): void {
  const limit = args.limit ? Number(args.limit) : 10;

  const store = openStore(args.name);
  try {
    const results = store.query({
      ...(args.scope !== "global" && { scope: args.scope }),
      ...(args.type && { types: [args.type as MemoryType] }),
      sortBy: "createdAt",
      limit,
    });

    if (results.length === 0) {
      console.log("No memories found.");
      return;
    }

    formatResultsTable(results, args.full);
  } finally {
    store.close();
  }
}
```

- [ ] **Step 2: Add limit arg and recent case to switch**

In args:
```typescript
limit: {
  type: "string",
  description: "Limit number of results (for recent command)",
},
```

In switch:
```typescript
case "recent":
  return handleRecent(parsed);
```

- [ ] **Step 3: Update action description**

```typescript
action: {
  type: "positional",
  description: "Action: write, forget, update, search, list, stats, recent",
  required: true,
},
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/memory.ts
git commit -m "feat(cli): add 'neo memory recent' subcommand

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 4.4: Add `neo memory stats` top-accessed memories

**Files:**
- Modify: `packages/core/src/supervisor/memory/store.ts`
- Modify: `packages/cli/src/commands/memory.ts`

- [ ] **Step 1: Add topAccessed method to MemoryStore**

```typescript
/**
 * Get the top N most-accessed memories.
 */
topAccessed(limit = 5): MemoryEntry[] {
  const rows = this.db
    .prepare(
      `SELECT * FROM memories
       ORDER BY access_count DESC
       LIMIT ?`,
    )
    .all(limit) as RawMemoryRow[];

  return rows.map(rowToEntry);
}
```

- [ ] **Step 2: Update handleStats to show top accessed**

```typescript
function handleStats(args: ParsedArgs): void {
  const store = openStore(args.name);
  try {
    const s = store.stats();
    console.log(`Total memories: ${s.total}\n`);

    if (Object.keys(s.byType).length > 0) {
      printTable(
        ["TYPE", "COUNT"],
        Object.entries(s.byType).map(([t, c]) => [t, String(c)]),
      );
      console.log();
    }

    if (Object.keys(s.byScope).length > 0) {
      printTable(
        ["SCOPE", "COUNT"],
        Object.entries(s.byScope).map(([sc, c]) => [sc, String(c)]),
      );
      console.log();
    }

    // Show top 5 most-accessed memories
    const topAccessed = store.topAccessed(5);
    if (topAccessed.length > 0) {
      console.log("Top 5 most-accessed memories:\n");
      printTable(
        ["ID", "TYPE", "ACCESSES", "CONTENT"],
        topAccessed.map((m) => [
          m.id,
          m.type,
          String(m.accessCount),
          truncate(m.content, 50),
        ]),
      );
    }
  } finally {
    store.close();
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/supervisor/memory/store.ts packages/cli/src/commands/memory.ts
git commit -m "feat(cli): show top-accessed memories in neo memory stats

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 4.5: Add `neo log` default behavior (show recent logs)

**Files:**
- Modify: `packages/cli/src/commands/log.ts`

- [ ] **Step 1: Make type argument optional**

```typescript
args: {
  type: {
    type: "positional",
    description: "Report type: progress, action, decision, blocker, milestone, discovery (or omit to list recent)",
    required: false,
  },
  message: {
    type: "positional",
    description: "Message to log (required when type is provided)",
    required: false,
  },
  // ... rest of args
}
```

- [ ] **Step 2: Add handleListRecent function**

```typescript
async function handleListRecent(name: string, limit = 20): Promise<void> {
  const { readLogBuffer } = await import("@neotx/core");
  const dir = getSupervisorDir(name);

  const entries = await readLogBuffer(dir);
  const recent = entries.slice(-limit).reverse();

  if (recent.length === 0) {
    console.log("No log entries found.");
    return;
  }

  printTable(
    ["TIME", "TYPE", "AGENT", "MESSAGE"],
    recent.map((e) => [
      new Date(e.timestamp).toLocaleTimeString(),
      e.type,
      e.agent ?? "-",
      truncate(e.message, 60),
    ]),
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}
```

- [ ] **Step 3: Update run function to handle no args**

```typescript
async run({ args }) {
  const type = args.type as string | undefined;

  // No type = list recent logs
  if (!type) {
    await handleListRecent(args.name);
    return;
  }

  if (!VALID_TYPES.includes(type as LogType)) {
    printError(`Invalid type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (!args.message) {
    printError(`Usage: neo log ${type} <message>`);
    process.exitCode = 1;
    return;
  }

  // ... rest of existing logic
}
```

- [ ] **Step 4: Add printTable import**

```typescript
import { printError, printSuccess, printTable } from "../output.js";
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/log.ts
git commit -m "feat(cli): show recent log entries when running 'neo log' with no args

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 4.6: Add `neo log blocker --preview` flag

**Files:**
- Modify: `packages/cli/src/commands/log.ts`

- [ ] **Step 1: Add preview flag to args**

```typescript
preview: {
  type: "boolean",
  description: "Preview the formatted inbox message before writing (for blocker type)",
  default: false,
},
```

- [ ] **Step 2: Add preview logic in run function**

Before writing the blocker to inbox, add:

```typescript
// 4. If blocker: also append to inbox.jsonl (wake up heartbeat)
if (type === "blocker") {
  const inboxMessage = {
    id: randomUUID(),
    from: "agent" as const,
    text: `[BLOCKER]${agent ? ` (${agent})` : ""} ${args.message}`,
    timestamp: now,
  };

  if (args.preview) {
    console.log("\nPreview of inbox message:");
    console.log("─".repeat(60));
    console.log(JSON.stringify(inboxMessage, null, 2));
    console.log("─".repeat(60));
    console.log("\nUse without --preview to write to inbox.");
    return;
  }

  await appendFile(`${dir}/inbox.jsonl`, `${JSON.stringify(inboxMessage)}\n`, "utf-8");
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/log.ts
git commit -m "feat(cli): add --preview flag to neo log blocker

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 4.7: Add `neo log discovery --scope` flag

**Files:**
- Modify: `packages/cli/src/commands/log.ts`

- [ ] **Step 1: Verify scope handling**

The `--repo` flag already exists and is used for scope. For consistency, add an alias:

```typescript
scope: {
  type: "string",
  description: "Repository scope for discovery entries (alias for --repo)",
},
```

- [ ] **Step 2: Update run to use scope as fallback**

```typescript
const repo = (args.repo as string | undefined) ??
             (args.scope as string | undefined) ??
             process.env.NEO_REPOSITORY ??
             undefined;
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/log.ts
git commit -m "feat(cli): add --scope alias for neo log discovery

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Final Validation

### Task 5.1: Run full test suite

- [ ] **Step 1: Build all packages**

Run: `pnpm build`
Expected: SUCCESS

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: SUCCESS

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address test failures from DX improvements

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Acceptance Criteria

### Feature 1: `neo do`
- [ ] `neo do "add rate limiter"` sends message to supervisor inbox
- [ ] `--name` flag specifies supervisor name
- [ ] `--detach` flag starts supervisor if not running
- [ ] Concise output showing message sent and status commands

### Feature 2: Notifications
- [ ] macOS notification on run completion (title: "Neo ✓")
- [ ] macOS notification on run failure (title: "Neo ✗")
- [ ] Terminal bell printed to daemon.log
- [ ] Only triggers in daemon mode (not TTY)
- [ ] Best-effort: never crashes daemon

### Feature 3: Failure Reports
- [ ] Structured JSON written to inbox.jsonl on run failure
- [ ] Includes: runId, task, reason, attemptCount, lastErrorType, suggestedAction, costUsd
- [ ] Error types correctly classified
- [ ] Suggested actions are actionable

### Feature 4: Memory & Log UX
- [ ] `neo memory list --full` shows complete content
- [ ] `neo memory search` shows relevance score
- [ ] `neo memory recent` shows last N memories by date
- [ ] `neo memory stats` shows top 5 most-accessed memories
- [ ] `neo log` with no args shows recent log buffer entries
- [ ] `neo log blocker --preview` shows formatted message before writing
- [ ] `neo log discovery --scope` tags to specific repo

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| osascript not available on non-macOS | Silent fallback in try/catch |
| Notification spam in high-activity scenarios | Only notify on run completion, not heartbeat |
| Memory store schema changes | No schema changes needed, only new methods |
| Test isolation with mocked paths | Proper afterEach cleanup |
| Breaking existing behavior | All new features are additive, no existing APIs changed |
