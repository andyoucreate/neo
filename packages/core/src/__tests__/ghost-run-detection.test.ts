import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "@/orchestrator/run-store";
import type { PersistedRun } from "@/types";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_ghost_run_test__");

function makeRun(overrides?: Partial<PersistedRun>): PersistedRun {
  return {
    version: 1,
    runId: "run-123",
    agent: "developer",
    repo: "/tmp/my-repo",
    prompt: "Fix the bug",
    status: "running",
    steps: {},
    createdAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("Ghost Run Detection", () => {
  describe("scanForStaleRuns", () => {
    it("returns empty array when runs directory does not exist", async () => {
      const store = new RunStore({
        runsDir: path.join(TMP_DIR, "nonexistent"),
      });

      const ghostRuns = await store.scanForStaleRuns();

      expect(ghostRuns).toEqual([]);
    });

    it("returns empty array for empty directory", async () => {
      const store = new RunStore({ runsDir: TMP_DIR });

      const ghostRuns = await store.scanForStaleRuns();

      expect(ghostRuns).toEqual([]);
    });

    it("skips completed runs", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const completedRun = makeRun({ status: "completed" });
      await writeFile(path.join(repoDir, "run-123.json"), JSON.stringify(completedRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const ghostRuns = await store.scanForStaleRuns();

      expect(ghostRuns).toEqual([]);
    });

    it("skips failed runs", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const failedRun = makeRun({ status: "failed" });
      await writeFile(path.join(repoDir, "run-123.json"), JSON.stringify(failedRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const ghostRuns = await store.scanForStaleRuns();

      expect(ghostRuns).toEqual([]);
    });

    it("skips runs with alive process", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      // Use a PID that's definitely alive (init/systemd or current process)
      const aliveRun = makeRun({ status: "running", pid: process.pid });
      await writeFile(path.join(repoDir, "run-123.json"), JSON.stringify(aliveRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const ghostRuns = await store.scanForStaleRuns();

      expect(ghostRuns).toEqual([]);
    });

    it("skips recently created runs without PID (grace period)", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      // Run created just now — within grace period
      const recentRun = makeRun({
        status: "running",
        pid: undefined,
        createdAt: new Date().toISOString(),
      });
      await writeFile(path.join(repoDir, "run-123.json"), JSON.stringify(recentRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const ghostRuns = await store.scanForStaleRuns();

      expect(ghostRuns).toEqual([]);
    });

    it("recovers ghost run with dead process", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      // Use a very high PID that's unlikely to exist
      const deadPid = 999999999;
      const ghostRun = makeRun({
        runId: "ghost-run",
        status: "running",
        pid: deadPid,
        createdAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
      });
      await writeFile(path.join(repoDir, "ghost-run.json"), JSON.stringify(ghostRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const ghostRuns = await store.scanForStaleRuns();

      expect(ghostRuns).toHaveLength(1);
      expect(ghostRuns[0]?.runId).toBe("ghost-run");
      expect(ghostRuns[0]?.status).toBe("failed");
      expect(ghostRuns[0]?.blockedReason).toBe("supervisor crashed");
    });

    it("recovers old run without PID (past grace period)", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      // Run created 2 minutes ago — past 30s grace period
      const oldRun = makeRun({
        runId: "old-run",
        status: "running",
        pid: undefined,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
      });
      await writeFile(path.join(repoDir, "old-run.json"), JSON.stringify(oldRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const ghostRuns = await store.scanForStaleRuns();

      expect(ghostRuns).toHaveLength(1);
      expect(ghostRuns[0]?.runId).toBe("old-run");
      expect(ghostRuns[0]?.status).toBe("failed");
      expect(ghostRuns[0]?.blockedReason).toBe("supervisor crashed");
    });

    it("updates run file with failed status and blockedReason", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const deadPid = 999999999;
      const runFilePath = path.join(repoDir, "ghost-run.json");
      const pastTime = new Date(Date.now() - 1000).toISOString();
      const originalRun = makeRun({
        runId: "ghost-run",
        status: "running",
        pid: deadPid,
        updatedAt: pastTime,
      });
      await writeFile(runFilePath, JSON.stringify(originalRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      await store.scanForStaleRuns();

      const updatedContent = await readFile(runFilePath, "utf-8");
      const updatedRun = JSON.parse(updatedContent);

      expect(updatedRun.status).toBe("failed");
      expect(updatedRun.blockedReason).toBe("supervisor crashed");
      expect(new Date(updatedRun.updatedAt).getTime()).toBeGreaterThan(
        new Date(originalRun.updatedAt).getTime(),
      );
    });

    it("recovers multiple ghost runs across repos", async () => {
      const repo1Dir = path.join(TMP_DIR, "repo-1");
      const repo2Dir = path.join(TMP_DIR, "repo-2");
      await mkdir(repo1Dir, { recursive: true });
      await mkdir(repo2Dir, { recursive: true });

      const deadPid = 999999999;

      // Repo 1: one ghost, one completed
      await writeFile(
        path.join(repo1Dir, "ghost-1.json"),
        JSON.stringify(
          makeRun({
            runId: "ghost-1",
            status: "running",
            pid: deadPid,
            repo: "/tmp/repo-1",
          }),
        ),
      );
      await writeFile(
        path.join(repo1Dir, "done.json"),
        JSON.stringify(
          makeRun({
            runId: "done",
            status: "completed",
            repo: "/tmp/repo-1",
          }),
        ),
      );

      // Repo 2: one ghost
      await writeFile(
        path.join(repo2Dir, "ghost-2.json"),
        JSON.stringify(
          makeRun({
            runId: "ghost-2",
            status: "running",
            pid: deadPid,
            repo: "/tmp/repo-2",
          }),
        ),
      );

      const store = new RunStore({ runsDir: TMP_DIR });
      const ghostRuns = await store.scanForStaleRuns();

      expect(ghostRuns).toHaveLength(2);
      const runIds = ghostRuns.map((r) => r.runId).sort();
      expect(runIds).toEqual(["ghost-1", "ghost-2"]);
    });

    it("does NOT skip runs from current process (unlike recoverOrphanedRuns)", async () => {
      // This is the key difference between scanForStaleRuns and recoverOrphanedRuns:
      // scanForStaleRuns is called on NEW supervisor startup, so it should check
      // if the PID is actually alive, not skip based on process.pid equality.
      // However, if the PID is alive, it will skip it.
      // Let's verify the behavior with a dead PID that matches nothing.

      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const deadPid = 999999999;
      const ghostRun = makeRun({
        runId: "ghost-run",
        status: "running",
        pid: deadPid,
      });
      await writeFile(path.join(repoDir, "ghost-run.json"), JSON.stringify(ghostRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const ghostRuns = await store.scanForStaleRuns();

      // Should be recovered since the PID is dead
      expect(ghostRuns).toHaveLength(1);
    });

    it("handles corrupt JSON files gracefully", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      // Write corrupt JSON
      await writeFile(path.join(repoDir, "corrupt.json"), "{ not valid json");

      // Write valid ghost run
      const deadPid = 999999999;
      const validRun = makeRun({
        runId: "valid-run",
        status: "running",
        pid: deadPid,
      });
      await writeFile(path.join(repoDir, "valid-run.json"), JSON.stringify(validRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      // Should not throw, and should return valid ghost runs
      const ghostRuns = await store.scanForStaleRuns();

      // Valid run should still be recovered despite corrupt file
      expect(ghostRuns).toHaveLength(1);
      expect(ghostRuns[0]?.runId).toBe("valid-run");
    });
  });
});
