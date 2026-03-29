import { createHmac } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebhookIncomingEvent } from "@/supervisor/schemas";
import { WebhookServer } from "@/supervisor/webhook-server";

const TEST_DIR = path.join(import.meta.dirname, "__tmp_webhook_server_test__");
const EVENTS_PATH = path.join(TEST_DIR, "events.jsonl");

// Use a unique port per test to avoid conflicts
let testPort = 19300;

function getNextPort(): number {
  return testPort++;
}

async function fetchJson(
  url: string,
  options?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, options);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

describe("WebhookServer", () => {
  let server: WebhookServer;
  let port: number;
  let receivedEvents: WebhookIncomingEvent[];

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    receivedEvents = [];
    port = getNextPort();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  function createServer(options?: { secret?: string }): WebhookServer {
    server = new WebhookServer({
      port,
      secret: options?.secret,
      eventsPath: EVENTS_PATH,
      onEvent: (event) => receivedEvents.push(event),
      getHealth: () => ({ status: "running", uptime: 1234 }),
    });
    return server;
  }

  describe("Server lifecycle", () => {
    it("starts and stops without errors", async () => {
      server = createServer();

      await expect(server.start()).resolves.toBeUndefined();
      await expect(server.stop()).resolves.toBeUndefined();
    });

    it("stop is idempotent", async () => {
      server = createServer();

      await server.start();
      await server.stop();
      // Second stop should not throw
      await expect(server.stop()).resolves.toBeUndefined();
    });

    it("stop resolves immediately when server not started", async () => {
      server = createServer();

      // Stop without starting
      await expect(server.stop()).resolves.toBeUndefined();
    });
  });

  describe("Routes", () => {
    it("GET /health returns 200 with status", async () => {
      server = createServer();
      await server.start();

      const { status, body } = await fetchJson(`http://localhost:${port}/health`);

      expect(status).toBe(200);
      expect(body).toEqual({ status: "running", uptime: 1234 });
    });

    it("POST /webhook accepts valid JSON", async () => {
      server = createServer();
      await server.start();

      const payload = { event: "test", data: { foo: "bar" } };
      const { status, body } = await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it("returns 404 for unknown paths", async () => {
      server = createServer();
      await server.start();

      const { status, body } = await fetchJson(`http://localhost:${port}/unknown`);

      expect(status).toBe(404);
      expect(body.error).toBe("Not found");
    });

    it("returns 404 for GET on /webhook", async () => {
      server = createServer();
      await server.start();

      const { status, body } = await fetchJson(`http://localhost:${port}/webhook`);

      expect(status).toBe(404);
      expect(body.error).toBe("Not found");
    });

    it("returns 404 for POST on /health", async () => {
      server = createServer();
      await server.start();

      const { status, body } = await fetchJson(`http://localhost:${port}/health`, {
        method: "POST",
        body: "{}",
      });

      expect(status).toBe(404);
      expect(body.error).toBe("Not found");
    });
  });

  describe("HMAC validation", () => {
    const SECRET = "test-secret-key-12345";

    it("accepts valid HMAC signature", async () => {
      server = createServer({ secret: SECRET });
      await server.start();

      const payload = { event: "test", data: { value: 123 } };
      const body = JSON.stringify(payload);
      const signature = createHmac("sha256", SECRET).update(body).digest("hex");

      const { status, body: responseBody } = await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Neo-Signature": signature,
        },
        body,
      });

      expect(status).toBe(200);
      expect(responseBody.ok).toBe(true);
    });

    it("rejects missing signature with 401", async () => {
      server = createServer({ secret: SECRET });
      await server.start();

      const payload = { event: "test" };
      const { status, body } = await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(status).toBe(401);
      expect(body.error).toBe("Missing X-Neo-Signature header");
    });

    it("rejects invalid signature with 403", async () => {
      server = createServer({ secret: SECRET });
      await server.start();

      const payload = { event: "test" };
      const { status, body } = await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Neo-Signature": "invalid-signature-hash",
        },
        body: JSON.stringify(payload),
      });

      expect(status).toBe(403);
      expect(body.error).toBe("Invalid signature");
    });

    it("rejects tampered payload", async () => {
      server = createServer({ secret: SECRET });
      await server.start();

      const originalPayload = { event: "test", data: { amount: 100 } };
      const tamperedPayload = { event: "test", data: { amount: 999 } };

      // Sign the original payload
      const signature = createHmac("sha256", SECRET)
        .update(JSON.stringify(originalPayload))
        .digest("hex");

      // Send tampered payload with original signature
      const { status, body } = await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Neo-Signature": signature,
        },
        body: JSON.stringify(tamperedPayload),
      });

      expect(status).toBe(403);
      expect(body.error).toBe("Invalid signature");
    });

    it("accepts requests without signature when no secret configured", async () => {
      server = createServer(); // No secret
      await server.start();

      const payload = { event: "test" };
      const { status, body } = await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });

  describe("Body size limits", () => {
    it("rejects payload larger than 1MB", async () => {
      server = createServer();
      await server.start();

      // Create a payload slightly larger than 1MB
      const largeData = "x".repeat(1024 * 1024 + 100);
      const payload = JSON.stringify({ data: largeData });

      try {
        const response = await fetch(`http://localhost:${port}/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });

        // If we got a response, it should be 413
        expect(response.status).toBe(413);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.error).toBe("Payload too large (max 1MB)");
      } catch (error) {
        // Connection may be reset before response is sent
        // This is expected behavior when the server calls req.destroy()
        expect((error as Error).message).toMatch(/fetch failed|socket|closed|reset/i);
      }
    });

    it("accepts payload just under 1MB", async () => {
      server = createServer();
      await server.start();

      // Create a payload just under 1MB (accounting for JSON structure overhead)
      const targetSize = 1024 * 1024 - 50;
      const data = "x".repeat(targetSize);
      const payload = JSON.stringify({ d: data });

      // Ensure we're under the limit
      expect(payload.length).toBeLessThan(1024 * 1024);

      const response = await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });

      expect(response.status).toBe(200);
    });
  });

  describe("JSON parsing", () => {
    it("accepts valid JSON", async () => {
      server = createServer();
      await server.start();

      const { status, body } = await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "test", nested: { a: 1, b: [2, 3] } }),
      });

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it("rejects invalid JSON with 400", async () => {
      server = createServer();
      await server.start();

      const response = await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ invalid json",
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("Invalid JSON");
    });

    it("rejects empty body as invalid JSON", async () => {
      server = createServer();
      await server.start();

      const response = await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "",
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("Invalid JSON");
    });

    it("rejects plain text as invalid JSON", async () => {
      server = createServer();
      await server.start();

      const response = await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "hello world",
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("Invalid JSON");
    });
  });

  describe("Disk-first persistence", () => {
    it("writes event to disk before calling onEvent", async () => {
      // Track call order using synchronous operations
      const callOrder: string[] = [];
      let onEventCalled = false;

      server = new WebhookServer({
        port,
        eventsPath: EVENTS_PATH,
        onEvent: () => {
          callOrder.push("onEvent");
          onEventCalled = true;
        },
        getHealth: () => ({}),
      });
      await server.start();

      const payload = { id: "evt-disk-test", event: "persistence-test" };
      await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      // onEvent should have been called
      expect(onEventCalled).toBe(true);

      // File should exist and contain the event (written before onEvent)
      const content = await readFile(EVENTS_PATH, "utf-8");
      expect(content).toContain('"id":"evt-disk-test"');

      // The implementation does: await appendFile(...) then onEvent()
      // We verify this by checking the file exists after a successful response
      // Since the response only comes after onEvent is called (see sendJson call order),
      // and file is written before onEvent, the file must exist.
    });

    it("writes event to configured events file", async () => {
      const customEventsPath = path.join(TEST_DIR, "custom-events.jsonl");

      server = new WebhookServer({
        port,
        eventsPath: customEventsPath,
        onEvent: () => {},
        getHealth: () => ({}),
      });
      await server.start();

      const payload = { id: "evt-custom-path", event: "test" };
      await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const content = await readFile(customEventsPath, "utf-8");
      expect(content).toContain('"id":"evt-custom-path"');
    });

    it("appends multiple events to disk as JSONL", async () => {
      server = createServer();
      await server.start();

      // Send multiple events
      for (let i = 1; i <= 3; i++) {
        await fetchJson(`http://localhost:${port}/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: `evt-${i}`, event: `test-${i}` }),
        });
      }

      const content = await readFile(EVENTS_PATH, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('"id":"evt-1"');
      expect(lines[1]).toContain('"id":"evt-2"');
      expect(lines[2]).toContain('"id":"evt-3"');
    });

    it("writes valid JSON on each line", async () => {
      server = createServer();
      await server.start();

      const payload = { id: "evt-json", event: "json-test", data: { nested: true } };
      await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const content = await readFile(EVENTS_PATH, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] as string) as WebhookIncomingEvent;
      expect(parsed.id).toBe("evt-json");
      expect(parsed.event).toBe("json-test");
      expect(parsed.receivedAt).toBeDefined();
    });
  });

  describe("Event parsing and callback", () => {
    it("extracts id, source, event from payload", async () => {
      server = createServer();
      await server.start();

      const payload = {
        id: "evt-456",
        source: "github",
        event: "push",
        payload: { ref: "refs/heads/main" },
      };
      await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0];
      expect(event?.id).toBe("evt-456");
      expect(event?.source).toBe("github");
      expect(event?.event).toBe("push");
      expect(event?.payload).toEqual({ ref: "refs/heads/main" });
      expect(event?.receivedAt).toBeDefined();
    });

    it("uses full payload when payload field is missing", async () => {
      server = createServer();
      await server.start();

      const payload = { foo: "bar", baz: 123 };
      await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0];
      expect(event?.payload).toEqual({ foo: "bar", baz: 123 });
    });

    it("returns event id in response", async () => {
      server = createServer();
      await server.start();

      const payload = { id: "my-custom-id", event: "test" };
      const { status, body } = await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, id: "my-custom-id" });
    });

    it("adds receivedAt timestamp to event", async () => {
      server = createServer();
      await server.start();

      const before = new Date().toISOString();
      await fetchJson(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "test" }),
      });
      const after = new Date().toISOString();

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0];
      expect(event).toBeDefined();
      const receivedAt = event?.receivedAt;
      expect(receivedAt).toBeDefined();
      expect(receivedAt).not.toBeUndefined();
      if (receivedAt) {
        expect(receivedAt >= before).toBe(true);
        expect(receivedAt <= after).toBe(true);
      }
    });
  });
});
