import type { Priority } from "../types.js";
import { PriorityQueue } from "./queue.js";

export interface SemaphoreConfig {
  maxSessions: number;
  maxPerRepo: number;
  queueMax?: number;
}

export interface SemaphoreCallbacks {
  onEnqueue?: (sessionId: string, repo: string, position: number) => void;
  onDequeue?: (sessionId: string, repo: string, waitedMs: number) => void;
}

interface WaitingEntry {
  sessionId: string;
  repo: string;
  resolve: () => void;
  enqueuedAt: number;
}

/**
 * Concurrency semaphore with global + per-repo limits and a priority queue.
 * When at capacity, `acquire()` blocks until a slot is available.
 */
export class Semaphore {
  private readonly maxSessions: number;
  private readonly maxPerRepo: number;
  private readonly queue: PriorityQueue<WaitingEntry>;
  private readonly callbacks: SemaphoreCallbacks;

  // sessionId → repo
  private readonly activeSessions = new Map<string, string>();
  // repo → count
  private readonly repoCounts = new Map<string, number>();

  constructor(config: SemaphoreConfig, callbacks: SemaphoreCallbacks = {}) {
    this.maxSessions = config.maxSessions;
    this.maxPerRepo = config.maxPerRepo;
    this.queue = new PriorityQueue<WaitingEntry>(config.queueMax ?? 50);
    this.callbacks = callbacks;
  }

  /**
   * Acquire a slot. Blocks (via promise) if at capacity.
   * Throws if the queue is full.
   */
  async acquire(
    repo: string,
    sessionId: string,
    priority: Priority = "medium",
  ): Promise<void> {
    if (this.canAcquire(repo)) {
      this.allocate(repo, sessionId);
      return;
    }

    return new Promise<void>((resolve) => {
      const entry: WaitingEntry = {
        sessionId,
        repo,
        resolve,
        enqueuedAt: Date.now(),
      };

      this.queue.enqueue(entry, priority);
      this.callbacks.onEnqueue?.(sessionId, repo, this.queue.size);
    });
  }

  /** Release a slot and process the next waiting entry. */
  release(sessionId: string): void {
    const repo = this.activeSessions.get(sessionId);
    if (!repo) return;

    this.activeSessions.delete(sessionId);
    const count = this.repoCounts.get(repo) ?? 0;
    if (count <= 1) {
      this.repoCounts.delete(repo);
    } else {
      this.repoCounts.set(repo, count - 1);
    }

    this.processQueue();
  }

  /** Non-blocking attempt to acquire a slot. Returns true if successful. */
  tryAcquire(repo: string, sessionId: string): boolean {
    if (!this.canAcquire(repo)) return false;
    this.allocate(repo, sessionId);
    return true;
  }

  /** Total number of active slots. */
  activeCount(): number {
    return this.activeSessions.size;
  }

  /** Number of active slots for a specific repo. */
  activeCountForRepo(repo: string): number {
    return this.repoCounts.get(repo) ?? 0;
  }

  /** Can a slot be acquired for this repo without blocking? */
  isAvailable(repo: string): boolean {
    return this.canAcquire(repo);
  }

  /** Current queue depth. */
  queueDepth(): number {
    return this.queue.size;
  }

  private canAcquire(repo: string): boolean {
    if (this.activeSessions.size >= this.maxSessions) return false;
    const repoCount = this.repoCounts.get(repo) ?? 0;
    return repoCount < this.maxPerRepo;
  }

  private allocate(repo: string, sessionId: string): void {
    this.activeSessions.set(sessionId, repo);
    this.repoCounts.set(repo, (this.repoCounts.get(repo) ?? 0) + 1);
  }

  private processQueue(): void {
    // Find the highest-priority entry whose repo has capacity
    const entry = this.queue.dequeueWhere((e) => this.canAcquire(e.repo));
    if (!entry) return;

    this.allocate(entry.repo, entry.sessionId);
    const waitedMs = Date.now() - entry.enqueuedAt;
    this.callbacks.onDequeue?.(entry.sessionId, entry.repo, waitedMs);
    entry.resolve();
  }
}
