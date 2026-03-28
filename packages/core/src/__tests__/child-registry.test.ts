import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildRegistry } from "@/supervisor/child-registry";
import type { ChildHandle } from "@/supervisor/schemas";

function makeHandle(overrides: Partial<ChildHandle> = {}): ChildHandle {
  return {
    supervisorId: "sup_1",
    objective: "feat/auth",
    depth: 1,
    startedAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
    costUsd: 0,
    status: "running",
    ...overrides,
  };
}

describe("ChildRegistry", () => {
  let registry: ChildRegistry;
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onMessage = vi.fn();
    registry = new ChildRegistry({ onMessage, stallTimeoutMs: 500 });
  });

  afterEach(() => {
    registry.stopAll();
  });

  it("starts with no children", () => {
    expect(registry.list()).toHaveLength(0);
  });

  it("registers and retrieves a child handle", () => {
    registry.register(makeHandle());
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("sup_1")?.objective).toBe("feat/auth");
  });

  it("updates status to complete on complete message", () => {
    registry.register(makeHandle());
    registry.handleMessage({
      type: "complete",
      supervisorId: "sup_1",
      summary: "Done",
      evidence: ["PR #42"],
    });
    expect(registry.get("sup_1")?.status).toBe("complete");
  });

  it("updates status to blocked on blocked message", () => {
    registry.register(makeHandle());
    registry.handleMessage({
      type: "blocked",
      supervisorId: "sup_1",
      reason: "Cannot decide",
      question: "Which approach?",
      urgency: "high",
    });
    expect(registry.get("sup_1")?.status).toBe("blocked");
  });

  it("accumulates cost from progress messages", () => {
    registry.register(makeHandle());
    registry.handleMessage({
      type: "progress",
      supervisorId: "sup_1",
      summary: "Working",
      costDelta: 0.05,
    });
    registry.handleMessage({
      type: "progress",
      supervisorId: "sup_1",
      summary: "Working",
      costDelta: 0.03,
    });
    expect(registry.get("sup_1")?.costUsd).toBeCloseTo(0.08);
  });

  it("stores session id from session message", () => {
    registry.register(makeHandle());
    registry.handleMessage({ type: "session", supervisorId: "sup_1", sessionId: "ses_abc" });
    expect(registry.get("sup_1")?.sessionId).toBe("ses_abc");
  });

  it("forwards messages to onMessage callback", () => {
    registry.register(makeHandle());
    registry.handleMessage({
      type: "progress",
      supervisorId: "sup_1",
      summary: "Working",
      costDelta: 0.01,
    });
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "progress", supervisorId: "sup_1" }),
    );
  });

  it("enforces budget cap and calls stopCallback", () => {
    const stopCallback = vi.fn();
    registry.register(makeHandle({ maxCostUsd: 0.1 }), stopCallback);
    registry.handleMessage({
      type: "progress",
      supervisorId: "sup_1",
      summary: "Working",
      costDelta: 0.12,
    });
    expect(stopCallback).toHaveBeenCalledOnce();
    expect(registry.get("sup_1")?.status).toBe("failed");
  });

  it("does not call stopCallback when under budget", () => {
    const stopCallback = vi.fn();
    registry.register(makeHandle({ maxCostUsd: 0.1 }), stopCallback);
    registry.handleMessage({
      type: "progress",
      supervisorId: "sup_1",
      summary: "Working",
      costDelta: 0.05,
    });
    expect(stopCallback).not.toHaveBeenCalled();
    expect(registry.get("sup_1")?.status).toBe("running");
  });

  it("removes a child from the registry", () => {
    registry.register(makeHandle());
    registry.remove("sup_1");
    expect(registry.list()).toHaveLength(0);
    expect(registry.get("sup_1")).toBeUndefined();
  });

  it("ignores messages for unknown supervisor", () => {
    registry.handleMessage({
      type: "progress",
      supervisorId: "unknown",
      summary: "?",
      costDelta: 0,
    });
    expect(onMessage).not.toHaveBeenCalled();
  });
});
