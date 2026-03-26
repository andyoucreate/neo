import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_do_test__");

// Mock getSupervisorDir to use our temp directory
vi.mock("@neotx/core", async () => {
  const actual = await vi.importActual<typeof import("@neotx/core")>("@neotx/core");
  return {
    ...actual,
    getSupervisorDir: () => path.join(TMP_DIR, "supervisor"),
    getSupervisorInboxPath: () => path.join(TMP_DIR, "supervisor", "inbox.jsonl"),
    getSupervisorActivityPath: () => path.join(TMP_DIR, "supervisor", "activity.jsonl"),
    getSupervisorStatePath: () => path.join(TMP_DIR, "supervisor", "state.json"),
    getSupervisorLockPath: () => path.join(TMP_DIR, "supervisor", "daemon.lock"),
    isProcessAlive: () => true,
  };
});

// Mock daemon-utils to avoid spawning real processes
vi.mock("../daemon-utils.js", () => ({
  isDaemonRunning: vi.fn(),
  startDaemonDetached: vi.fn().mockResolvedValue(12345),
}));

// Mock output
vi.mock("../output.js", () => ({
  printError: vi.fn(),
  printSuccess: vi.fn(),
}));

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(path.join(TMP_DIR, "supervisor"), { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
  process.exitCode = undefined;
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
    } as never);

    const inboxPath = path.join(TMP_DIR, "supervisor", "inbox.jsonl");
    expect(existsSync(inboxPath)).toBe(true);

    const content = await readFile(inboxPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.text).toBe("add rate limiter");
    expect(entry.from).toBe("api");
  });

  it("also writes to activity.jsonl for TUI visibility", async () => {
    const { isDaemonRunning } = await import("../daemon-utils.js");
    (isDaemonRunning as ReturnType<typeof vi.fn>).mockResolvedValue({
      pid: process.pid,
      status: "running",
    });

    const { default: doCommand } = await import("../commands/do.js");

    await doCommand.run?.({
      args: { task: "add rate limiter", name: "supervisor", detach: false },
    } as never);

    const activityPath = path.join(TMP_DIR, "supervisor", "activity.jsonl");
    expect(existsSync(activityPath)).toBe(true);

    const content = await readFile(activityPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.type).toBe("message");
    expect(entry.summary).toBe("add rate limiter");
  });

  it("fails when supervisor is not running and --detach not provided", async () => {
    const { isDaemonRunning } = await import("../daemon-utils.js");
    (isDaemonRunning as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { default: doCommand } = await import("../commands/do.js");

    await doCommand.run?.({
      args: { task: "test task", name: "supervisor", detach: false },
    } as never);

    expect(process.exitCode).toBe(1);
  });

  it("starts daemon when --detach is provided and supervisor not running", async () => {
    const { isDaemonRunning, startDaemonDetached } = await import("../daemon-utils.js");
    (isDaemonRunning as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null) // First check: not running
      .mockResolvedValueOnce({ pid: 12345, status: "running" }); // After start

    const { default: doCommand } = await import("../commands/do.js");

    await doCommand.run?.({
      args: { task: "test task", name: "supervisor", detach: true },
    } as never);

    expect(startDaemonDetached).toHaveBeenCalledWith("supervisor");
  });
});
