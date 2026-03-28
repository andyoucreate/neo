import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIAdapter, SupervisorMessage } from "@/supervisor/ai-adapter";
import { FocusedLoop } from "@/supervisor/focused-loop";
import type { SupervisorStore } from "@/supervisor/store";
import { JsonlSupervisorStore } from "@/supervisor/stores/jsonl";

function makeAdapter(messages: SupervisorMessage[]): AIAdapter {
  return {
    async *query() {
      yield* messages;
    },
    getSessionHandle: () => ({ provider: "claude" as const, sessionId: "ses_test" }),
    restoreSession: vi.fn(),
  };
}

let dir: string;
let store: SupervisorStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "neo-focused-"));
  store = new JsonlSupervisorStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FocusedLoop", () => {
  it("calls onComplete when supervisor_complete tool is used", async () => {
    const onComplete = vi.fn();
    const adapter = makeAdapter([
      {
        kind: "tool_use",
        toolName: "supervisor_complete",
        toolInput: {
          summary: "All done",
          evidence: ["PR #42"],
          criteriaResults: [{ criterion: "PR open", met: true, evidence: "PR #42" }],
        },
      },
      { kind: "end" },
    ]);

    const loop = new FocusedLoop({
      supervisorId: "sup_1",
      objective: "feat/auth",
      acceptanceCriteria: ["PR open"],
      adapter,
      store,
      onComplete,
      onBlocked: vi.fn(),
      onProgress: vi.fn(),
      tickIntervalMs: 0,
    });

    const shouldContinue = await loop.runOnce();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ summary: "All done" }));
    expect(shouldContinue).toBe(false);
  });

  it("calls onBlocked when supervisor_blocked tool is used", async () => {
    const onBlocked = vi.fn();
    const adapter = makeAdapter([
      {
        kind: "tool_use",
        toolName: "supervisor_blocked",
        toolInput: {
          reason: "Cannot decide migration strategy",
          question: "addColumn or createTable?",
          context: "2M rows in users table",
          urgency: "high",
        },
      },
      { kind: "end" },
    ]);

    const loop = new FocusedLoop({
      supervisorId: "sup_1",
      objective: "feat/auth",
      acceptanceCriteria: ["PR open"],
      adapter,
      store,
      onComplete: vi.fn(),
      onBlocked,
      onProgress: vi.fn(),
      tickIntervalMs: 0,
    });

    const shouldContinue = await loop.runOnce();
    expect(onBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Cannot decide migration strategy" }),
    );
    expect(shouldContinue).toBe(false);
  });

  it("persists session id after first turn", async () => {
    const adapter = makeAdapter([{ kind: "end" }]);

    const loop = new FocusedLoop({
      supervisorId: "sup_1",
      objective: "feat/auth",
      acceptanceCriteria: [],
      adapter,
      store,
      onComplete: vi.fn(),
      onBlocked: vi.fn(),
      onProgress: vi.fn(),
      tickIntervalMs: 0,
    });

    await loop.runOnce();
    const sessionId = await store.getSessionId("sup_1");
    expect(sessionId).toBe("ses_test");
  });

  it("returns true from runOnce when no terminal tool called", async () => {
    const adapter = makeAdapter([
      { kind: "text", text: "Thinking about the objective..." },
      { kind: "end" },
    ]);

    const loop = new FocusedLoop({
      supervisorId: "sup_1",
      objective: "feat/auth",
      acceptanceCriteria: [],
      adapter,
      store,
      onComplete: vi.fn(),
      onBlocked: vi.fn(),
      onProgress: vi.fn(),
      tickIntervalMs: 0,
    });

    const shouldContinue = await loop.runOnce();
    expect(shouldContinue).toBe(true);
  });

  it("stop() causes loop to exit after current turn", async () => {
    const adapter = makeAdapter([{ kind: "end" }]);

    const loop = new FocusedLoop({
      supervisorId: "sup_1",
      objective: "feat/auth",
      acceptanceCriteria: [],
      adapter,
      store,
      onComplete: vi.fn(),
      onBlocked: vi.fn(),
      onProgress: vi.fn(),
      tickIntervalMs: 0,
    });

    loop.stop();
    const shouldContinue = await loop.runOnce();
    expect(shouldContinue).toBe(false);
  });

  it("injectContext adds context to next prompt turn", async () => {
    let capturedPrompt = "";
    const adapter: AIAdapter = {
      async *query(options) {
        capturedPrompt = options.prompt;
        yield { kind: "end" };
      },
      getSessionHandle: () => ({ provider: "claude" as const, sessionId: "ses_1" }),
      restoreSession: vi.fn(),
    };

    const loop = new FocusedLoop({
      supervisorId: "sup_1",
      objective: "feat/auth",
      acceptanceCriteria: [],
      adapter,
      store,
      onComplete: vi.fn(),
      onBlocked: vi.fn(),
      onProgress: vi.fn(),
      tickIntervalMs: 0,
    });

    loop.injectContext("Mission B modified auth.ts");
    await loop.runOnce();
    expect(capturedPrompt).toContain("Mission B modified auth.ts");
  });
});
