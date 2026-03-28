import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildRegistry } from "../child-registry.js";
import { spawnChildSupervisor } from "../child-spawner.js";
import type { ChildToParentMessage } from "../schemas.js";

// Mock fork to avoid actual process spawning
vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const events = new Map<string, Function>();
    const mockProcess = {
      pid: 99999,
      connected: true,
      send: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        events.set(event, handler);
        return mockProcess;
      }),
      emit: (event: string, ...args: unknown[]) => {
        const handler = events.get(event);
        if (handler) handler(...args);
      },
      kill: vi.fn(),
    };
    return mockProcess;
  }),
}));

describe("Child Supervisor Integration", () => {
  const TMP = path.join(import.meta.dirname, "__tmp_child_integration__");
  const childrenPath = path.join(TMP, "children.json");

  beforeEach(() => mkdir(TMP, { recursive: true }));
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("spawns child and registers with ChildRegistry", async () => {
    const messages: ChildToParentMessage[] = [];
    const registry = new ChildRegistry({
      onMessage: (msg) => messages.push(msg),
      childrenFilePath: childrenPath,
    });

    const result = await spawnChildSupervisor({
      objective: "Test integration",
      acceptanceCriteria: ["Passes tests"],
      registry,
      workerPath: "/fake/worker.js",
      parentName: "test-supervisor",
    });

    expect(result.supervisorId).toBeDefined();

    // Check registration
    const children = registry.list();
    expect(children).toHaveLength(1);
    expect(children[0]?.objective).toBe("Test integration");
    expect(children[0]?.status).toBe("running");

    // Check children.json written
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(childrenPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it("handles progress messages from child", async () => {
    const messages: ChildToParentMessage[] = [];
    const registry = new ChildRegistry({
      onMessage: (msg) => messages.push(msg),
      childrenFilePath: childrenPath,
    });

    const result = await spawnChildSupervisor({
      objective: "Progress test",
      acceptanceCriteria: ["Done"],
      registry,
      workerPath: "/fake/worker.js",
      parentName: "test-supervisor",
      maxCostUsd: 10.0,
    });

    // Simulate progress message from child via IPC
    const { fork } = await import("node:child_process");
    const mockProcess = (fork as ReturnType<typeof vi.fn>).mock.results[0]?.value;

    // Get the 'message' handler and call it
    const messageHandler = mockProcess.on.mock.calls.find(
      (call: unknown[]) => call[0] === "message",
    )?.[1] as ((msg: ChildToParentMessage) => void) | undefined;

    if (messageHandler) {
      messageHandler({
        type: "progress",
        supervisorId: result.supervisorId,
        summary: "Making progress",
        costDelta: 0.5,
      });
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "progress",
      supervisorId: result.supervisorId,
    });

    // Check cost updated
    const handle = registry.get(result.supervisorId);
    expect(handle?.costUsd).toBe(0.5);
  });

  it("stops child when budget exceeded", async () => {
    const messages: ChildToParentMessage[] = [];
    const registry = new ChildRegistry({
      onMessage: (msg) => messages.push(msg),
      childrenFilePath: childrenPath,
    });

    const result = await spawnChildSupervisor({
      objective: "Budget test",
      acceptanceCriteria: ["Done"],
      registry,
      workerPath: "/fake/worker.js",
      parentName: "test-supervisor",
      maxCostUsd: 1.0,
    });

    const { fork } = await import("node:child_process");
    const mockProcess = (fork as ReturnType<typeof vi.fn>).mock.results[0]?.value;

    const messageHandler = mockProcess.on.mock.calls.find(
      (call: unknown[]) => call[0] === "message",
    )?.[1] as ((msg: ChildToParentMessage) => void) | undefined;

    if (messageHandler) {
      // Send progress that exceeds budget
      messageHandler({
        type: "progress",
        supervisorId: result.supervisorId,
        summary: "Expensive operation",
        costDelta: 1.5,
      });
    }

    // Should have sent stop message
    expect(mockProcess.send).toHaveBeenCalledWith({ type: "stop" });

    // Handle should be marked failed
    const handle = registry.get(result.supervisorId);
    expect(handle?.status).toBe("failed");
  });

  it("handles complete message from child", async () => {
    const messages: ChildToParentMessage[] = [];
    const registry = new ChildRegistry({
      onMessage: (msg) => messages.push(msg),
      childrenFilePath: childrenPath,
    });

    const result = await spawnChildSupervisor({
      objective: "Complete test",
      acceptanceCriteria: ["Done"],
      registry,
      workerPath: "/fake/worker.js",
      parentName: "test-supervisor",
    });

    const { fork } = await import("node:child_process");
    const mockProcess = (fork as ReturnType<typeof vi.fn>).mock.results[0]?.value;

    const messageHandler = mockProcess.on.mock.calls.find(
      (call: unknown[]) => call[0] === "message",
    )?.[1] as ((msg: ChildToParentMessage) => void) | undefined;

    if (messageHandler) {
      // Send complete message
      messageHandler({
        type: "complete",
        supervisorId: result.supervisorId,
        summary: "Task completed successfully",
        evidence: ["PR #123 merged"],
      });
    }

    // Handle should be marked complete
    const handle = registry.get(result.supervisorId);
    expect(handle?.status).toBe("complete");
  });
});
