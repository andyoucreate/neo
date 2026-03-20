import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog } from "@/middleware/audit-log";
import { budgetGuard } from "@/middleware/budget-guard";
import { buildMiddlewareChain, buildSDKHooks } from "@/middleware/chain";
import { loopDetection } from "@/middleware/loop-detection";
import type { Middleware, MiddlewareContext, MiddlewareEvent } from "@/types";

// ─── Helpers ───────────────────────────────────────────

const TMP_DIR = path.join(import.meta.dirname, "__tmp_middleware_test__");

function makeContext(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  const store = new Map<string, unknown>();
  return {
    runId: "run-1",
    step: "step-1",
    agent: "test-agent",
    repo: "/tmp/repo",
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    ...overrides,
  };
}

function makeEvent(overrides?: Partial<MiddlewareEvent>): MiddlewareEvent {
  return {
    hookEvent: "PreToolUse",
    sessionId: "session-1",
    toolName: "Bash",
    input: { command: "ls" },
    ...overrides,
  };
}

// ─── MiddlewareChain ───────────────────────────────────

describe("buildMiddlewareChain", () => {
  it("executes middleware in registration order", async () => {
    const order: string[] = [];

    const mw1: Middleware = {
      name: "first",
      on: "PreToolUse",
      async handler() {
        order.push("first");
        return { decision: "pass" };
      },
    };
    const mw2: Middleware = {
      name: "second",
      on: "PreToolUse",
      async handler() {
        order.push("second");
        return { decision: "pass" };
      },
    };

    const chain = buildMiddlewareChain([mw1, mw2]);
    await chain.execute(makeEvent(), makeContext());

    expect(order).toEqual(["first", "second"]);
  });

  it("stops the chain on block result", async () => {
    const order: string[] = [];

    const blocker: Middleware = {
      name: "blocker",
      on: "PreToolUse",
      async handler() {
        order.push("blocker");
        return { decision: "block", reason: "blocked" };
      },
    };
    const after: Middleware = {
      name: "after",
      on: "PreToolUse",
      async handler() {
        order.push("after");
        return { decision: "pass" };
      },
    };

    const chain = buildMiddlewareChain([blocker, after]);
    const result = await chain.execute(makeEvent(), makeContext());

    expect(order).toEqual(["blocker"]);
    expect(result).toEqual({ decision: "block", reason: "blocked" });
  });

  it("continues the chain on async result", async () => {
    const order: string[] = [];

    const asyncMw: Middleware = {
      name: "async-mw",
      on: "PreToolUse",
      async handler() {
        order.push("async");
        return { decision: "async", asyncTimeout: 5_000 };
      },
    };
    const after: Middleware = {
      name: "after",
      on: "PreToolUse",
      async handler() {
        order.push("after");
        return { decision: "pass" };
      },
    };

    const chain = buildMiddlewareChain([asyncMw, after]);
    await chain.execute(makeEvent(), makeContext());

    expect(order).toEqual(["async", "after"]);
  });

  it("only runs middleware matching the tool name", async () => {
    const order: string[] = [];

    const bashOnly: Middleware = {
      name: "bash-only",
      on: "PreToolUse",
      match: "Bash",
      async handler() {
        order.push("bash-only");
        return { decision: "pass" };
      },
    };
    const writeOnly: Middleware = {
      name: "write-only",
      on: "PreToolUse",
      match: "Write",
      async handler() {
        order.push("write-only");
        return { decision: "pass" };
      },
    };
    const catchAll: Middleware = {
      name: "catch-all",
      on: "PreToolUse",
      async handler() {
        order.push("catch-all");
        return { decision: "pass" };
      },
    };

    const chain = buildMiddlewareChain([bashOnly, writeOnly, catchAll]);
    await chain.execute(makeEvent({ toolName: "Bash" }), makeContext());

    expect(order).toEqual(["bash-only", "catch-all"]);
  });

  it("supports array match for multiple tool names", async () => {
    const order: string[] = [];

    const editWrite: Middleware = {
      name: "edit-write",
      on: "PreToolUse",
      match: ["Edit", "Write"],
      async handler() {
        order.push("edit-write");
        return { decision: "pass" };
      },
    };

    const chain = buildMiddlewareChain([editWrite]);

    await chain.execute(makeEvent({ toolName: "Edit" }), makeContext());
    expect(order).toEqual(["edit-write"]);

    order.length = 0;
    await chain.execute(makeEvent({ toolName: "Bash" }), makeContext());
    expect(order).toEqual([]);
  });

  it("only runs middleware matching the hook event", async () => {
    const order: string[] = [];

    const preOnly: Middleware = {
      name: "pre-only",
      on: "PreToolUse",
      async handler() {
        order.push("pre-only");
        return { decision: "pass" };
      },
    };
    const postOnly: Middleware = {
      name: "post-only",
      on: "PostToolUse",
      async handler() {
        order.push("post-only");
        return { decision: "pass" };
      },
    };

    const chain = buildMiddlewareChain([preOnly, postOnly]);
    await chain.execute(makeEvent({ hookEvent: "PostToolUse" }), makeContext());

    expect(order).toEqual(["post-only"]);
  });

  it("returns empty object when no middleware blocks", async () => {
    const chain = buildMiddlewareChain([]);
    const result = await chain.execute(makeEvent(), makeContext());

    expect(result).toEqual({ decision: "pass" });
  });

  it("handles middleware handler that throws an exception", async () => {
    const thrower: Middleware = {
      name: "thrower",
      on: "PreToolUse",
      async handler() {
        throw new Error("middleware exploded");
      },
    };

    const chain = buildMiddlewareChain([thrower]);
    await expect(chain.execute(makeEvent(), makeContext())).rejects.toThrow("middleware exploded");
  });

  it("handles async middleware followed by blocking middleware", async () => {
    const asyncMw: Middleware = {
      name: "async-mw",
      on: "PreToolUse",
      async handler() {
        return { decision: "async", asyncTimeout: 5_000 };
      },
    };
    const blocker: Middleware = {
      name: "blocker",
      on: "PreToolUse",
      async handler() {
        return { decision: "block", reason: "blocked after async" };
      },
    };

    const chain = buildMiddlewareChain([asyncMw, blocker]);
    const result = await chain.execute(makeEvent(), makeContext());

    expect(result).toEqual({ decision: "block", reason: "blocked after async" });
  });

  it("passes correct event data to handler", async () => {
    const spy = vi.fn().mockResolvedValue({ decision: "pass" });

    const mw: Middleware = {
      name: "spy-mw",
      on: "PreToolUse",
      handler: spy,
    };

    const chain = buildMiddlewareChain([mw]);
    const event = makeEvent({
      hookEvent: "PreToolUse",
      sessionId: "sess-42",
      toolName: "Bash",
      input: { command: "echo hello" },
    });
    const ctx = makeContext({ runId: "run-99" });

    await chain.execute(event, ctx);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        hookEvent: "PreToolUse",
        sessionId: "sess-42",
        toolName: "Bash",
        input: { command: "echo hello" },
      }),
      expect.objectContaining({ runId: "run-99" }),
    );
  });
});

// ─── Loop Detection ──────────────────────────────────── ────────────────────────────────────

describe("loopDetection", () => {
  it("blocks after threshold identical commands", async () => {
    const mw = loopDetection({ threshold: 3 });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();
    const event = makeEvent({ input: { command: "npm test" } });

    // First two should pass
    expect(await chain.execute(event, ctx)).toEqual({ decision: "pass" });
    expect(await chain.execute(event, ctx)).toEqual({ decision: "pass" });

    // Third should block
    const result = await chain.execute(event, ctx);
    expect(result).toHaveProperty("decision", "block");
    expect(result).toHaveProperty("reason");
  });

  it("tracks different commands independently", async () => {
    const mw = loopDetection({ threshold: 2 });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();

    const event1 = makeEvent({ input: { command: "ls" } });
    const event2 = makeEvent({ input: { command: "pwd" } });

    expect(await chain.execute(event1, ctx)).toEqual({ decision: "pass" });
    expect(await chain.execute(event2, ctx)).toEqual({ decision: "pass" });
    expect(await chain.execute(event1, ctx)).toEqual({
      decision: "block",
      reason: expect.stringContaining("Loop detected"),
    });
    // pwd still at count 1, should pass
    expect(await chain.execute(event2, ctx)).toEqual({
      decision: "block",
      reason: expect.stringContaining("Loop detected"),
    });
  });

  it("tracks per session", async () => {
    const mw = loopDetection({ threshold: 2 });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();

    const eventS1 = makeEvent({
      sessionId: "s1",
      input: { command: "ls" },
    });
    const eventS2 = makeEvent({
      sessionId: "s2",
      input: { command: "ls" },
    });

    expect(await chain.execute(eventS1, ctx)).toEqual({ decision: "pass" });
    expect(await chain.execute(eventS2, ctx)).toEqual({ decision: "pass" });
    // s1 at count 2 → block, s2 still at count 1
    expect(await chain.execute(eventS1, ctx)).toEqual({
      decision: "block",
      reason: expect.stringContaining("Loop detected"),
    });
    expect(await chain.execute(eventS2, ctx)).toEqual({
      decision: "block",
      reason: expect.stringContaining("Loop detected"),
    });
  });

  it("only matches Bash tool", async () => {
    const mw = loopDetection({ threshold: 1 });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();

    const writeEvent = makeEvent({
      toolName: "Write",
      input: { command: "ls" },
    });

    // Should not trigger for Write tool
    expect(await chain.execute(writeEvent, ctx)).toEqual({ decision: "pass" });
    expect(await chain.execute(writeEvent, ctx)).toEqual({ decision: "pass" });
  });

  it("blocks at threshold=1 (second execution)", async () => {
    const mw = loopDetection({ threshold: 1 });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();
    const event = makeEvent({ input: { command: "ls" } });

    // threshold=1: first execution (count becomes 1) should block
    const result = await chain.execute(event, ctx);
    expect(result).toHaveProperty("decision", "block");
  });

  it("does not count different tool names", async () => {
    const mw = loopDetection({ threshold: 2 });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();

    const bashEvent = makeEvent({
      toolName: "Bash",
      input: { command: "ls" },
    });
    const writeEvent = makeEvent({
      toolName: "Write",
      input: { command: "ls" },
    });

    // Bash "ls" executes once (count=1, under threshold=2)
    expect(await chain.execute(bashEvent, ctx)).toEqual({ decision: "pass" });

    // Write "ls" should not increment Bash counter (match: "Bash" skips Write)
    expect(await chain.execute(writeEvent, ctx)).toEqual({ decision: "pass" });

    // Bash "ls" again — count=2, should block
    const result = await chain.execute(bashEvent, ctx);
    expect(result).toHaveProperty("decision", "block");
  });

  it("cleanup() removes session history to prevent memory leaks", async () => {
    const mw = loopDetection({ threshold: 3 });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();
    const event = makeEvent({ sessionId: "session-to-cleanup", input: { command: "npm test" } });

    // Run command twice (under threshold)
    expect(await chain.execute(event, ctx)).toEqual({ decision: "pass" });
    expect(await chain.execute(event, ctx)).toEqual({ decision: "pass" });

    // Cleanup the session
    mw.cleanup("session-to-cleanup");

    // After cleanup, count resets — first execution passes again
    expect(await chain.execute(event, ctx)).toEqual({ decision: "pass" });
    expect(await chain.execute(event, ctx)).toEqual({ decision: "pass" });

    // Third execution now blocks (count is 3 after cleanup + 2 new)
    const result = await chain.execute(event, ctx);
    expect(result).toHaveProperty("decision", "block");
  });
});

// ─── Audit Log ─────────────────────────────────────────

describe("auditLog", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:30:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("writes JSONL file with correct content after flush", async () => {
    const mw = auditLog({ dir: TMP_DIR, includeInput: true });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext({ agent: "test-agent" });
    const event = makeEvent({
      hookEvent: "PostToolUse",
      sessionId: "session-42",
      toolName: "Bash",
      input: { command: "ls -la" },
    });

    const result = await chain.execute(event, ctx);
    expect(result).toEqual({ decision: "async", asyncTimeout: 5_000 });

    await mw.flush();

    const filePath = path.join(TMP_DIR, "session-42.jsonl");
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(entry.timestamp).toBe("2026-01-15T10:30:00.000Z");
    expect(entry.sessionId).toBe("session-42");
    expect(entry.agent).toBe("test-agent");
    expect(entry.toolName).toBe("Bash");
    expect(entry.input).toEqual({ command: "ls -la" });
    expect(entry.output).toBeUndefined();
  });

  it("includes output when configured", async () => {
    const mw = auditLog({
      dir: TMP_DIR,
      includeInput: false,
      includeOutput: true,
    });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();
    const event = makeEvent({
      hookEvent: "PostToolUse",
      sessionId: "session-43",
      toolName: "Read",
      input: { file: "/tmp/test.txt" },
      output: "file contents here",
    });

    await chain.execute(event, ctx);
    await mw.flush();

    const filePath = path.join(TMP_DIR, "session-43.jsonl");
    const content = await readFile(filePath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.input).toBeUndefined();
    expect(entry.output).toBe("file contents here");
  });

  it("appends multiple entries to same session file", async () => {
    const mw = auditLog({ dir: TMP_DIR });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();

    for (let i = 0; i < 3; i++) {
      await chain.execute(
        makeEvent({
          hookEvent: "PostToolUse",
          sessionId: "session-multi",
          toolName: `Tool${String(i)}`,
        }),
        ctx,
      );
    }

    await mw.flush();

    const filePath = path.join(TMP_DIR, "session-multi.jsonl");
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("auto-flushes when buffer reaches flushSize", async () => {
    const mw = auditLog({ dir: TMP_DIR, flushSize: 2, flushIntervalMs: 0 });
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();

    // First entry — buffered, not yet written
    await chain.execute(makeEvent({ hookEvent: "PostToolUse", sessionId: "session-buf" }), ctx);

    // Second entry — triggers flush (flushSize=2)
    await chain.execute(makeEvent({ hookEvent: "PostToolUse", sessionId: "session-buf" }), ctx);

    const filePath = path.join(TMP_DIR, "session-buf.jsonl");
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});

// ─── Budget Guard ──────────────────────────────────────

describe("budgetGuard", () => {
  it("blocks when over budget", async () => {
    const mw = budgetGuard();
    const chain = buildMiddlewareChain([mw]);

    const store = new Map<string, unknown>([
      ["costToday", 150],
      ["budgetCapUsd", 100],
    ]);
    const ctx = makeContext({
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    });

    const result = await chain.execute(makeEvent(), ctx);
    expect(result).toEqual({
      decision: "block",
      reason: "Daily budget exceeded",
    });
  });

  it("allows when under budget", async () => {
    const mw = budgetGuard();
    const chain = buildMiddlewareChain([mw]);

    const store = new Map<string, unknown>([
      ["costToday", 50],
      ["budgetCapUsd", 100],
    ]);
    const ctx = makeContext({
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    });

    const result = await chain.execute(makeEvent(), ctx);
    expect(result).toEqual({ decision: "pass" });
  });

  it("allows when budget values are not set", async () => {
    const mw = budgetGuard();
    const chain = buildMiddlewareChain([mw]);
    const ctx = makeContext();

    const result = await chain.execute(makeEvent(), ctx);
    expect(result).toEqual({ decision: "pass" });
  });

  it("blocks when cost equals budget cap exactly", async () => {
    const mw = budgetGuard();
    const chain = buildMiddlewareChain([mw]);

    const store = new Map<string, unknown>([
      ["costToday", 100],
      ["budgetCapUsd", 100],
    ]);
    const ctx = makeContext({
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    });

    const result = await chain.execute(makeEvent(), ctx);
    expect(result).toEqual({
      decision: "block",
      reason: "Daily budget exceeded",
    });
  });

  it("blocks when budgetCapUsd is 0 and costToday is 0", async () => {
    const mw = budgetGuard();
    const chain = buildMiddlewareChain([mw]);

    const store = new Map<string, unknown>([
      ["costToday", 0],
      ["budgetCapUsd", 0],
    ]);
    const ctx = makeContext({
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    });

    // 0 >= 0 is true, so it should block
    const result = await chain.execute(makeEvent(), ctx);
    expect(result).toEqual({
      decision: "block",
      reason: "Daily budget exceeded",
    });
  });

  it("handles negative costToday gracefully", async () => {
    const mw = budgetGuard();
    const chain = buildMiddlewareChain([mw]);

    const store = new Map<string, unknown>([
      ["costToday", -10],
      ["budgetCapUsd", 100],
    ]);
    const ctx = makeContext({
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    });

    const result = await chain.execute(makeEvent(), ctx);
    expect(result).toEqual({ decision: "pass" });
  });
});

// ─── buildSDKHooks ─────────────────────────────────────

describe("buildSDKHooks", () => {
  function getCallback(
    hooks: ReturnType<typeof buildSDKHooks>,
    event: "PreToolUse" | "PostToolUse" | "Notification",
  ) {
    const matchers = hooks[event];
    expect(matchers).toBeDefined();
    expect(matchers).toHaveLength(1);
    const matcher = matchers?.[0];
    expect(matcher).toBeDefined();
    const callback = matcher?.hooks[0];
    expect(callback).toBeDefined();
    // Safe after assertions above
    return callback as Exclude<typeof callback, undefined>;
  }

  it("returns correct hook format with all three events", () => {
    const chain = buildMiddlewareChain([]);
    const ctx = makeContext();
    const hooks = buildSDKHooks(chain, ctx);

    expect(hooks.PreToolUse).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
    expect(hooks.Notification).toBeDefined();

    const cb = getCallback(hooks, "PreToolUse");
    expect(typeof cb).toBe("function");
  });

  it("delegates to chain and returns SDK-compatible block result", async () => {
    const blocker: Middleware = {
      name: "blocker",
      on: "PreToolUse",
      async handler() {
        return { decision: "block", reason: "test block" };
      },
    };

    const chain = buildMiddlewareChain([blocker]);
    const ctx = makeContext();
    const hooks = buildSDKHooks(chain, ctx);
    const callback = getCallback(hooks, "PreToolUse");

    const result = await callback(
      {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "tu1",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
      },
      "tu1",
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({ decision: "block", reason: "test block" });
  });

  it("returns async SDK result for async middleware", async () => {
    const asyncMw: Middleware = {
      name: "async-mw",
      on: "PostToolUse",
      async handler() {
        return { decision: "async", asyncTimeout: 3_000 };
      },
    };

    const chain = buildMiddlewareChain([asyncMw]);
    const ctx = makeContext();
    const hooks = buildSDKHooks(chain, ctx);
    const callback = getCallback(hooks, "PostToolUse");

    const result = await callback(
      {
        session_id: "s1",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: "output",
        tool_use_id: "tu1",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
      },
      "tu1",
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({ async: true, asyncTimeout: 3_000 }); // SDK format
  });

  it("returns empty object for pass-through", async () => {
    const chain = buildMiddlewareChain([]);
    const ctx = makeContext();
    const hooks = buildSDKHooks(chain, ctx);
    const callback = getCallback(hooks, "PreToolUse");

    const result = await callback(
      {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "tu1",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
      },
      "tu1",
      { signal: new AbortController().signal },
    );

    // SDK format: pass-through is an empty object (not our internal MiddlewareResult)
    expect(result).toEqual({});
  });

  it("only registers hooks for events with middleware listeners", () => {
    const preOnly: Middleware = {
      name: "pre-only",
      on: "PreToolUse",
      async handler() {
        return { decision: "pass" };
      },
    };

    const chain = buildMiddlewareChain([preOnly]);
    const ctx = makeContext();
    const hooks = buildSDKHooks(chain, ctx, [preOnly]);

    expect(hooks.PreToolUse).toBeDefined();
    expect(hooks.PostToolUse).toBeUndefined();
    expect(hooks.Notification).toBeUndefined();
  });

  it("handles Notification hook event correctly", async () => {
    const spy = vi.fn().mockResolvedValue({ decision: "pass" });

    const notifMw: Middleware = {
      name: "notif-mw",
      on: "Notification",
      handler: spy,
    };

    const chain = buildMiddlewareChain([notifMw]);
    const ctx = makeContext();
    const hooks = buildSDKHooks(chain, ctx, [notifMw]);

    expect(hooks.Notification).toBeDefined();
    expect(hooks.Notification).toHaveLength(1);

    const callback = hooks.Notification?.[0]?.hooks[0];
    expect(callback).toBeDefined();

    const result = await callback?.(
      {
        session_id: "s1",
        hook_event_name: "Notification",
        message: "Agent completed task",
        notification_type: "info",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
      },
      "n1",
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({});
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        hookEvent: "Notification",
        sessionId: "s1",
        message: "Agent completed task",
      }),
      expect.anything(),
    );
  });
});
