import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_runs_watch_test__");

vi.mock("@neotx/core", async () => {
  const actual = await vi.importActual<typeof import("@neotx/core")>("@neotx/core");
  return {
    ...actual,
    getRunsDir: () => TMP_DIR,
  };
});

vi.mock("../output.js", () => ({
  printError: vi.fn(),
  printJson: vi.fn(),
  printTable: vi.fn(),
}));

vi.mock("../repo-filter.js", () => ({
  resolveRepoFilter: vi.fn().mockResolvedValue({ mode: "all" }),
  loadRunsFiltered: vi.fn(),
}));

function makePersistedRun(
  runId: string,
  status: "running" | "paused" | "completed" | "failed" | "blocked",
) {
  return {
    runId,
    status,
    repo: "/tmp/test-repo",
    prompt: "test prompt",
    agent: "developer",
    branch: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: {},
  };
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
  process.exitCode = undefined;
  process.removeAllListeners("SIGINT");
});

describe("neo runs --watch", () => {
  it("errors when --watch is used without a runId", async () => {
    const { printError } = await import("../output.js");
    const { loadRunsFiltered } = await import("../repo-filter.js");

    (loadRunsFiltered as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePersistedRun("run-001", "running"),
    ]);

    const { default: runsCommand } = await import("../commands/runs.js");

    await runsCommand.run?.({
      args: {
        watch: true,
        runId: undefined,
        output: undefined,
        repo: undefined,
        last: undefined,
        status: undefined,
        short: false,
        _: [],
      },
    } as never);

    expect(process.exitCode).toBe(1);
    expect(printError).toHaveBeenCalledWith("--watch requires a runId argument.");
  });

  it("errors when --watch is combined with --output json", async () => {
    const { printError } = await import("../output.js");
    const { loadRunsFiltered } = await import("../repo-filter.js");

    (loadRunsFiltered as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePersistedRun("run-002", "running"),
    ]);

    const { default: runsCommand } = await import("../commands/runs.js");

    await runsCommand.run?.({
      args: {
        watch: true,
        runId: "run-002",
        output: "json",
        repo: undefined,
        last: undefined,
        status: undefined,
        short: false,
        _: [],
      },
    } as never);

    expect(process.exitCode).toBe(1);
    expect(printError).toHaveBeenCalledWith("--watch is not compatible with --output json.");
  });

  it("returns immediately when run status is already terminal", async () => {
    const { loadRunsFiltered } = await import("../repo-filter.js");
    const run = makePersistedRun("run-003", "completed");

    (loadRunsFiltered as ReturnType<typeof vi.fn>).mockResolvedValue([run]);

    // Write a file so findRunFilePath can locate it (not needed here, but consistent)
    await writeFile(path.join(TMP_DIR, "run-003.json"), JSON.stringify(run));

    const { default: runsCommand } = await import("../commands/runs.js");

    // Should resolve quickly without watching
    await runsCommand.run?.({
      args: {
        watch: true,
        runId: "run-003",
        output: undefined,
        repo: undefined,
        last: undefined,
        status: undefined,
        short: false,
        _: [],
      },
    } as never);

    expect(process.exitCode).toBeUndefined();
  });

  it("resolves when the watched file transitions to a terminal status", async () => {
    const { loadRunsFiltered } = await import("../repo-filter.js");
    const runId = "run-004";
    const runningRun = makePersistedRun(runId, "running");
    const completedRun = makePersistedRun(runId, "completed");

    const runFilePath = path.join(TMP_DIR, `${runId}.json`);
    await writeFile(runFilePath, JSON.stringify(runningRun));

    (loadRunsFiltered as ReturnType<typeof vi.fn>).mockResolvedValue([runningRun]);

    const { default: runsCommand } = await import("../commands/runs.js");

    // Start watch without awaiting
    const watchPromise = runsCommand.run?.({
      args: {
        watch: true,
        runId,
        output: undefined,
        repo: undefined,
        last: undefined,
        status: undefined,
        short: false,
        _: [],
      },
    } as never);

    // Wait for chokidar to set up the watcher
    await new Promise((r) => setTimeout(r, 200));

    // Overwrite the file with a completed status
    await writeFile(runFilePath, JSON.stringify(completedRun));

    // Now await the watch promise — should resolve
    await watchPromise;

    expect(process.exitCode).toBeUndefined();
  });
});
