import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_log_test__");

// Mock getSupervisorDir to use our temp directory
vi.mock("@neotx/core", () => ({
  getSupervisorDir: () => TMP_DIR,
}));

// Mock output functions
vi.mock("../output.js", () => ({
  printError: vi.fn(),
  printSuccess: vi.fn(),
}));

async function readJsonl(filename: string): Promise<unknown[]> {
  try {
    const content = await readFile(path.join(TMP_DIR, filename), "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function runLogCommand(args: Record<string, unknown>): Promise<void> {
  // Re-import to pick up mocks
  const mod = await import("../commands/log.js");
  const command = mod.default;
  await command.run!({ args: args as never } as never);
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(TMP_DIR, { recursive: true });
  // Clear env vars
  delete process.env.NEO_AGENT_NAME;
  delete process.env.NEO_RUN_ID;
  delete process.env.NEO_REPOSITORY;
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.NEO_AGENT_NAME;
  delete process.env.NEO_RUN_ID;
  delete process.env.NEO_REPOSITORY;
});

describe("neo log", () => {
  describe("type validation", () => {
    it("accepts all 6 valid types", async () => {
      const types = ["progress", "action", "decision", "blocker", "milestone", "discovery"];
      for (const type of types) {
        await runLogCommand({ type, message: `test ${type}`, name: "supervisor" });
      }

      const activity = await readJsonl("activity.jsonl");
      expect(activity).toHaveLength(6);

      const buffer = await readJsonl("log-buffer.jsonl");
      expect(buffer).toHaveLength(6);
    });

    it("rejects invalid types", async () => {
      process.exitCode = 0;
      await runLogCommand({ type: "invalid", message: "test", name: "supervisor" });
      expect(process.exitCode).toBe(1);
    });
  });

  describe("triple write", () => {
    it("writes to both activity.jsonl and log-buffer.jsonl", async () => {
      await runLogCommand({ type: "progress", message: "hello", name: "supervisor" });

      const activity = await readJsonl("activity.jsonl");
      expect(activity).toHaveLength(1);
      expect((activity[0] as Record<string, unknown>).summary).toBe("hello");

      const buffer = await readJsonl("log-buffer.jsonl");
      expect(buffer).toHaveLength(1);
      expect((buffer[0] as Record<string, unknown>).message).toBe("hello");
    });

    it("writes blocker to inbox.jsonl as well", async () => {
      await runLogCommand({ type: "blocker", message: "tests failing", name: "supervisor" });

      const inbox = await readJsonl("inbox.jsonl");
      expect(inbox).toHaveLength(1);
      const msg = inbox[0] as Record<string, unknown>;
      expect(msg.from).toBe("agent");
      expect(msg.text).toContain("[BLOCKER]");
      expect(msg.text).toContain("tests failing");
    });

    it("does not write non-blocker types to inbox.jsonl", async () => {
      await runLogCommand({ type: "progress", message: "going well", name: "supervisor" });

      const inbox = await readJsonl("inbox.jsonl");
      expect(inbox).toHaveLength(0);
    });
  });

  describe("implicit routing", () => {
    it("routes progress to digest", async () => {
      await runLogCommand({ type: "progress", message: "test", name: "supervisor" });
      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).target).toBe("digest");
    });

    it("routes action to digest", async () => {
      await runLogCommand({ type: "action", message: "test", name: "supervisor" });
      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).target).toBe("digest");
    });

    it("routes decision to memory", async () => {
      await runLogCommand({ type: "decision", message: "test", name: "supervisor" });
      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).target).toBe("memory");
    });

    it("routes milestone to memory", async () => {
      await runLogCommand({ type: "milestone", message: "test", name: "supervisor" });
      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).target).toBe("memory");
    });

    it("routes blocker to memory", async () => {
      await runLogCommand({ type: "blocker", message: "test", name: "supervisor" });
      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).target).toBe("memory");
    });

    it("routes discovery to knowledge", async () => {
      await runLogCommand({ type: "discovery", message: "test", name: "supervisor" });
      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).target).toBe("knowledge");
    });
  });

  describe("flag overrides", () => {
    it("--memory overrides target to memory", async () => {
      await runLogCommand({ type: "progress", message: "test", name: "supervisor", memory: true });
      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).target).toBe("memory");
    });

    it("--knowledge overrides target to knowledge", async () => {
      await runLogCommand({ type: "progress", message: "test", name: "supervisor", knowledge: true });
      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).target).toBe("knowledge");
    });
  });

  describe("env var defaults", () => {
    it("reads agent name from NEO_AGENT_NAME", async () => {
      process.env.NEO_AGENT_NAME = "developer";
      await runLogCommand({ type: "progress", message: "test", name: "supervisor" });

      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).agent).toBe("developer");
    });

    it("reads runId from NEO_RUN_ID", async () => {
      process.env.NEO_RUN_ID = "run-123";
      await runLogCommand({ type: "progress", message: "test", name: "supervisor" });

      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).runId).toBe("run-123");
    });

    it("reads repo from NEO_REPOSITORY", async () => {
      process.env.NEO_REPOSITORY = "/tmp/repo";
      await runLogCommand({ type: "progress", message: "test", name: "supervisor" });

      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).repo).toBe("/tmp/repo");
    });

    it("--repo flag takes precedence over env var", async () => {
      process.env.NEO_REPOSITORY = "/env/repo";
      await runLogCommand({ type: "progress", message: "test", name: "supervisor", repo: "/flag/repo" });

      const buffer = await readJsonl("log-buffer.jsonl");
      expect((buffer[0] as Record<string, unknown>).repo).toBe("/flag/repo");
    });

    it("includes agent name in blocker inbox message", async () => {
      process.env.NEO_AGENT_NAME = "developer";
      await runLogCommand({ type: "blocker", message: "stuck", name: "supervisor" });

      const inbox = await readJsonl("inbox.jsonl");
      expect((inbox[0] as Record<string, unknown>).text).toContain("(developer)");
    });
  });

  describe("activity.jsonl type mapping", () => {
    it("maps blocker to error type", async () => {
      await runLogCommand({ type: "blocker", message: "test", name: "supervisor" });
      const activity = await readJsonl("activity.jsonl");
      expect((activity[0] as Record<string, unknown>).type).toBe("error");
    });

    it("maps milestone to event type", async () => {
      await runLogCommand({ type: "milestone", message: "test", name: "supervisor" });
      const activity = await readJsonl("activity.jsonl");
      expect((activity[0] as Record<string, unknown>).type).toBe("event");
    });

    it("maps discovery to event type", async () => {
      await runLogCommand({ type: "discovery", message: "test", name: "supervisor" });
      const activity = await readJsonl("activity.jsonl");
      expect((activity[0] as Record<string, unknown>).type).toBe("event");
    });
  });
});
