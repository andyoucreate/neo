import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesFilter, WebhookDispatcher } from "@/events/webhook";
import type { NeoEvent } from "@/types";

function makeEvent(overrides?: Partial<NeoEvent>): NeoEvent {
  return {
    type: "session:start",
    sessionId: "session-1",
    runId: "run-1",
    workflow: "hotfix",
    step: "fix",
    agent: "developer",
    repo: "/tmp/repo",
    timestamp: "2026-03-14T10:00:00.000Z",
    ...overrides,
  } as NeoEvent;
}

describe("matchesFilter", () => {
  it("matches all events when no filter is provided", () => {
    expect(matchesFilter("session:start", undefined)).toBe(true);
    expect(matchesFilter("session:start", [])).toBe(true);
  });

  it("matches exact event type", () => {
    expect(matchesFilter("session:start", ["session:start"])).toBe(true);
    expect(matchesFilter("session:fail", ["session:start"])).toBe(false);
  });

  it("matches wildcard prefix", () => {
    expect(matchesFilter("session:start", ["session:*"])).toBe(true);
    expect(matchesFilter("session:complete", ["session:*"])).toBe(true);
    expect(matchesFilter("cost:update", ["session:*"])).toBe(false);
  });

  it("matches with multiple filters", () => {
    const filters = ["session:*", "budget:alert"];
    expect(matchesFilter("session:start", filters)).toBe(true);
    expect(matchesFilter("budget:alert", filters)).toBe(true);
    expect(matchesFilter("cost:update", filters)).toBe(false);
  });
});

describe("WebhookDispatcher", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends POST request with correct payload including id", () => {
    const dispatcher = new WebhookDispatcher([
      { url: "https://example.com/hook", timeoutMs: 5000 },
    ]);

    dispatcher.dispatch(makeEvent());

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/hook");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      version: 1,
      source: "neo",
      event: "session:start",
      payload: expect.objectContaining({
        type: "session:start",
        runId: "run-1",
      }),
    });
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
    expect(body.deliveredAt).toBeDefined();
  });

  it("includes HMAC signature when secret is configured", () => {
    const secret = "my-secret-key";
    const dispatcher = new WebhookDispatcher([
      { url: "https://example.com/hook", secret, timeoutMs: 5000 },
    ]);

    dispatcher.dispatch(makeEvent());

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers["X-Neo-Signature"]).toBeDefined();

    // Verify the signature is correct
    const expectedSig = createHmac("sha256", secret)
      .update(opts.body as string)
      .digest("hex");
    expect(headers["X-Neo-Signature"]).toBe(expectedSig);
  });

  it("excludes gate:waiting events", () => {
    const dispatcher = new WebhookDispatcher([
      { url: "https://example.com/hook", timeoutMs: 5000 },
    ]);

    dispatcher.dispatch({
      type: "gate:waiting",
      runId: "run-1",
      gate: "review",
      description: "Review required",
      context: {
        runId: "run-1",
        workflow: "deploy",
        repo: "/tmp",
        prompt: "deploy",
        steps: {},
        startedAt: new Date(),
      },
      approve: () => {},
      reject: () => {},
      timestamp: "2026-03-14T10:00:00.000Z",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters events based on webhook config", () => {
    const dispatcher = new WebhookDispatcher([
      {
        url: "https://example.com/hook",
        events: ["session:complete"],
        timeoutMs: 5000,
      },
    ]);

    dispatcher.dispatch(makeEvent({ type: "session:start" } as Partial<NeoEvent>));
    expect(fetchSpy).not.toHaveBeenCalled();

    dispatcher.dispatch(
      makeEvent({
        type: "session:complete",
        status: "success",
        costUsd: 0.1,
        durationMs: 1000,
      } as Partial<NeoEvent>),
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("dispatches to multiple webhooks independently", () => {
    const dispatcher = new WebhookDispatcher([
      { url: "https://a.com/hook", events: ["session:*"], timeoutMs: 5000 },
      { url: "https://b.com/hook", events: ["cost:*"], timeoutMs: 5000 },
    ]);

    dispatcher.dispatch(makeEvent());

    // Only the first webhook matches session:start
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("https://a.com/hook");
  });

  it("swallows fetch errors silently", () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));
    const dispatcher = new WebhookDispatcher([
      { url: "https://example.com/hook", timeoutMs: 5000 },
    ]);

    // Should not throw
    expect(() => dispatcher.dispatch(makeEvent())).not.toThrow();
  });

  it("retries terminal events on failure", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(new Response("ok"));

    const dispatcher = new WebhookDispatcher([
      { url: "https://example.com/hook", timeoutMs: 5000 },
    ]);

    dispatcher.dispatch(
      makeEvent({
        type: "session:complete",
        status: "success",
        costUsd: 0.1,
        durationMs: 1000,
      } as Partial<NeoEvent>),
    );

    // First attempt fires immediately
    expect(fetchSpy).toHaveBeenCalledOnce();

    // Advance past retry delays (500ms, 1000ms)
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it("retries session:fail events on failure", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(new Response("ok"));

    const dispatcher = new WebhookDispatcher([
      { url: "https://example.com/hook", timeoutMs: 5000 },
    ]);

    dispatcher.dispatch(
      makeEvent({
        type: "session:fail",
        error: "crash",
        attempt: 1,
        maxRetries: 3,
        willRetry: false,
      } as Partial<NeoEvent>),
    );

    expect(fetchSpy).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("does not retry non-terminal events", () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));
    const dispatcher = new WebhookDispatcher([
      { url: "https://example.com/hook", timeoutMs: 5000 },
    ]);

    dispatcher.dispatch(makeEvent({ type: "session:start" } as Partial<NeoEvent>));

    // Only one attempt — no retry for non-terminal events
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("generates unique ids per dispatch", () => {
    const dispatcher = new WebhookDispatcher([
      { url: "https://example.com/hook", timeoutMs: 5000 },
    ]);

    dispatcher.dispatch(makeEvent());
    dispatcher.dispatch(makeEvent());

    const body1 = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { id: string };
    const body2 = JSON.parse(
      (fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as { id: string };
    expect(body1.id).not.toBe(body2.id);
  });

  it("strips non-serializable fields from event payload", () => {
    const dispatcher = new WebhookDispatcher([
      { url: "https://example.com/hook", timeoutMs: 5000 },
    ]);

    // Create an event-like object with a function field
    const event = {
      ...makeEvent(),
      someCallback: () => {},
    } as unknown as NeoEvent;

    dispatcher.dispatch(event);

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { payload: Record<string, unknown> };
    expect(body.payload.someCallback).toBeUndefined();
    expect(body.payload.type).toBe("session:start");
  });
});
