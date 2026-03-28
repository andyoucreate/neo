import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildRegistry } from "./child-registry.js";
import { type SpawnChildOptions, spawnChildSupervisor } from "./child-spawner.js";

// Mock child_process.fork to avoid actually spawning processes in tests
vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const events = new Map<string, Function>();
    const mockProcess = {
      pid: 12345,
      connected: true,
      send: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        events.set(event, handler);
        return mockProcess;
      }),
      kill: vi.fn(),
    };
    return mockProcess;
  }),
}));

describe("spawnChildSupervisor", () => {
  const TMP = path.join(import.meta.dirname, "__tmp_spawner__");
  let mockRegistry: ChildRegistry;

  beforeEach(async () => {
    await mkdir(TMP, { recursive: true });
    mockRegistry = {
      register: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      send: vi.fn(),
      handleMessage: vi.fn(),
      remove: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as ChildRegistry;
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns a supervisorId", async () => {
    const options: SpawnChildOptions = {
      objective: "Test objective",
      acceptanceCriteria: ["Criterion 1"],
      registry: mockRegistry,
      workerPath: "/fake/worker.js",
      parentName: "supervisor",
    };

    const result = await spawnChildSupervisor(options);
    expect(result.supervisorId).toBeDefined();
    expect(typeof result.supervisorId).toBe("string");
  });

  it("registers the child with the registry", async () => {
    const options: SpawnChildOptions = {
      objective: "Test objective",
      acceptanceCriteria: ["Criterion 1"],
      registry: mockRegistry,
      workerPath: "/fake/worker.js",
      parentName: "supervisor",
      maxCostUsd: 10.0,
    };

    await spawnChildSupervisor(options);

    expect(mockRegistry.register).toHaveBeenCalledTimes(1);
    const registerCall = (mockRegistry.register as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const handle = registerCall[0] as {
      objective: string;
      maxCostUsd: number;
      depth: number;
      status: string;
    };
    expect(handle.objective).toBe("Test objective");
    expect(handle.maxCostUsd).toBe(10.0);
    expect(handle.depth).toBe(0);
    expect(handle.status).toBe("running");
  });

  it("respects depth parameter", async () => {
    const options: SpawnChildOptions = {
      objective: "Nested task",
      acceptanceCriteria: ["Done"],
      registry: mockRegistry,
      workerPath: "/fake/worker.js",
      parentName: "supervisor",
      depth: 1,
    };

    await spawnChildSupervisor(options);

    const registerCall = (mockRegistry.register as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const handle = registerCall[0] as { depth: number };
    expect(handle.depth).toBe(1);
  });

  it("rejects depth > 1", async () => {
    const options: SpawnChildOptions = {
      objective: "Too deep",
      acceptanceCriteria: ["Done"],
      registry: mockRegistry,
      workerPath: "/fake/worker.js",
      parentName: "supervisor",
      depth: 2,
    };

    await expect(spawnChildSupervisor(options)).rejects.toThrow("Maximum depth exceeded");
  });
});
