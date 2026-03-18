import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionStore } from "@/supervisor/decisions";
import type { WebhookIncomingEvent } from "@/supervisor/schemas";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_decision_webhook_test__");
const DECISIONS_FILE = path.join(TMP_DIR, "decisions.jsonl");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Simulates the decision:answer webhook handler from daemon.ts.
 * This tests the core logic without spinning up the full daemon.
 */
async function handleDecisionAnswer(
  event: WebhookIncomingEvent,
  store: DecisionStore,
): Promise<{ success: boolean; error?: string }> {
  if (event.event !== "decision:answer") {
    return { success: false, error: "Not a decision:answer event" };
  }

  if (!event.payload) {
    return { success: false, error: "Missing payload" };
  }

  const decisionId =
    typeof event.payload.decisionId === "string" ? event.payload.decisionId : undefined;
  const answer = typeof event.payload.answer === "string" ? event.payload.answer : undefined;

  if (!decisionId || !answer) {
    return {
      success: false,
      error: `Missing required fields (decisionId: ${decisionId}, answer: ${answer})`,
    };
  }

  try {
    await store.answer(decisionId, answer);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function makeWebhookEvent(overrides?: Partial<WebhookIncomingEvent>): WebhookIncomingEvent {
  return {
    receivedAt: new Date().toISOString(),
    event: "decision:answer",
    payload: {
      decisionId: "dec_test123",
      answer: "yes",
    },
    ...overrides,
  };
}

describe("decision:answer webhook handler", () => {
  describe("valid payloads", () => {
    it("answers a pending decision via webhook", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const decisionId = await store.create({
        question: "Deploy to production?",
        type: "approval",
        source: "agent-1",
      });

      const event = makeWebhookEvent({
        payload: { decisionId, answer: "approved" },
      });

      const result = await handleDecisionAnswer(event, store);

      expect(result.success).toBe(true);
      const decision = await store.get(decisionId);
      expect(decision?.answer).toBe("approved");
      expect(decision?.answeredAt).toBeDefined();
    });

    it("handles multiple decisions answered via webhook", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const id1 = await store.create({
        question: "Q1",
        type: "approval",
        source: "agent-1",
      });
      const id2 = await store.create({
        question: "Q2",
        type: "approval",
        source: "agent-1",
      });

      await handleDecisionAnswer(
        makeWebhookEvent({ payload: { decisionId: id1, answer: "yes" } }),
        store,
      );
      await handleDecisionAnswer(
        makeWebhookEvent({ payload: { decisionId: id2, answer: "no" } }),
        store,
      );

      const d1 = await store.get(id1);
      const d2 = await store.get(id2);
      expect(d1?.answer).toBe("yes");
      expect(d2?.answer).toBe("no");
    });
  });

  describe("invalid payloads", () => {
    it("fails when event type is not decision:answer", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const event = makeWebhookEvent({ event: "other:event" });

      const result = await handleDecisionAnswer(event, store);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Not a decision:answer event");
    });

    it("fails when payload is missing", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const event = makeWebhookEvent({ payload: undefined });

      const result = await handleDecisionAnswer(event, store);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing payload");
    });

    it("fails when decisionId is missing", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const event = makeWebhookEvent({
        payload: { answer: "yes" },
      });

      const result = await handleDecisionAnswer(event, store);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing required fields");
    });

    it("fails when answer is missing", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const event = makeWebhookEvent({
        payload: { decisionId: "dec_123" },
      });

      const result = await handleDecisionAnswer(event, store);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing required fields");
    });

    it("fails when decisionId is not a string", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const event = makeWebhookEvent({
        payload: { decisionId: 123, answer: "yes" },
      });

      const result = await handleDecisionAnswer(event, store);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing required fields");
    });
  });

  describe("error handling", () => {
    it("fails when decision does not exist", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const event = makeWebhookEvent({
        payload: { decisionId: "dec_nonexistent", answer: "yes" },
      });

      const result = await handleDecisionAnswer(event, store);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Decision not found");
    });

    it("fails when decision is already answered", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const decisionId = await store.create({
        question: "Q1",
        type: "approval",
        source: "agent-1",
      });
      await store.answer(decisionId, "first-answer");

      const event = makeWebhookEvent({
        payload: { decisionId, answer: "second-answer" },
      });

      const result = await handleDecisionAnswer(event, store);

      expect(result.success).toBe(false);
      expect(result.error).toContain("already answered");
    });
  });

  describe("event payload variations", () => {
    it("handles webhook with additional metadata in payload", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const decisionId = await store.create({
        question: "Q1",
        type: "approval",
        source: "agent-1",
      });

      const event = makeWebhookEvent({
        id: "webhook-123",
        source: "external-system",
        payload: {
          decisionId,
          answer: "approved",
          extra: "metadata",
          timestamp: new Date().toISOString(),
        },
      });

      const result = await handleDecisionAnswer(event, store);

      expect(result.success).toBe(true);
      const decision = await store.get(decisionId);
      expect(decision?.answer).toBe("approved");
    });

    it("handles answer with special characters", async () => {
      const store = new DecisionStore(DECISIONS_FILE);
      const decisionId = await store.create({
        question: "Q1",
        type: "approval",
        source: "agent-1",
      });

      const specialAnswer = 'Answer with "quotes" and\nnewlines';
      const event = makeWebhookEvent({
        payload: { decisionId, answer: specialAnswer },
      });

      const result = await handleDecisionAnswer(event, store);

      expect(result.success).toBe(true);
      const decision = await store.get(decisionId);
      expect(decision?.answer).toBe(specialAnswer);
    });
  });
});

describe("decision webhook integration scenarios", () => {
  it("full workflow: create decision, answer via webhook, verify no longer pending", async () => {
    const store = new DecisionStore(DECISIONS_FILE);

    // 1. Agent creates a decision
    const decisionId = await store.create({
      question: "Should we deploy the new feature?",
      type: "approval",
      source: "deploy-agent",
      options: [
        { key: "yes", label: "Yes, deploy now" },
        { key: "no", label: "No, wait" },
      ],
    });

    // 2. Verify decision is pending
    let pending = await store.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(decisionId);

    // 3. External system answers via webhook
    const webhookEvent = makeWebhookEvent({
      source: "slack-bot",
      payload: { decisionId, answer: "yes" },
    });
    const result = await handleDecisionAnswer(webhookEvent, store);
    expect(result.success).toBe(true);

    // 4. Verify decision is no longer pending
    pending = await store.pending();
    expect(pending).toHaveLength(0);

    // 5. Verify decision has the answer
    const decision = await store.get(decisionId);
    expect(decision?.answer).toBe("yes");
    expect(decision?.answeredAt).toBeDefined();
  });

  it("concurrent webhook answers are handled safely", async () => {
    const store = new DecisionStore(DECISIONS_FILE);
    const decisionId = await store.create({
      question: "Q1",
      type: "approval",
      source: "agent-1",
    });

    // Simulate two concurrent webhook requests
    const event1 = makeWebhookEvent({
      payload: { decisionId, answer: "answer-1" },
    });
    const event2 = makeWebhookEvent({
      payload: { decisionId, answer: "answer-2" },
    });

    const [result1, result2] = await Promise.all([
      handleDecisionAnswer(event1, store),
      handleDecisionAnswer(event2, store),
    ]);

    // At least one should succeed
    const successes = [result1.success, result2.success].filter(Boolean);
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Decision should have exactly one answer (the one that won the race)
    const decision = await store.get(decisionId);
    expect(decision?.answer).toBeDefined();
    expect(["answer-1", "answer-2"]).toContain(decision?.answer);

    // No pending decisions should remain
    const pending = await store.pending();
    expect(pending).toHaveLength(0);
  });
});
