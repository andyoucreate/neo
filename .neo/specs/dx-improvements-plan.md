# DX Improvements Implementation Plan

**Goal:** Implement 4 developer experience improvements: `neo do` command alias, macOS notifications, structured failure reports, and enhanced memory/log UX.

**Architecture:** Thin CLI wrappers over existing @neotx/core functionality. Feature 1-2 are CLI-only. Feature 3 adds a new schema and inbox writer in core. Feature 4 extends existing CLI commands with new subcommands and flags.

**Tech Stack:** TypeScript, citty (CLI framework), Zod (schemas), osascript (macOS notifications)

---

## File Structure Mapping

### Feature 1: `neo do` command
- Create: `packages/cli/src/commands/do.ts`
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/src/daemon-utils.ts` (shared utility)
- Modify: `packages/cli/src/commands/supervise.ts` (refactor to use shared utility)

### Feature 2: Completion & failure notifications
- Create: `packages/core/src/supervisor/notify.ts`
- Modify: `packages/core/src/supervisor/index.ts`

### Feature 3: Structured failure report
- Modify: `packages/core/src/supervisor/schemas.ts`
- Create: `packages/core/src/supervisor/failure-report.ts`
- Modify: `packages/core/src/supervisor/index.ts`

### Feature 4: Heartbeat integration (consolidated)
- Modify: `packages/core/src/supervisor/heartbeat.ts` (single task for all heartbeat changes)

### Feature 5: Memory & log UX improvements
- Modify: `packages/core/src/supervisor/memory/entry.ts` (add SearchResult interface)
- Modify: `packages/core/src/supervisor/memory/store.ts`
- Modify: `packages/core/src/supervisor/memory/index.ts`
- Modify: `packages/cli/src/commands/memory.ts`
- Modify: `packages/cli/src/commands/log.ts`

---

## Feature 1: `neo do` Command

### Task 1.0: Extract shared daemon utilities

**Files:**
- Create: `packages/cli/src/daemon-utils.ts`
- Modify: `packages/cli/src/commands/supervise.ts`

This task extracts daemon-related utilities to avoid code duplication between `supervise.ts` and the new `do.ts` command.

- [ ] **Step 1: Create daemon-utils.ts**

```typescript
// packages/cli/src/daemon-utils.ts
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSupervisorDir,
  getSupervisorStatePath,
  isProcessAlive,
  supervisorDaemonStateSchema,
  type SupervisorDaemonState,
} from "@neotx/core";
import { printSuccess } from "./output.js";

/**
 * Read and parse supervisor daemon state.
 */
export async function readDaemonState(name: string): Promise<SupervisorDaemonState | null> {
  const statePath = getSupervisorStatePath(name);
  if (!existsSync(statePath)) return null;
  try {
    const raw = await readFile(statePath, "utf-8");
    return supervisorDaemonStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Check if daemon is running by verifying state and process liveness.
 */
export async function isDaemonRunning(name: string): Promise<SupervisorDaemonState | null> {
  const state = await readDaemonState(name);
  if (!state || state.status === "stopped") return null;
  if (!isProcessAlive(state.pid)) return null;
  return state;
}

/**
 * Start a supervisor daemon in detached mode.
 * Returns the child process PID.
 */
export async function startDaemonDetached(name: string): Promise<number> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(__dirname, "daemon", "supervisor-worker.js");
  const packageRoot = path.resolve(__dirname, "..");

  const logDir = getSupervisorDir(name);
  await mkdir(logDir, { recursive: true });
  const logFd = openSync(path.join(logDir, "daemon.log"), "a");

  const child = spawn(process.execPath, [workerPath, name], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: packageRoot,
    env: process.env,
  });
  child.unref();
  closeSync(logFd);

  return child.pid ?? 0;
}
```

- [ ] **Step 2: Update supervise.ts to use shared utilities**

Replace the local `readState`, `isDaemonRunning`, and `startDaemon` functions with imports from daemon-utils.ts:

```typescript
// At top of packages/cli/src/commands/supervise.ts, replace imports:
import {
  isDaemonRunning,
  readDaemonState,
  startDaemonDetached,
} from "../daemon-utils.js";

// Remove the local readState, isDaemonRunning functions (lines 23-39)

// Update startDaemon function to use the shared utility:
async function startDaemon(name: string): Promise<void> {
  const running = await isDaemonRunning(name);
  if (running) {
    printError(`Supervisor "${name}" is already running (PID ${running.pid}).`);
    printError("Use --kill first, or run neo supervise to open TUI.");
    process.exitCode = 1;
    return;
  }

  // Clean up stale lock
  const lockPath = getSupervisorLockPath(name);
  if (existsSync(lockPath)) {
    await rm(lockPath, { force: true });
  }

  const pid = await startDaemonDetached(name);
  const config = await loadGlobalConfig();

  printSuccess(`Supervisor "${name}" started (PID ${pid})`);
  console.log(`  Port:     ${config.supervisor.port}`);
  console.log(`  Health:   curl localhost:${config.supervisor.port}/health`);
  console.log(`  Webhook:  curl -X POST localhost:${config.supervisor.port}/webhook -d '{}'`);
  console.log(`  Logs:     ${getSupervisorDir(name)}/daemon.log`);
  console.log(`  TUI:      neo supervise`);
  console.log(`  Status:   neo supervise --status`);
  console.log(`  Stop:     neo supervise --kill`);
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/daemon-utils.ts packages/cli/src/commands/supervise.ts
git commit -m "refactor(cli): extract daemon utilities for reuse

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

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

// Mock daemon-utils to avoid spawning real processes
vi.mock("../daemon-utils.js", () => ({
  isDaemonRunning: vi.fn(),
  startDaemonDetached: vi.fn().mockResolvedValue(12345),
}));

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(path.join(TMP_DIR, "supervisor"), { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("neo do command", () => {
  it("sends message to supervisor inbox when running", async () => {
    const { isDaemonRunning } = await import("../daemon-utils.js");
    (isDaemonRunning as ReturnType<typeof vi.fn>).mockResolvedValue({
      pid: process.pid,
      status: "running",
    });

    const { default: doCommand } = await import("../commands/do.js");

    await doCommand.run?.({
      args: { task: "add rate limiter", name: "supervisor", detach: false },
    });

    const inboxPath = path.join(TMP_DIR, "supervisor", "inbox.jsonl");
    expect(existsSync(inboxPath)).toBe(true);

    const content = await readFile(inboxPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.text).toBe("add rate limiter");
    expect(entry.from).toBe("api");
  });

  it("fails when supervisor is not running and --detach not provided", async () => {
    const { isDaemonRunning } = await import("../daemon-utils.js");
    (isDaemonRunning as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { default: doCommand } = await import("../commands/do.js");

    await doCommand.run?.({
      args: { task: "test task", name: "supervisor", detach: false },
    });

    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("starts daemon when --detach is provided and supervisor not running", async () => {
    const { isDaemonRunning, startDaemonDetached } = await import("../daemon-utils.js");
    (isDaemonRunning as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null) // First check: not running
      .mockResolvedValueOnce({ pid: 12345, status: "running" }); // After start

    const { default: doCommand } = await import("../commands/do.js");

    await doCommand.run?.({
      args: { task: "test task", name: "supervisor", detach: true },
    });

    expect(startDaemonDetached).toHaveBeenCalledWith("supervisor");
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
import { appendFile } from "node:fs/promises";
import {
  getSupervisorActivityPath,
  getSupervisorInboxPath,
} from "@neotx/core";
import { defineCommand } from "citty";
import { isDaemonRunning, startDaemonDetached } from "../daemon-utils.js";
import { printError, printSuccess } from "../output.js";

const DEFAULT_NAME = "supervisor";

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

    let running = await isDaemonRunning(name);

    if (!running) {
      if (args.detach) {
        const pid = await startDaemonDetached(name);
        printSuccess(`Supervisor "${name}" started (PID ${pid})`);
        // Wait briefly for daemon to initialize
        await new Promise((r) => setTimeout(r, 1500));
        running = await isDaemonRunning(name);
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

In `packages/cli/src/index.ts`, add to subCommands:

```typescript
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

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd, _args, callback) => {
    callback?.(null, "", "");
    return { unref: vi.fn() };
  }),
}));

// Import after mocking
const { notify, shouldNotify, notifyRunComplete, notifyRunFailed } = await import(
  "@/supervisor/notify"
);

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

  describe("notifyRunComplete", () => {
    it("sends success notification", async () => {
      const { execFile } = await import("node:child_process");

      await notifyRunComplete("run_123", "All tests passed");

      expect(execFile).toHaveBeenCalled();
    });
  });

  describe("notifyRunFailed", () => {
    it("sends failure notification", async () => {
      const { execFile } = await import("node:child_process");

      await notifyRunFailed("run_123", "Build failed");

      expect(execFile).toHaveBeenCalled();
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

- [ ] **Step 5: Export from index.ts**

In `packages/core/src/supervisor/index.ts`, add:

```typescript
// ─── Notifications ───────────────────────────────────────
export { notify, notifyRunComplete, notifyRunFailed, shouldNotify } from "./notify.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/supervisor/notify.ts packages/core/src/__tests__/notify.test.ts packages/core/src/supervisor/index.ts
git commit -m "feat(core): add macOS notification utility for daemon mode

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Feature 3: Structured Failure Report

### Task 3.1: Add failure report schema

**Files:**
- Modify: `packages/core/src/supervisor/schemas.ts`

- [ ] **Step 1: Add failure report schema to schemas.ts**

Add at the end of the file, before the last export:

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
import {
  buildSuggestedAction,
  classifyError,
  createFailureReport,
  writeFailureReport,
} from "@/supervisor/failure-report";
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

describe("classifyError", () => {
  it("classifies timeout errors", () => {
    expect(classifyError("Operation timed out after 30s")).toBe("timeout");
  });

  it("classifies budget errors", () => {
    expect(classifyError("Budget exceeded: $5.00 limit")).toBe("budget");
  });

  it("classifies spawn errors", () => {
    expect(classifyError("Module not found: lodash")).toBe("spawn_error");
  });

  it("classifies recovery exhausted", () => {
    expect(classifyError("Max retries exceeded")).toBe("recovery_exhausted");
  });

  it("defaults to unknown", () => {
    expect(classifyError("Something weird happened")).toBe("unknown");
  });
});

describe("buildSuggestedAction", () => {
  it("suggests recovery for spawn_error", () => {
    const action = buildSuggestedAction("spawn_error", "Module not found");
    expect(action).toContain("dependencies");
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

describe("createFailureReport", () => {
  it("creates a complete failure report", () => {
    const report = createFailureReport({
      runId: "run_xyz",
      task: "Deploy to prod",
      reason: "Connection timed out",
      attemptCount: 2,
      costUsd: 1.23,
    });

    expect(report.type).toBe("failure-report");
    expect(report.runId).toBe("run_xyz");
    expect(report.lastErrorType).toBe("timeout");
    expect(report.suggestedAction).toContain("timeout");
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
export function buildSuggestedAction(errorType: ErrorType, _reason: string): string {
  switch (errorType) {
    case "spawn_error":
      return "Check that all dependencies are installed. Run: pnpm install";

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

---

## Feature 4: Heartbeat Integration (Consolidated)

This task consolidates all heartbeat.ts modifications into a single atomic change to avoid merge conflicts and ensure consistency.

### Task 4.1: Integrate notifications and failure reports into heartbeat

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`

- [ ] **Step 1: Add imports at top of file**

Add these imports after the existing imports:

```typescript
import { createFailureReport, writeFailureReport } from "./failure-report.js";
import { notifyRunComplete, notifyRunFailed, shouldNotify } from "./notify.js";
```

- [ ] **Step 2: Update readPersistedRun return type**

Update the `readPersistedRun` method (around line 1174) to include task and attemptCount:

```typescript
/**
 * Read persisted run data to extract actual status, cost, and duration.
 * Returns null if the run file cannot be found or parsed.
 */
private async readPersistedRun(runId: string): Promise<{
  status: PersistedRun["status"];
  totalCostUsd: number;
  durationMs: number;
  output: string | undefined;
  task: string | undefined;
  attemptCount: number;
} | null> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return null;

  try {
    const entries = await readdir(runsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(runsDir, entry.name);
      const runPath = path.join(subDir, `${runId}.json`);

      if (existsSync(runPath)) {
        const raw = await readFile(runPath, "utf-8");
        const run = JSON.parse(raw) as PersistedRun;

        // Calculate total cost from all steps
        const totalCostUsd = Object.values(run.steps).reduce(
          (sum, step) => sum + (step.costUsd ?? 0),
          0,
        );

        // Calculate duration from createdAt to updatedAt
        const durationMs = new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime();

        // Get output from the last completed step
        const completedSteps = Object.values(run.steps).filter(
          (s) => s.status === "success" || s.status === "failure",
        );
        const lastStep = completedSteps[completedSteps.length - 1];
        const output =
          typeof lastStep?.rawOutput === "string" ? lastStep.rawOutput.slice(0, 1000) : undefined;

        // Extract task from run prompt or use fallback
        const task = run.prompt?.slice(0, 200) ?? "Unknown task";

        return {
          status: run.status,
          totalCostUsd,
          durationMs,
          output,
          task,
          attemptCount: Object.keys(run.steps).length,
        };
      }
    }
  } catch {
    // Non-critical — return null if we can't read run data
  }

  return null;
}
```

- [ ] **Step 3: Update emitCompletionEvents to pass additional context**

Update the `emitCompletionEvents` method (around line 619) to pass task and attemptCount:

```typescript
/**
 * Emit completion webhook events: heartbeat completed and run completed events.
 */
private async emitCompletionEvents(input: CompletionEventsInput): Promise<void> {
  // Emit heartbeat completed webhook event
  await this.emitHeartbeatCompleted({
    heartbeatNumber: input.heartbeatCount + 1,
    runsActive: input.activeRuns.length,
    todayUsd: input.todayCost + input.costUsd,
    limitUsd: this.config.supervisor.dailyCapUsd,
  });

  // Emit run completed events for any run completions processed
  for (const event of input.rawEvents) {
    if (event.kind === "run_complete") {
      const runData = await this.readPersistedRun(event.runId);
      await this.emitRunCompleted({
        runId: event.runId,
        status: runData?.status === "failed" ? "failed" : "completed",
        costUsd: runData?.totalCostUsd ?? 0,
        durationMs: runData?.durationMs ?? 0,
        output: runData?.output,
        task: runData?.task,
        attemptCount: runData?.attemptCount ?? 1,
      });
    }
  }
}
```

- [ ] **Step 4: Update emitRunCompleted with notifications and failure reports**

Replace the `emitRunCompleted` method (around line 1326) with:

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
      // Best-effort: notification failure should never crash daemon
    }
  }
}
```

- [ ] **Step 5: Run existing tests to ensure no regression**

Run: `pnpm test -- packages/core/src/__tests__/heartbeat`
Expected: PASS (all existing tests)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts
git commit -m "feat(core): integrate notifications and failure reports into heartbeat

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Feature 5: Memory & Log UX Improvements

### Task 5.1: Add SearchResult interface and update MemoryStore.search

**Files:**
- Modify: `packages/core/src/supervisor/memory/entry.ts`
- Modify: `packages/core/src/supervisor/memory/store.ts`
- Modify: `packages/core/src/supervisor/memory/index.ts`
- Test: `packages/core/src/__tests__/memory-store.test.ts`

- [ ] **Step 1: Add SearchResult interface to entry.ts**

Add at the end of `packages/core/src/supervisor/memory/entry.ts`:

```typescript
// ─── Search result (extends MemoryEntry with score) ─────

export interface SearchResult extends MemoryEntry {
  /** Relevance score from 0 to 1, where 1 is most relevant */
  score: number;
}
```

- [ ] **Step 2: Update search method in store.ts**

Replace the `search` method (around line 291) with a version that returns `SearchResult[]`:

```typescript
// ─── Search (async — semantic or FTS) ────────────────

async search(text: string, opts: MemoryQuery = {}): Promise<SearchResult[]> {
  // Try vector search first
  if (this.embedder && this.hasVec) {
    try {
      const [queryVec] = await this.embedder.embed([text]);
      const limit = opts.limit ?? 20;

      // Build scope/type filter for post-filtering
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

      // Post-filter by scope and type
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
        // Clamp to [0, 1] to handle edge cases
        score: Math.max(0, Math.min(1, 1 - row.distance)),
      }));
    } catch {
      // Fall through to FTS
    }
  }

  // Fallback: FTS5 full-text search
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

    if (filtered.length === 0) {
      return [];
    }

    // Normalize FTS rank to 0-1 score
    // FTS5 rank is negative, lower (more negative) is better match
    // We invert and normalize: best match gets score close to 1
    const ranks = filtered.map((r) => r.rank);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);

    return filtered.map((row) => {
      let score: number;
      if (minRank === maxRank) {
        // All same rank, give them equal high score
        score = 0.8;
      } else {
        // Normalize: minRank (best) -> 1, maxRank (worst) -> 0
        score = 1 - (row.rank - minRank) / (maxRank - minRank);
      }
      return {
        ...rowToEntry(row),
        score: Math.max(0, Math.min(1, score)),
      };
    });
  } catch {
    // FTS query syntax error — fall back to LIKE
    return this.query(opts).map((e) => ({ ...e, score: 0 }));
  }
}
```

- [ ] **Step 3: Add import for SearchResult in store.ts**

At the top of `packages/core/src/supervisor/memory/store.ts`, update the import:

```typescript
import type { Embedder } from "./embedder.js";
import type { MemoryEntry, MemoryQuery, MemoryStats, MemoryWriteInput, SearchResult } from "./entry.js";
```

- [ ] **Step 4: Add topAccessed method to MemoryStore**

Add this method to the MemoryStore class (after the `stats` method):

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

- [ ] **Step 5: Export SearchResult from index.ts**

In `packages/core/src/supervisor/memory/index.ts`, update exports:

```typescript
export type {
  Embedder,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryType,
  MemoryWriteInput,
  SearchResult,
} from "./entry.js";
```

- [ ] **Step 6: Add test for SearchResult**

Add to `packages/core/src/__tests__/memory-store.test.ts`:

```typescript
describe("search with scores", () => {
  it("returns SearchResult with score field", async () => {
    const store = createStore();
    await store.write({
      type: "fact",
      scope: "global",
      content: "TypeScript is a typed language",
      source: "dev",
    });
    await store.write({
      type: "fact",
      scope: "global",
      content: "Python is a dynamic language",
      source: "dev",
    });

    const results = await store.search("TypeScript typed");

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toHaveProperty("score");
    expect(typeof results[0]?.score).toBe("number");
    expect(results[0]?.score).toBeGreaterThanOrEqual(0);
    expect(results[0]?.score).toBeLessThanOrEqual(1);
    store.close();
  });
});

describe("topAccessed", () => {
  it("returns memories sorted by access count", async () => {
    const store = createStore();
    const id1 = await store.write({ type: "fact", scope: "global", content: "Low access", source: "user" });
    const id2 = await store.write({ type: "fact", scope: "global", content: "High access", source: "user" });

    // Access id2 multiple times
    store.markAccessed([id2]);
    store.markAccessed([id2]);
    store.markAccessed([id2]);

    const top = store.topAccessed(2);
    expect(top).toHaveLength(2);
    expect(top[0]?.id).toBe(id2);
    expect(top[0]?.accessCount).toBe(3);
    store.close();
  });
});
```

- [ ] **Step 7: Run tests**

Run: `pnpm test -- packages/core/src/__tests__/memory-store.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/supervisor/memory/entry.ts packages/core/src/supervisor/memory/store.ts packages/core/src/supervisor/memory/index.ts packages/core/src/__tests__/memory-store.test.ts
git commit -m "feat(core): add SearchResult with score and topAccessed method

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 5.2: Update CLI memory command

**Files:**
- Modify: `packages/cli/src/commands/memory.ts`

- [ ] **Step 1: Add --full and --limit flags to args**

In the `args` object, add:

```typescript
full: {
  type: "boolean",
  description: "Show full content without truncation",
  default: false,
},
limit: {
  type: "string",
  description: "Limit number of results (for recent command)",
},
```

- [ ] **Step 2: Update ParsedArgs interface**

```typescript
interface ParsedArgs {
  value: string | undefined;
  type: string | undefined;
  scope: string;
  source: string;
  expires: string | undefined;
  name: string;
  outcome: string | undefined;
  severity: string | undefined;
  category: string | undefined;
  tags: string | undefined;
  full: boolean;
  limit: string | undefined;
}
```

- [ ] **Step 3: Update formatResultsTable to support full content**

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

- [ ] **Step 4: Update handleSearch to display score**

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
        `${(m.score * 100).toFixed(0)}%`,
        truncate(m.content, maxContent),
        String(m.accessCount),
      ]),
    );
  } finally {
    store.close();
  }
}
```

- [ ] **Step 5: Add handleRecent function**

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

- [ ] **Step 6: Update handleStats to show top accessed**

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

- [ ] **Step 7: Update handleList to pass full flag**

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

- [ ] **Step 8: Update action description and switch**

```typescript
action: {
  type: "positional",
  description: "Action: write, forget, update, search, list, stats, recent",
  required: true,
},
```

Add to switch:
```typescript
case "recent":
  return handleRecent(parsed);
```

- [ ] **Step 9: Update parsed args in run function**

```typescript
const parsed: ParsedArgs = {
  value: args.value as string | undefined,
  type: args.type as string | undefined,
  scope: args.scope as string,
  source: args.source as string,
  expires: args.expires as string | undefined,
  name: args.name as string,
  outcome: args.outcome as string | undefined,
  severity: args.severity as string | undefined,
  category: args.category as string | undefined,
  tags: args.tags as string | undefined,
  full: args.full as boolean,
  limit: args.limit as string | undefined,
};
```

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/commands/memory.ts
git commit -m "feat(cli): add --full flag, relevance scores, recent subcommand, and top-accessed to memory

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### Task 5.3: Update CLI log command

**Files:**
- Modify: `packages/cli/src/commands/log.ts`

- [ ] **Step 1: Make type argument optional and add new flags**

Update args:
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
  name: {
    type: "string",
    description: "Supervisor instance name",
    default: "supervisor",
  },
  memory: {
    type: "boolean",
    description: "Override routing: send to memory target",
    default: false,
  },
  knowledge: {
    type: "boolean",
    description: "Override routing: send to knowledge target",
    default: false,
  },
  repo: {
    type: "string",
    description: "Repository path",
  },
  scope: {
    type: "string",
    description: "Repository scope for discovery entries (alias for --repo)",
  },
  procedure: {
    type: "boolean",
    description: "Also write as a procedure memory entry",
    default: false,
  },
  preview: {
    type: "boolean",
    description: "Preview the formatted inbox message before writing (for blocker type)",
    default: false,
  },
},
```

- [ ] **Step 2: Add printTable import and truncate function**

```typescript
import { printError, printSuccess, printTable } from "../output.js";

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}
```

- [ ] **Step 3: Add handleListRecent function**

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
```

- [ ] **Step 4: Update run function to handle no args, preview, and scope**

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

  const dir = getSupervisorDir(args.name);
  const now = new Date().toISOString();
  const id = randomUUID();

  // Resolve agent/run from env vars or flags
  const agent = process.env.NEO_AGENT_NAME ?? undefined;
  const runId = process.env.NEO_RUN_ID ?? undefined;
  const repo = (args.repo as string | undefined) ??
               (args.scope as string | undefined) ??
               process.env.NEO_REPOSITORY ??
               undefined;

  // Resolve target with flag overrides
  let target: "memory" | "knowledge" | "digest" = TARGET_MAP[type] ?? "digest";
  if (args.memory) target = "memory";
  if (args.knowledge) target = "knowledge";

  // 1. Always: append to activity.jsonl (existing behavior)
  const activityEntry = {
    id,
    type: TYPE_MAP[type] ?? "event",
    summary: args.message,
    timestamp: now,
  };
  await appendFile(`${dir}/activity.jsonl`, `${JSON.stringify(activityEntry)}\n`, "utf-8");

  // 2. Always: append to log-buffer.jsonl via shared helper
  await appendLogBuffer(dir, {
    id,
    type: type as "progress" | "action" | "decision" | "blocker" | "milestone" | "discovery",
    message: args.message,
    agent,
    runId,
    repo,
    target,
    timestamp: now,
  });

  // 3. Write to memory store for knowledge/procedure entries
  if (target === "knowledge" || args.procedure) {
    try {
      const store = new MemoryStore(path.join(dir, "memory.sqlite"));
      await store.write({
        type: args.procedure ? "procedure" : "fact",
        scope: repo ?? "global",
        content: args.message,
        source: agent ?? "user",
        runId,
      });
      store.close();
    } catch {
      // Best-effort — don't crash CLI if store write fails
    }
  }

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

  printSuccess(`Logged: [${type}] ${args.message.slice(0, 100)}`);
},
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/log.ts
git commit -m "feat(cli): add recent logs view, preview flag, and scope alias to log command

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Final Validation

### Task 6.1: Run full test suite

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
- [ ] Uses shared daemon utilities (no code duplication with supervise.ts)

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
- [ ] `neo memory search` shows relevance score (clamped 0-100%)
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
| SearchResult breaking change | SearchResult extends MemoryEntry, so existing code continues to work |
| FTS score normalization edge cases | Added clamping to [0, 1] and special case for equal ranks |
| Code duplication in daemon startup | Extracted to shared daemon-utils.ts |
| Heartbeat.ts merge conflicts | Consolidated all modifications into single atomic task |

---

## Breaking Changes

None. All changes are additive:
- `SearchResult` extends `MemoryEntry`, so existing code treating results as `MemoryEntry[]` continues to work
- New CLI flags and subcommands don't affect existing behavior
- Notification and failure report features are opt-in based on environment (daemon mode)
