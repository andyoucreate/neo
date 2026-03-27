import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "@/supervisor/task-store";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_task_store_test__");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function createStore(): TaskStore {
  return new TaskStore(path.join(TMP_DIR, "memory.sqlite"));
}

describe("TaskStore", () => {
  describe("createTask", () => {
    it("creates a task and returns its id", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Implement auth middleware",
        scope: "/repos/myapp",
        status: "pending",
        priority: "high",
      });
      expect(id).toMatch(/^mem_/);
      store.close();
    });

    it("creates task with all optional fields", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Task with metadata",
        scope: "/repos/myapp",
        status: "pending",
        priority: "critical",
        initiative: "auth-v2",
        dependsOn: "mem_abc123",
        context: "neo runs abc123",
        runId: "run_xyz",
      });
      const task = store.getTask(id);
      expect(task?.priority).toBe("critical");
      expect(task?.initiative).toBe("auth-v2");
      expect(task?.dependsOn).toBe("mem_abc123");
      expect(task?.context).toBe("neo runs abc123");
      expect(task?.runId).toBe("run_xyz");
      store.close();
    });
  });

  describe("getTask", () => {
    it("retrieves a task by id", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Test task",
        scope: "global",
        status: "pending",
      });
      const task = store.getTask(id);
      expect(task).toBeDefined();
      expect(task?.title).toBe("Test task");
      expect(task?.status).toBe("pending");
      store.close();
    });

    it("returns undefined for non-existent task", () => {
      const store = createStore();
      const task = store.getTask("mem_nonexistent");
      expect(task).toBeUndefined();
      store.close();
    });
  });

  describe("updateStatus", () => {
    it("updates task status", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Task to update",
        scope: "global",
        status: "pending",
      });
      store.updateStatus(id, "in_progress");
      const task = store.getTask(id);
      expect(task?.status).toBe("in_progress");
      store.close();
    });

    it("updates runId when provided", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Task with run",
        scope: "global",
        status: "pending",
      });
      store.updateStatus(id, "in_progress", "run_123");
      const task = store.getTask(id);
      expect(task?.runId).toBe("run_123");
      store.close();
    });
  });

  describe("getTasks", () => {
    it("filters by initiative", () => {
      const store = createStore();
      store.createTask({
        title: "Auth task",
        scope: "global",
        status: "pending",
        initiative: "auth-v2",
      });
      store.createTask({
        title: "Billing task",
        scope: "global",
        status: "pending",
        initiative: "billing",
      });
      const tasks = store.getTasks({ initiative: "auth-v2" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toBe("Auth task");
      store.close();
    });

    it("filters by status", () => {
      const store = createStore();
      store.createTask({
        title: "Pending task",
        scope: "global",
        status: "pending",
      });
      store.createTask({
        title: "Done task",
        scope: "global",
        status: "done",
      });
      const tasks = store.getTasks({ status: ["pending"] });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toBe("Pending task");
      store.close();
    });

    it("filters by scope", () => {
      const store = createStore();
      store.createTask({
        title: "Repo A task",
        scope: "/repos/a",
        status: "pending",
      });
      store.createTask({
        title: "Repo B task",
        scope: "/repos/b",
        status: "pending",
      });
      const tasks = store.getTasks({ scope: "/repos/a" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toBe("Repo A task");
      store.close();
    });
  });

  describe("deleteTask", () => {
    it("removes a task", () => {
      const store = createStore();
      const id = store.createTask({
        title: "Task to delete",
        scope: "global",
        status: "pending",
      });
      store.deleteTask(id);
      const task = store.getTask(id);
      expect(task).toBeUndefined();
      store.close();
    });
  });
});
