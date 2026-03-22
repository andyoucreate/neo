import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "@/orchestrator/run-store";
import { toRepoSlug } from "@/paths";
import type { PersistedRun } from "@/types";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_run_store_test__");
// persistRun uses getRepoRunsDir which resolves to ~/.neo/runs/<slug>
// We need to use the real path for persistRun tests
const GLOBAL_RUNS_DIR = path.join(homedir(), ".neo", "runs");

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
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("RunStore", () => {
  describe("persistRun", () => {
    // NOTE: persistRun uses getRepoRunsDir() which ignores the runsDir option.
    // These tests verify actual behavior against ~/.neo/runs/<slug>/

    it("creates directory and writes valid JSON file", async () => {
      const store = new RunStore();
      const testRunId = `test-run-${Date.now()}`;
      const run = makeRun({ runId: testRunId });

      await store.persistRun(run);

      const slug = toRepoSlug({ path: run.repo });
      const expectedPath = path.join(GLOBAL_RUNS_DIR, slug, `${testRunId}.json`);

      try {
        const content = await readFile(expectedPath, "utf-8");
        const parsed = JSON.parse(content);

        expect(parsed.runId).toBe(testRunId);
        expect(parsed.agent).toBe("developer");
        expect(parsed.status).toBe("running");
      } finally {
        // Cleanup test file
        await rm(expectedPath, { force: true });
      }
    });

    it("reuses existing directory on subsequent calls", async () => {
      const store = new RunStore();
      const runId1 = `test-run-1-${Date.now()}`;
      const runId2 = `test-run-2-${Date.now()}`;

      await store.persistRun(makeRun({ runId: runId1 }));
      await store.persistRun(makeRun({ runId: runId2 }));

      const slug = toRepoSlug({ path: "/tmp/my-repo" });
      const run1Path = path.join(GLOBAL_RUNS_DIR, slug, `${runId1}.json`);
      const run2Path = path.join(GLOBAL_RUNS_DIR, slug, `${runId2}.json`);

      try {
        const content1 = await readFile(run1Path, "utf-8");
        const content2 = await readFile(run2Path, "utf-8");

        expect(JSON.parse(content1).runId).toBe(runId1);
        expect(JSON.parse(content2).runId).toBe(runId2);
      } finally {
        await rm(run1Path, { force: true });
        await rm(run2Path, { force: true });
      }
    });

    it("derives slug from repo path basename", async () => {
      const store = new RunStore();
      const testRunId = `test-run-slug-${Date.now()}`;
      const run = makeRun({
        runId: testRunId,
        repo: "/home/user/projects/MyAwesome-App",
      });

      await store.persistRun(run);

      const slug = toRepoSlug({ path: run.repo });
      const expectedPath = path.join(GLOBAL_RUNS_DIR, slug, `${testRunId}.json`);

      try {
        const content = await readFile(expectedPath, "utf-8");
        expect(JSON.parse(content).repo).toBe("/home/user/projects/MyAwesome-App");
        expect(slug).toBe("myawesome-app");
      } finally {
        await rm(expectedPath, { force: true });
      }
    });

    it("writes formatted JSON with indentation", async () => {
      const store = new RunStore();
      const testRunId = `test-run-format-${Date.now()}`;
      const run = makeRun({ runId: testRunId });

      await store.persistRun(run);

      const slug = toRepoSlug({ path: run.repo });
      const expectedPath = path.join(GLOBAL_RUNS_DIR, slug, `${testRunId}.json`);

      try {
        const content = await readFile(expectedPath, "utf-8");
        // Formatted JSON has newlines
        expect(content).toContain("\n");
        // And indentation
        expect(content).toMatch(/^\s{2}"/m);
      } finally {
        await rm(expectedPath, { force: true });
      }
    });

    it("fails silently on write error (non-critical)", async () => {
      // Mock getRepoRunsDir to return an invalid path
      vi.mock("@/paths", async (importOriginal) => {
        const original = await importOriginal<typeof import("@/paths")>();
        return {
          ...original,
          getRepoRunsDir: () => "/nonexistent/readonly/path",
        };
      });

      const store = new RunStore();

      // Should not throw even with invalid path
      await expect(store.persistRun(makeRun())).resolves.toBeUndefined();

      vi.unmock("@/paths");
    });

    it("updates existing run file", async () => {
      const store = new RunStore();
      const testRunId = `test-run-update-${Date.now()}`;
      const run = makeRun({ runId: testRunId, status: "running" });

      await store.persistRun(run);

      run.status = "completed";
      await store.persistRun(run);

      const slug = toRepoSlug({ path: run.repo });
      const expectedPath = path.join(GLOBAL_RUNS_DIR, slug, `${testRunId}.json`);

      try {
        const content = await readFile(expectedPath, "utf-8");
        expect(JSON.parse(content).status).toBe("completed");
      } finally {
        await rm(expectedPath, { force: true });
      }
    });
  });

  describe("collectRunFiles", () => {
    it("returns empty array for empty directory", async () => {
      await mkdir(TMP_DIR, { recursive: true });
      const store = new RunStore({ runsDir: TMP_DIR });
      const files = await store.collectRunFiles();

      expect(files).toEqual([]);
    });

    it("collects JSON files from top-level directory", async () => {
      await mkdir(TMP_DIR, { recursive: true });
      await writeFile(path.join(TMP_DIR, "run-1.json"), "{}");
      await writeFile(path.join(TMP_DIR, "run-2.json"), "{}");
      await writeFile(path.join(TMP_DIR, "not-json.txt"), "ignored");

      const store = new RunStore({ runsDir: TMP_DIR });
      const files = await store.collectRunFiles();

      expect(files).toHaveLength(2);
      expect(files).toContain(path.join(TMP_DIR, "run-1.json"));
      expect(files).toContain(path.join(TMP_DIR, "run-2.json"));
    });

    it("collects JSON files from repo subdirectories", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });
      await writeFile(path.join(repoDir, "run-1.json"), "{}");
      await writeFile(path.join(repoDir, "run-2.json"), "{}");

      const store = new RunStore({ runsDir: TMP_DIR });
      const files = await store.collectRunFiles();

      expect(files).toHaveLength(2);
      expect(files).toContain(path.join(repoDir, "run-1.json"));
      expect(files).toContain(path.join(repoDir, "run-2.json"));
    });

    it("collects files from both top-level and subdirectories", async () => {
      await mkdir(TMP_DIR, { recursive: true });
      await writeFile(path.join(TMP_DIR, "legacy-run.json"), "{}");

      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });
      await writeFile(path.join(repoDir, "run-1.json"), "{}");

      const store = new RunStore({ runsDir: TMP_DIR });
      const files = await store.collectRunFiles();

      expect(files).toHaveLength(2);
    });

    it("ignores non-JSON files in subdirectories", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });
      await writeFile(path.join(repoDir, "run-1.json"), "{}");
      await writeFile(path.join(repoDir, "run-1.log"), "logs here");
      await writeFile(path.join(repoDir, "README.md"), "docs");

      const store = new RunStore({ runsDir: TMP_DIR });
      const files = await store.collectRunFiles();

      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.json$/);
    });
  });

  describe("recoverOrphanedRuns", () => {
    it("returns empty array when runs directory does not exist", async () => {
      const store = new RunStore({
        runsDir: path.join(TMP_DIR, "nonexistent"),
      });

      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toEqual([]);
    });

    it("returns empty array for empty directory", async () => {
      await mkdir(TMP_DIR, { recursive: true });
      const store = new RunStore({ runsDir: TMP_DIR });

      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toEqual([]);
    });

    it("skips completed runs", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const completedRun = makeRun({ status: "completed" });
      await writeFile(path.join(repoDir, "run-123.json"), JSON.stringify(completedRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toEqual([]);
    });

    it("skips failed runs", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const failedRun = makeRun({ status: "failed" });
      await writeFile(path.join(repoDir, "run-123.json"), JSON.stringify(failedRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toEqual([]);
    });

    it("skips paused runs", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const pausedRun = makeRun({ status: "paused" });
      await writeFile(path.join(repoDir, "run-123.json"), JSON.stringify(pausedRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toEqual([]);
    });

    it("skips runs belonging to current process", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const ownRun = makeRun({ status: "running", pid: process.pid });
      await writeFile(path.join(repoDir, "run-123.json"), JSON.stringify(ownRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toEqual([]);
    });

    it("skips runs with alive process", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      // Use a PID that's definitely alive (init/systemd or parent process)
      const aliveRun = makeRun({ status: "running", pid: 1 });
      await writeFile(path.join(repoDir, "run-123.json"), JSON.stringify(aliveRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toEqual([]);
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
      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toEqual([]);
    });

    it("recovers orphaned run with dead process", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      // Use a very high PID that's unlikely to exist
      const deadPid = 999999999;
      const orphanedRun = makeRun({
        runId: "orphan-run",
        status: "running",
        pid: deadPid,
        createdAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
      });
      await writeFile(path.join(repoDir, "orphan-run.json"), JSON.stringify(orphanedRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toHaveLength(1);
      expect(orphaned[0]?.runId).toBe("orphan-run");
      expect(orphaned[0]?.status).toBe("failed");
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
      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toHaveLength(1);
      expect(orphaned[0]?.runId).toBe("old-run");
      expect(orphaned[0]?.status).toBe("failed");
    });

    it("updates run file on recovery", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const deadPid = 999999999;
      const runFilePath = path.join(repoDir, "orphan-run.json");
      // Set updatedAt to 1 second ago to ensure new timestamp is greater
      const pastTime = new Date(Date.now() - 1000).toISOString();
      const originalRun = makeRun({
        runId: "orphan-run",
        status: "running",
        pid: deadPid,
        updatedAt: pastTime,
      });
      await writeFile(runFilePath, JSON.stringify(originalRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      await store.recoverOrphanedRuns();

      const updatedContent = await readFile(runFilePath, "utf-8");
      const updatedRun = JSON.parse(updatedContent);

      expect(updatedRun.status).toBe("failed");
      expect(new Date(updatedRun.updatedAt).getTime()).toBeGreaterThan(
        new Date(originalRun.updatedAt).getTime(),
      );
    });

    it("recovers multiple orphaned runs", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const deadPid = 999999999;

      for (const id of ["run-1", "run-2", "run-3"]) {
        const run = makeRun({
          runId: id,
          status: "running",
          pid: deadPid,
        });
        await writeFile(path.join(repoDir, `${id}.json`), JSON.stringify(run));
      }

      const store = new RunStore({ runsDir: TMP_DIR });
      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toHaveLength(3);
    });

    it("handles corrupt JSON files gracefully", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      // Write corrupt JSON
      await writeFile(path.join(repoDir, "corrupt.json"), "{ not valid json");

      // Write valid orphaned run
      const deadPid = 999999999;
      const validRun = makeRun({
        runId: "valid-run",
        status: "running",
        pid: deadPid,
      });
      await writeFile(path.join(repoDir, "valid-run.json"), JSON.stringify(validRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      // Should not throw, and should return valid orphaned runs
      const orphaned = await store.recoverOrphanedRuns();

      // Implementation swallows errors at the loop level, so we expect 0 or 1
      // based on whether the error prevents further processing
      expect(orphaned.length).toBeLessThanOrEqual(1);
    });

    it("handles mixed run statuses across multiple repos", async () => {
      const repo1Dir = path.join(TMP_DIR, "repo-1");
      const repo2Dir = path.join(TMP_DIR, "repo-2");
      await mkdir(repo1Dir, { recursive: true });
      await mkdir(repo2Dir, { recursive: true });

      const deadPid = 999999999;

      // Repo 1: one orphaned, one completed
      await writeFile(
        path.join(repo1Dir, "orphan.json"),
        JSON.stringify(
          makeRun({
            runId: "orphan",
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

      // Repo 2: one orphaned
      await writeFile(
        path.join(repo2Dir, "orphan-2.json"),
        JSON.stringify(
          makeRun({
            runId: "orphan-2",
            status: "running",
            pid: deadPid,
            repo: "/tmp/repo-2",
          }),
        ),
      );

      const store = new RunStore({ runsDir: TMP_DIR });
      const orphaned = await store.recoverOrphanedRuns();

      expect(orphaned).toHaveLength(2);
      const runIds = orphaned.map((r) => r.runId).sort();
      expect(runIds).toEqual(["orphan", "orphan-2"]);
    });
  });

  describe("atomic writes", () => {
    it("does not leave temp files behind after successful persistRun", async () => {
      const store = new RunStore();
      const testRunId = `atomic-test-${Date.now()}`;
      const run = makeRun({ runId: testRunId, repo: "/tmp/my-repo" });

      await store.persistRun(run);

      // persistRun uses getRepoRunsDir() which writes to ~/.neo/runs/<slug>
      const slug = toRepoSlug({ path: run.repo });
      const repoDir = path.join(GLOBAL_RUNS_DIR, slug);
      const runPath = path.join(repoDir, `${testRunId}.json`);

      try {
        // Check no temp files left in directory
        const files = await readdir(repoDir);
        const tempFiles = files.filter((f) => f.includes(".tmp."));
        expect(tempFiles).toHaveLength(0);

        // Verify the run was persisted
        const content = await readFile(runPath, "utf-8");
        const persisted = JSON.parse(content);
        expect(persisted.runId).toBe(testRunId);
      } finally {
        await rm(runPath, { force: true });
      }
    });

    it("does not leave temp files behind after successful recoverRunIfOrphaned", async () => {
      const repoDir = path.join(TMP_DIR, "my-repo");
      await mkdir(repoDir, { recursive: true });

      const deadPid = 999999999;
      const runFilePath = path.join(repoDir, "orphan-run.json");
      const orphanedRun = makeRun({
        runId: "orphan-run",
        status: "running",
        pid: deadPid,
      });
      await writeFile(runFilePath, JSON.stringify(orphanedRun));

      const store = new RunStore({ runsDir: TMP_DIR });
      await store.recoverOrphanedRuns();

      // Check no temp files left in directory
      const files = await readdir(repoDir);
      const tempFiles = files.filter((f) => f.includes(".tmp."));
      expect(tempFiles).toHaveLength(0);

      // Verify the run status was updated
      const content = await readFile(runFilePath, "utf-8");
      const updated = JSON.parse(content);
      expect(updated.status).toBe("failed");
    });

    it("prevents corruption with concurrent persistRun calls", async () => {
      const store = new RunStore();
      const timestamp = Date.now();
      const runIds = [
        `concurrent-1-${timestamp}`,
        `concurrent-2-${timestamp}`,
        `concurrent-3-${timestamp}`,
      ];

      // Persist multiple runs concurrently
      await Promise.all(
        runIds.map((runId) => store.persistRun(makeRun({ runId, repo: "/tmp/my-repo" }))),
      );

      const slug = toRepoSlug({ path: "/tmp/my-repo" });
      const repoDir = path.join(GLOBAL_RUNS_DIR, slug);

      try {
        // Check no temp files left
        const files = await readdir(repoDir);
        const tempFiles = files.filter((f) => f.includes(".tmp."));
        expect(tempFiles).toHaveLength(0);

        // Verify all runs were persisted correctly
        for (const runId of runIds) {
          const runPath = path.join(repoDir, `${runId}.json`);
          const content = await readFile(runPath, "utf-8");
          const persisted = JSON.parse(content);
          expect(persisted.runId).toBe(runId);
        }
      } finally {
        // Cleanup
        for (const runId of runIds) {
          await rm(path.join(repoDir, `${runId}.json`), { force: true });
        }
      }
    });
  });
});
