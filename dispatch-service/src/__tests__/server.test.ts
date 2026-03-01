import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createServer, dispatchedTickets, activeSessions } from "../server.js";
import type express from "express";

// Note: These tests verify HTTP routing and validation only.
// Pipeline execution is mocked since it requires the Claude Agent SDK.

describe("HTTP Server", () => {
  let app: express.Express;

  beforeEach(() => {
    app = createServer();
    dispatchedTickets.clear();
    activeSessions.clear();
  });

  describe("POST /dispatch/feature", () => {
    const validPayload = {
      ticketId: "PROJ-42",
      title: "Add dark mode",
      type: "feature",
      priority: "medium",
      size: "m",
      repository: "github.com/org/my-app",
      criteria: "User can toggle dark mode",
      description: "Implement dark mode",
    };

    it("should reject invalid payload", async () => {
      const res = await request(app)
        .post("/dispatch/feature")
        .send({ title: "Missing fields" });

      expect(res.status).toBe(400);
    });

    it("should reject invalid ticket type", async () => {
      const res = await request(app)
        .post("/dispatch/feature")
        .send({ ...validPayload, type: "invalid" });

      expect(res.status).toBe(400);
    });

    it("should reject duplicate ticket dispatch", async () => {
      dispatchedTickets.add("PROJ-42");

      const res = await request(app)
        .post("/dispatch/feature")
        .send(validPayload);

      expect(res.status).toBe(409);
    });
  });

  describe("POST /dispatch/review", () => {
    it("should reject invalid payload", async () => {
      const res = await request(app)
        .post("/dispatch/review")
        .send({ prNumber: "not-a-number" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /status", () => {
    it("should return service status", async () => {
      const res = await request(app).get("/status");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("paused", false);
      expect(res.body).toHaveProperty("activeSessions");
      expect(res.body).toHaveProperty("queueDepth");
      expect(res.body).toHaveProperty("uptime");
    });
  });

  describe("POST /kill/:sessionId", () => {
    it("should return 404 for unknown session", async () => {
      const res = await request(app).post("/kill/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /pause and /resume", () => {
    it("should pause and resume dispatching", async () => {
      let res = await request(app).post("/pause");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "paused");

      // Verify dispatch is blocked
      res = await request(app)
        .post("/dispatch/review")
        .send({ prNumber: 1, repository: "github.com/org/repo" });
      expect(res.status).toBe(503);

      // Resume
      res = await request(app).post("/resume");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "resumed");
    });
  });
});
