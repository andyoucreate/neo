import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMemoryOps,
  auditMemoryOps,
  checkMemorySize,
  extractMemoryOps,
  parseStructuredMemory,
} from "@/supervisor/memory";
import type { MemoryOp } from "@/supervisor/schemas";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_memory_test__");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("parseStructuredMemory", () => {
  it("returns empty memory for empty string", () => {
    const result = parseStructuredMemory("");
    expect(result.agenda).toBe("");
    expect(result.activeWork).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.trackerSync).toEqual({});
  });

  it("parses new format correctly", () => {
    const input = JSON.stringify({
      agenda: "Focus on API stability",
      activeWork: [
        { description: "Implement auth", status: "running", since: "2026-03-15T00:00:00Z" },
      ],
      blockers: [],
      decisions: [{ date: "2026-03-14", decision: "Use JWT" }],
      trackerSync: { "TASK-1": "in_progress" },
    });
    const result = parseStructuredMemory(input);
    expect(result.agenda).toBe("Focus on API stability");
    expect(result.activeWork).toHaveLength(1);
    expect(result.activeWork[0]?.description).toBe("Implement auth");
    expect(result.decisions).toHaveLength(1);
  });

  it("migrates old format (string arrays) to new format", () => {
    const oldFormat = JSON.stringify({
      activeWork: ["task A", "task B"],
      blockers: ["blocked on review"],
      repoNotes: { "/repo": "uses prisma" },
      recentDecisions: [{ date: "2026-03-14", decision: "Use JWT" }],
      trackerSync: {},
      notes: "",
    });
    const result = parseStructuredMemory(oldFormat);
    expect(result.activeWork).toHaveLength(2);
    expect(result.activeWork[0]?.description).toBe("task A");
    expect(result.activeWork[0]?.status).toBe("running");
    expect(result.activeWork[0]?.since).toBeTruthy();
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.description).toBe("blocked on review");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.decision).toBe("Use JWT");
  });

  it("handles recentDecisions field as fallback for decisions", () => {
    const input = JSON.stringify({
      recentDecisions: [{ date: "2026-03-14", decision: "Test" }],
    });
    const result = parseStructuredMemory(input);
    expect(result.decisions).toHaveLength(1);
  });

  it("returns empty memory for malformed JSON", () => {
    const result = parseStructuredMemory("not json at all");
    expect(result.agenda).toBe("");
    expect(result.activeWork).toEqual([]);
  });
});

describe("extractMemoryOps", () => {
  it("extracts valid ops from response", () => {
    const response = `Some text
<memory-ops>
{"op":"set","path":"agenda","value":"New focus"}
{"op":"append","path":"activeWork","value":{"description":"New task","status":"running","since":"2026-03-15T00:00:00Z"}}
{"op":"remove","path":"blockers","index":0}
</memory-ops>
More text`;
    const ops = extractMemoryOps(response);
    expect(ops).toHaveLength(3);
    expect(ops[0]?.op).toBe("set");
    expect(ops[1]?.op).toBe("append");
    expect(ops[2]?.op).toBe("remove");
  });

  it("returns empty array when no memory-ops block", () => {
    expect(extractMemoryOps("no ops here")).toEqual([]);
  });

  it("skips malformed lines", () => {
    const response = `<memory-ops>
{"op":"set","path":"agenda","value":"ok"}
not valid json
{"op":"append","path":"activeWork","value":"test"}
</memory-ops>`;
    const ops = extractMemoryOps(response);
    expect(ops).toHaveLength(2);
  });

  it("returns empty for empty memory-ops block", () => {
    expect(extractMemoryOps("<memory-ops></memory-ops>")).toEqual([]);
    expect(extractMemoryOps("<memory-ops>\n\n</memory-ops>")).toEqual([]);
  });
});

describe("applyMemoryOps", () => {
  function makeMemory() {
    return parseStructuredMemory(
      JSON.stringify({
        agenda: "Initial focus",
        activeWork: [{ description: "Task A", status: "running", since: "2026-03-15T00:00:00Z" }],
        blockers: [{ description: "Blocked on X", since: "2026-03-15T00:00:00Z" }],
        decisions: [],
        trackerSync: { "T-1": "done" },
      }),
    );
  }

  it("applies set operation", () => {
    const mem = makeMemory();
    const result = applyMemoryOps(mem, [{ op: "set", path: "agenda", value: "New agenda" }]);
    expect(result.agenda).toBe("New agenda");
    // Original untouched (immutable)
    expect(mem.agenda).toBe("Initial focus");
  });

  it("applies append operation", () => {
    const mem = makeMemory();
    const newItem = { description: "Task B", status: "running", since: "2026-03-15T01:00:00Z" };
    const result = applyMemoryOps(mem, [{ op: "append", path: "activeWork", value: newItem }]);
    expect(result.activeWork).toHaveLength(2);
    expect(result.activeWork[1]?.description).toBe("Task B");
  });

  it("applies remove operation", () => {
    const mem = makeMemory();
    const result = applyMemoryOps(mem, [{ op: "remove", path: "blockers", index: 0 }]);
    expect(result.blockers).toHaveLength(0);
  });

  it("supports nested paths with set", () => {
    const mem = makeMemory();
    const result = applyMemoryOps(mem, [
      { op: "set", path: "trackerSync.T-2", value: "in_progress" },
    ]);
    expect(result.trackerSync["T-2"]).toBe("in_progress");
    expect(result.trackerSync["T-1"]).toBe("done");
  });

  it("creates array when appending to non-existent path", () => {
    const mem = makeMemory();
    const result = applyMemoryOps(mem, [
      { op: "append", path: "decisions", value: { date: "2026-03-15", decision: "Decided X" } },
    ]);
    expect(result.decisions).toHaveLength(1);
  });

  it("ignores remove with out-of-bounds index", () => {
    const mem = makeMemory();
    const result = applyMemoryOps(mem, [{ op: "remove", path: "activeWork", index: 99 }]);
    expect(result.activeWork).toHaveLength(1);
  });

  it("applies multiple ops in order", () => {
    const mem = makeMemory();
    const ops: MemoryOp[] = [
      { op: "set", path: "agenda", value: "Updated" },
      {
        op: "append",
        path: "activeWork",
        value: { description: "Task B", status: "waiting", since: "2026-03-15T01:00:00Z" },
      },
      { op: "remove", path: "blockers", index: 0 },
    ];
    const result = applyMemoryOps(mem, ops);
    expect(result.agenda).toBe("Updated");
    expect(result.activeWork).toHaveLength(2);
    expect(result.blockers).toHaveLength(0);
  });
});

describe("auditMemoryOps", () => {
  it("appends ops to memory-archive.jsonl", async () => {
    const ops: MemoryOp[] = [{ op: "set", path: "agenda", value: "test" }];
    await auditMemoryOps(TMP_DIR, 5, ops);
    const content = await readFile(path.join(TMP_DIR, "memory-archive.jsonl"), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.type).toBe("memory_ops");
    expect(entry.heartbeat).toBe(5);
    expect(entry.ops).toHaveLength(1);
  });

  it("does nothing for empty ops array", async () => {
    await auditMemoryOps(TMP_DIR, 5, []);
    await expect(readFile(path.join(TMP_DIR, "memory-archive.jsonl"), "utf-8")).rejects.toThrow();
  });
});

describe("checkMemorySize", () => {
  it("reports ok for small content", () => {
    const result = checkMemorySize("hello");
    expect(result.ok).toBe(true);
    expect(result.sizeKB).toBeLessThan(1);
  });

  it("reports not ok for large content", () => {
    const result = checkMemorySize("x".repeat(7 * 1024));
    expect(result.ok).toBe(false);
  });
});
