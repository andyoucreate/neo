import { describe, expect, it } from "vitest";
import { PriorityQueue } from "../concurrency/queue.js";
import { Semaphore } from "../concurrency/semaphore.js";

// ─── PriorityQueue ──────────────────────────────────────

describe("PriorityQueue", () => {
  it("enqueues and dequeues in FIFO order for same priority", () => {
    const q = new PriorityQueue<string>(10);
    q.enqueue("a", "medium");
    q.enqueue("b", "medium");
    q.enqueue("c", "medium");

    expect(q.dequeue()).toBe("a");
    expect(q.dequeue()).toBe("b");
    expect(q.dequeue()).toBe("c");
    expect(q.dequeue()).toBeUndefined();
  });

  it("dequeues critical before low", () => {
    const q = new PriorityQueue<string>(10);
    q.enqueue("low-1", "low");
    q.enqueue("critical-1", "critical");
    q.enqueue("medium-1", "medium");
    q.enqueue("high-1", "high");

    expect(q.dequeue()).toBe("critical-1");
    expect(q.dequeue()).toBe("high-1");
    expect(q.dequeue()).toBe("medium-1");
    expect(q.dequeue()).toBe("low-1");
  });

  it("maintains FIFO within same priority level", () => {
    const q = new PriorityQueue<string>(10);
    q.enqueue("high-1", "high");
    q.enqueue("high-2", "high");
    q.enqueue("critical-1", "critical");
    q.enqueue("high-3", "high");

    expect(q.dequeue()).toBe("critical-1");
    expect(q.dequeue()).toBe("high-1");
    expect(q.dequeue()).toBe("high-2");
    expect(q.dequeue()).toBe("high-3");
  });

  it("peek returns the highest priority item without removing it", () => {
    const q = new PriorityQueue<string>(10);
    q.enqueue("low", "low");
    q.enqueue("high", "high");

    expect(q.peek()).toBe("high");
    expect(q.size).toBe(2);
  });

  it("reports size and isEmpty correctly", () => {
    const q = new PriorityQueue<string>(10);
    expect(q.isEmpty).toBe(true);
    expect(q.size).toBe(0);

    q.enqueue("a", "medium");
    expect(q.isEmpty).toBe(false);
    expect(q.size).toBe(1);

    q.dequeue();
    expect(q.isEmpty).toBe(true);
  });

  it("remove removes a specific item by predicate", () => {
    const q = new PriorityQueue<string>(10);
    q.enqueue("a", "medium");
    q.enqueue("b", "medium");
    q.enqueue("c", "medium");

    const removed = q.remove((item) => item === "b");
    expect(removed).toBe(true);
    expect(q.size).toBe(2);
    expect(q.dequeue()).toBe("a");
    expect(q.dequeue()).toBe("c");
  });

  it("remove returns false when item not found", () => {
    const q = new PriorityQueue<string>(10);
    q.enqueue("a", "medium");

    expect(q.remove((item) => item === "z")).toBe(false);
    expect(q.size).toBe(1);
  });

  it("throws when exceeding queueMax", () => {
    const q = new PriorityQueue<string>(2);
    q.enqueue("a", "medium");
    q.enqueue("b", "medium");

    expect(() => q.enqueue("c", "medium")).toThrow("Queue full (2 items)");
  });

  it("dequeueWhere finds the first matching item in priority order", () => {
    const q = new PriorityQueue<string>(10);
    q.enqueue("low-a", "low");
    q.enqueue("high-a", "high");
    q.enqueue("high-b", "high");

    const result = q.dequeueWhere((item) => item.startsWith("high"));
    expect(result).toBe("high-a");
    expect(q.size).toBe(2);
  });

  it("dequeueWhere returns undefined when no match", () => {
    const q = new PriorityQueue<string>(10);
    q.enqueue("a", "medium");

    expect(q.dequeueWhere((item) => item === "z")).toBeUndefined();
    expect(q.size).toBe(1);
  });
});

// ─── Semaphore ──────────────────────────────────────────

describe("Semaphore", () => {
  it("acquire and release: basic flow", async () => {
    const sem = new Semaphore({ maxSessions: 2, maxPerRepo: 2 });

    await sem.acquire("repo-a", "s1");
    expect(sem.activeCount()).toBe(1);
    expect(sem.activeCountForRepo("repo-a")).toBe(1);

    sem.release("s1");
    expect(sem.activeCount()).toBe(0);
    expect(sem.activeCountForRepo("repo-a")).toBe(0);
  });

  it("global limit: acquiring beyond maxSessions blocks", async () => {
    const sem = new Semaphore({ maxSessions: 2, maxPerRepo: 5 });

    await sem.acquire("repo-a", "s1");
    await sem.acquire("repo-b", "s2");

    let resolved = false;
    const blocked = sem.acquire("repo-c", "s3").then(() => {
      resolved = true;
    });

    // Give microtasks a chance to run
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(sem.activeCount()).toBe(2);
    expect(sem.queueDepth()).toBe(1);

    // Release one to unblock
    sem.release("s1");
    await blocked;
    expect(resolved).toBe(true);
    expect(sem.activeCount()).toBe(2);
  });

  it("per-repo limit: acquiring beyond maxPerRepo blocks", async () => {
    const sem = new Semaphore({ maxSessions: 10, maxPerRepo: 1 });

    await sem.acquire("repo-a", "s1");

    let resolved = false;
    const blocked = sem.acquire("repo-a", "s2").then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(sem.activeCountForRepo("repo-a")).toBe(1);

    sem.release("s1");
    await blocked;
    expect(resolved).toBe(true);
    expect(sem.activeCountForRepo("repo-a")).toBe(1);
  });

  it("release unblocks waiting acquire", async () => {
    const sem = new Semaphore({ maxSessions: 1, maxPerRepo: 1 });

    await sem.acquire("repo-a", "s1");

    const order: string[] = [];
    const blocked = sem.acquire("repo-a", "s2").then(() => {
      order.push("s2-acquired");
    });

    order.push("before-release");
    sem.release("s1");
    await blocked;
    order.push("after-blocked");

    expect(order).toEqual(["before-release", "s2-acquired", "after-blocked"]);
  });

  it("tryAcquire returns false when full", () => {
    const sem = new Semaphore({ maxSessions: 1, maxPerRepo: 1 });

    expect(sem.tryAcquire("repo-a", "s1")).toBe(true);
    expect(sem.tryAcquire("repo-a", "s2")).toBe(false);
    expect(sem.tryAcquire("repo-b", "s3")).toBe(false); // global full
    expect(sem.activeCount()).toBe(1);
  });

  it("tryAcquire returns false when per-repo full", () => {
    const sem = new Semaphore({ maxSessions: 10, maxPerRepo: 1 });

    expect(sem.tryAcquire("repo-a", "s1")).toBe(true);
    expect(sem.tryAcquire("repo-a", "s2")).toBe(false);
    expect(sem.tryAcquire("repo-b", "s3")).toBe(true); // different repo
  });

  it("isAvailable reflects current capacity", async () => {
    const sem = new Semaphore({ maxSessions: 2, maxPerRepo: 1 });

    expect(sem.isAvailable("repo-a")).toBe(true);
    await sem.acquire("repo-a", "s1");
    expect(sem.isAvailable("repo-a")).toBe(false); // per-repo full
    expect(sem.isAvailable("repo-b")).toBe(true);

    await sem.acquire("repo-b", "s2");
    expect(sem.isAvailable("repo-c")).toBe(false); // global full
  });

  it("priority queue: critical dequeued before low", async () => {
    const sem = new Semaphore({ maxSessions: 1, maxPerRepo: 1 });

    await sem.acquire("repo-a", "s1");

    const order: string[] = [];
    const lowBlocked = sem.acquire("repo-a", "s-low", "low").then(() => {
      order.push("low");
    });
    const criticalBlocked = sem.acquire("repo-a", "s-critical", "critical").then(() => {
      order.push("critical");
    });

    sem.release("s1");
    await criticalBlocked;

    // critical should have been dequeued first
    expect(order[0]).toBe("critical");

    sem.release("s-critical");
    await lowBlocked;
    expect(order).toEqual(["critical", "low"]);
  });

  it("queue overflow: throws when exceeding queueMax", async () => {
    const sem = new Semaphore({
      maxSessions: 1,
      maxPerRepo: 1,
      queueMax: 2,
    });

    await sem.acquire("repo-a", "s1");

    // These two will queue
    sem.acquire("repo-a", "s2");
    sem.acquire("repo-a", "s3");

    // Third should throw
    await expect(sem.acquire("repo-a", "s4")).rejects.toThrow("Queue full (2 items)");

    // Cleanup
    sem.release("s1");
  });

  it("remove from queue: cancel a waiting session", async () => {
    const sem = new Semaphore({ maxSessions: 1, maxPerRepo: 1 });

    await sem.acquire("repo-a", "s1");

    // Queue two sessions
    const s2Promise = sem.acquire("repo-a", "s2");
    let s3Resolved = false;
    const s3Promise = sem.acquire("repo-a", "s3").then(() => {
      s3Resolved = true;
    });

    expect(sem.queueDepth()).toBe(2);

    // Release s1 — s2 should be dequeued (FIFO within same priority)
    sem.release("s1");
    await s2Promise;
    expect(sem.activeCount()).toBe(1);
    expect(s3Resolved).toBe(false);

    sem.release("s2");
    await s3Promise;
    expect(s3Resolved).toBe(true);
  });

  it("concurrent acquire/release stress test", async () => {
    const sem = new Semaphore({ maxSessions: 3, maxPerRepo: 2 });
    const repos = ["repo-a", "repo-b", "repo-c"];

    const promises: Promise<void>[] = [];
    const completed: string[] = [];

    for (let i = 0; i < 10; i++) {
      const repo = repos[i % repos.length] as string;
      const sessionId = `s${i}`;

      promises.push(
        sem.acquire(repo, sessionId).then(() => {
          completed.push(sessionId);
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              sem.release(sessionId);
              resolve();
            }, 5);
          });
        }),
      );
    }

    await Promise.all(promises);

    expect(completed).toHaveLength(10);
    expect(sem.activeCount()).toBe(0);
  });

  it("calls onEnqueue and onDequeue callbacks", async () => {
    const enqueued: Array<{
      sessionId: string;
      repo: string;
      position: number;
    }> = [];
    const dequeued: Array<{ sessionId: string; repo: string }> = [];

    const sem = new Semaphore(
      { maxSessions: 1, maxPerRepo: 1 },
      {
        onEnqueue: (sessionId, repo, position) => {
          enqueued.push({ sessionId, repo, position });
        },
        onDequeue: (sessionId, repo) => {
          dequeued.push({ sessionId, repo });
        },
      },
    );

    await sem.acquire("repo-a", "s1");

    const blocked = sem.acquire("repo-a", "s2");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toEqual({
      sessionId: "s2",
      repo: "repo-a",
      position: 1,
    });

    sem.release("s1");
    await blocked;

    expect(dequeued).toHaveLength(1);
    expect(dequeued[0]?.sessionId).toBe("s2");
    expect(dequeued[0]?.repo).toBe("repo-a");
  });

  it("abort signal: rejects and removes entry from queue", async () => {
    const sem = new Semaphore({ maxSessions: 1, maxPerRepo: 1 });

    await sem.acquire("repo-a", "s1");

    const controller = new AbortController();
    const blocked = sem.acquire("repo-a", "s2", "medium", controller.signal);

    expect(sem.queueDepth()).toBe(1);

    controller.abort();

    await expect(blocked).rejects.toThrow();
    expect(sem.queueDepth()).toBe(0);
    expect(sem.activeCount()).toBe(1);
  });

  it("abort signal: throws immediately if already aborted", async () => {
    const sem = new Semaphore({ maxSessions: 1, maxPerRepo: 1 });

    await sem.acquire("repo-a", "s1");

    const controller = new AbortController();
    controller.abort();

    await expect(sem.acquire("repo-a", "s2", "medium", controller.signal)).rejects.toThrow();
    expect(sem.queueDepth()).toBe(0);
  });

  it("release is idempotent for unknown sessionId", () => {
    const sem = new Semaphore({ maxSessions: 2, maxPerRepo: 2 });
    // Should not throw
    sem.release("nonexistent");
    expect(sem.activeCount()).toBe(0);
  });

  it("processes queue entries for different repos correctly", async () => {
    const sem = new Semaphore({ maxSessions: 2, maxPerRepo: 1 });

    await sem.acquire("repo-a", "s1");
    await sem.acquire("repo-b", "s2");

    // Both repos at per-repo limit, global at max
    // Queue a session for repo-a
    let s3Resolved = false;
    const s3 = sem.acquire("repo-a", "s3").then(() => {
      s3Resolved = true;
    });

    // Queue a session for repo-b
    let s4Resolved = false;
    const s4 = sem.acquire("repo-b", "s4").then(() => {
      s4Resolved = true;
    });

    // Release repo-a — should unblock s3 (repo-a), not s4 (repo-b still full)
    sem.release("s1");
    await s3;
    expect(s3Resolved).toBe(true);
    expect(s4Resolved).toBe(false);

    // Release repo-b — should unblock s4
    sem.release("s2");
    await s4;
    expect(s4Resolved).toBe(true);
  });
});
