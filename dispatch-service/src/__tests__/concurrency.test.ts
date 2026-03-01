import { beforeEach, describe, expect, it } from "vitest";
import { Semaphore } from "../concurrency.js";

describe("Semaphore", () => {
  let semaphore: Semaphore;

  beforeEach(() => {
    semaphore = new Semaphore(3, 2, 5);
  });

  describe("acquire", () => {
    it("should allocate a session when under limit", async () => {
      const sessionId = await semaphore.acquire("github.com/org/repo");
      expect(sessionId).toMatch(/^dispatch-/);
      expect(semaphore.activeCount).toBe(1);
    });

    it("should allocate multiple sessions up to total limit", async () => {
      await semaphore.acquire("github.com/org/repo1");
      await semaphore.acquire("github.com/org/repo2");
      await semaphore.acquire("github.com/org/repo3");
      expect(semaphore.activeCount).toBe(3);
    });

    it("should enforce per-project limit", async () => {
      await semaphore.acquire("github.com/org/repo");
      await semaphore.acquire("github.com/org/repo");

      // Third acquire for same repo should queue
      const promise = semaphore.acquire("github.com/org/repo");
      expect(semaphore.queueDepth).toBe(1);

      // But a different repo should still work
      await semaphore.acquire("github.com/org/other");
      expect(semaphore.activeCount).toBe(3);

      // Cleanup: release to unblock the queued entry
      const sessions = semaphore.getActiveSessions();
      semaphore.release(sessions[0]!.sessionId);
      await promise;
    });

    it("should throw when queue is full", async () => {
      const sem = new Semaphore(1, 1, 2);
      await sem.acquire("github.com/org/repo");

      // Fill the queue
      sem.acquire("github.com/org/repo"); // queued
      sem.acquire("github.com/org/repo"); // queued

      // This should throw
      await expect(sem.acquire("github.com/org/repo")).rejects.toThrow(
        "Queue full",
      );
    });
  });

  describe("release", () => {
    it("should release a session and decrement counts", async () => {
      const sessionId = await semaphore.acquire("github.com/org/repo");
      expect(semaphore.activeCount).toBe(1);

      semaphore.release(sessionId);
      expect(semaphore.activeCount).toBe(0);
    });

    it("should process queued entries after release", async () => {
      const sem = new Semaphore(1, 1, 5);
      const id1 = await sem.acquire("github.com/org/repo");

      const promise2 = sem.acquire("github.com/org/repo");
      expect(sem.queueDepth).toBe(1);

      sem.release(id1);
      const id2 = await promise2;
      expect(id2).toMatch(/^dispatch-/);
      expect(sem.activeCount).toBe(1);
      expect(sem.queueDepth).toBe(0);
    });

    it("should handle releasing unknown session gracefully", () => {
      expect(() => semaphore.release("nonexistent")).not.toThrow();
    });
  });

  describe("getActiveSessions", () => {
    it("should return all active sessions", async () => {
      await semaphore.acquire("github.com/org/repo1");
      await semaphore.acquire("github.com/org/repo2");

      const sessions = semaphore.getActiveSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toHaveProperty("sessionId");
      expect(sessions[0]).toHaveProperty("repository");
    });
  });
});
