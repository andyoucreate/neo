import { CONCURRENCY_LIMITS } from "./config.js";
import { logger } from "./logger.js";

interface QueueEntry {
  repository: string;
  resolve: (sessionId: string) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

/**
 * Concurrency semaphore for SDK query() sessions.
 * Enforces max total sessions and max per-project limits with a FIFO queue.
 */
export class Semaphore {
  private readonly maxTotal: number;
  private readonly maxPerProject: number;
  private readonly queueMaxSize: number;

  private activeSessions = new Map<string, string>(); // sessionId → repository
  private projectCounts = new Map<string, number>(); // repository → count
  private queue: QueueEntry[] = [];
  private nextSessionId = 0;

  constructor(
    maxTotal = CONCURRENCY_LIMITS.maxConcurrentSessions,
    maxPerProject = CONCURRENCY_LIMITS.maxConcurrentPerProject,
    queueMaxSize = CONCURRENCY_LIMITS.queueMaxSize,
  ) {
    this.maxTotal = maxTotal;
    this.maxPerProject = maxPerProject;
    this.queueMaxSize = queueMaxSize;
  }

  /**
   * Acquire a session slot. Returns a session ID.
   * Blocks (via promise) if at capacity, queuing the request.
   * Throws if the queue is full.
   */
  async acquire(repository: string): Promise<string> {
    if (this.canRun(repository)) {
      return this.allocate(repository);
    }

    if (this.queue.length >= this.queueMaxSize) {
      throw new Error(
        `Queue full (${this.queueMaxSize} pending). Cannot accept new dispatch.`,
      );
    }

    return new Promise<string>((resolve, reject) => {
      this.queue.push({ repository, resolve, reject, enqueuedAt: Date.now() });
      logger.info(
        `Queued dispatch for ${repository} (position ${this.queue.length})`,
      );
    });
  }

  /**
   * Release a session slot and process the next queued entry.
   */
  release(sessionId: string): void {
    const repository = this.activeSessions.get(sessionId);
    if (!repository) {
      logger.warn(`Attempted to release unknown session: ${sessionId}`);
      return;
    }

    this.activeSessions.delete(sessionId);
    const count = this.projectCounts.get(repository) ?? 0;
    if (count <= 1) {
      this.projectCounts.delete(repository);
    } else {
      this.projectCounts.set(repository, count - 1);
    }

    logger.info(
      `Released session ${sessionId} (${repository}). Active: ${this.activeSessions.size}/${this.maxTotal}`,
    );

    this.processQueue();
  }

  /**
   * Reduce max concurrent sessions (for rate limit backpressure).
   */
  reduceMax(by: number): void {
    const newMax = Math.max(1, this.maxTotal - by);
    logger.warn(
      `Reducing max concurrent sessions: ${this.maxTotal} → ${newMax}`,
    );
    // Note: we don't kill running sessions, just prevent new ones
    Object.defineProperty(this, "maxTotal", {
      value: newMax,
      writable: true,
      configurable: true,
    });
  }

  get activeCount(): number {
    return this.activeSessions.size;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  getActiveSessions(): Array<{ sessionId: string; repository: string }> {
    return Array.from(this.activeSessions.entries()).map(
      ([sessionId, repository]) => ({
        sessionId,
        repository,
      }),
    );
  }

  private canRun(repository: string): boolean {
    if (this.activeSessions.size >= this.maxTotal) return false;
    const projectCount = this.projectCounts.get(repository) ?? 0;
    return projectCount < this.maxPerProject;
  }

  private allocate(repository: string): string {
    const sessionId = `dispatch-${Date.now()}-${this.nextSessionId++}`;
    this.activeSessions.set(sessionId, repository);
    this.projectCounts.set(
      repository,
      (this.projectCounts.get(repository) ?? 0) + 1,
    );

    logger.info(
      `Allocated session ${sessionId} for ${repository}. Active: ${this.activeSessions.size}/${this.maxTotal}`,
    );

    return sessionId;
  }

  private processQueue(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      if (this.canRun(entry.repository)) {
        this.queue.splice(i, 1);
        const sessionId = this.allocate(entry.repository);
        entry.resolve(sessionId);
        return;
      }
    }
  }
}
