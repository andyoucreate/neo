import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createServer, dispatchedTickets, activeSessions } from "../server.js";
import type express from "express";

describe("HTTP Server — Extended", () => {
  let app: express.Express;
  const savedAuthToken = process.env.DISPATCH_AUTH_TOKEN;

  beforeEach(() => {
    // Ensure no auth token is set for most tests
    delete process.env.DISPATCH_AUTH_TOKEN;
    app = createServer();
    dispatchedTickets.clear();
    activeSessions.clear();
  });

  afterEach(() => {
    // Restore original auth token state
    if (savedAuthToken !== undefined) {
      process.env.DISPATCH_AUTH_TOKEN = savedAuthToken;
    } else {
      delete process.env.DISPATCH_AUTH_TOKEN;
    }
  });

  describe("GET /health", () => {
    it("should return healthy status", async () => {
      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "healthy");
      expect(res.body).toHaveProperty("uptime");
      expect(res.body).toHaveProperty("version");
    });

    it("should return degraded when paused", async () => {
      await request(app).post("/pause");
      const res = await request(app).get("/health");

      expect(res.body.status).toBe("degraded");

      // Resume for cleanup
      await request(app).post("/resume");
    });
  });

  describe("Request ID middleware", () => {
    it("should add X-Request-Id header to all responses", async () => {
      const res = await request(app).get("/health");

      expect(res.headers["x-request-id"]).toBeDefined();
      expect(res.headers["x-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("should generate unique IDs per request", async () => {
      const res1 = await request(app).get("/health");
      const res2 = await request(app).get("/health");

      expect(res1.headers["x-request-id"]).not.toBe(
        res2.headers["x-request-id"],
      );
    });
  });

  describe("Auth token middleware", () => {
    it("should reject dispatch requests when auth token is set but not provided", async () => {
      process.env.DISPATCH_AUTH_TOKEN = "test-secret-token";

      const res = await request(app)
        .post("/dispatch/review")
        .send({ ticketId: "REV-1", prNumber: 1, repository: "github.com/org/repo" });

      expect(res.status).toBe(401);

      delete process.env.DISPATCH_AUTH_TOKEN;
    });

    it("should allow requests with correct auth token", async () => {
      process.env.DISPATCH_AUTH_TOKEN = "test-secret-token";

      const res = await request(app)
        .post("/dispatch/review")
        .set("Authorization", "Bearer test-secret-token")
        .send({ ticketId: "REV-1", prNumber: 1, repository: "github.com/org/repo" });

      // Should get past auth — may succeed (200) or queue-related response
      expect(res.status).not.toBe(401);

      delete process.env.DISPATCH_AUTH_TOKEN;
    });

    it("should allow requests when no auth token is configured", async () => {
      delete process.env.DISPATCH_AUTH_TOKEN;

      const res = await request(app)
        .post("/dispatch/review")
        .send({ ticketId: "REV-1", prNumber: 1, repository: "github.com/org/repo" });

      expect(res.status).not.toBe(401);
    });
  });

  describe("Dispatch endpoints — additional validation", () => {
    it("should reject hotfix with duplicate ticket", async () => {
      dispatchedTickets.add("hotfix:HOTFIX-1");

      const res = await request(app).post("/dispatch/hotfix").send({
        ticketId: "HOTFIX-1",
        title: "Fix crash",
        priority: "critical",
        repository: "github.com/org/repo",
      });

      expect(res.status).toBe(409);
    });

    it("should reject fixer with empty issues array", async () => {
      const res = await request(app).post("/dispatch/fixer").send({
        ticketId: "FIX-1",
        prNumber: 42,
        repository: "github.com/org/repo",
        issues: [],
      });

      expect(res.status).toBe(400);
    });

    it("should reject feature with invalid type", async () => {
      const res = await request(app).post("/dispatch/feature").send({
        ticketId: "PROJ-99",
        title: "Add user dashboard",
        type: "invalid",
        priority: "medium",
        repository: "github.com/org/repo",
      });

      expect(res.status).toBe(400);
    });
  });
});
