/**
 * Concurrency utilities for task orchestration.
 */

/**
 * Configuration for the Semaphore.
 */
export interface SemaphoreConfig {
  maxConcurrency: number;
  acquireTimeoutMs?: number;
}

/**
 * A waiter in the semaphore queue.
 */
interface SemaphoreWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Semaphore for controlling concurrent access to resources.
 * Provides acquire/release pattern with optional timeout.
 */
export class Semaphore {
  private readonly maxConcurrency: number;
  private readonly acquireTimeoutMs: number;
  private current = 0;
  private readonly queue: SemaphoreWaiter[] = [];

  constructor(config: SemaphoreConfig | number) {
    if (typeof config === "number") {
      this.maxConcurrency = config;
      this.acquireTimeoutMs = 30000;
    } else {
      this.maxConcurrency = config.maxConcurrency;
      this.acquireTimeoutMs = config.acquireTimeoutMs ?? 30000;
    }

    if (this.maxConcurrency <= 0) {
      throw new Error("maxConcurrency must be positive");
    }
  }

  /**
   * Acquires a permit from the semaphore.
   * Blocks if no permits are available until one is released or timeout occurs.
   */
  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrency) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.queue.findIndex((w) => w.resolve === resolve);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
        reject(new Error(`Semaphore acquire timed out after ${this.acquireTimeoutMs}ms`));
      }, this.acquireTimeoutMs);

      this.queue.push({ resolve, reject, timeoutId });
    });
  }

  /**
   * Releases a permit back to the semaphore.
   * Wakes up the next waiter in the queue if any.
   */
  release(): void {
    if (this.current === 0) {
      throw new Error("Cannot release: no permits held");
    }

    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timeoutId);
      next.resolve();
    } else {
      this.current--;
    }
  }

  /**
   * Executes a function with a semaphore permit.
   * Automatically releases the permit when done.
   */
  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Returns the number of available permits.
   */
  get available(): number {
    return this.maxConcurrency - this.current;
  }

  /**
   * Returns the number of waiters in the queue.
   */
  get waiting(): number {
    return this.queue.length;
  }
}

/**
 * Configuration for concurrent task execution.
 */
export interface ConcurrentConfig {
  maxConcurrency: number;
  stopOnError?: boolean;
}

/**
 * Result of concurrent task execution.
 */
export interface ConcurrentResult<T> {
  index: number;
  result?: T;
  error?: Error;
}

/**
 * Executes tasks concurrently with a limit on parallelism.
 * @param tasks Array of functions that return promises
 * @param config Concurrency configuration
 * @returns Array of results in the same order as input tasks
 */
export async function runConcurrently<T>(
  tasks: Array<() => Promise<T>>,
  config: ConcurrentConfig | number,
): Promise<ConcurrentResult<T>[]> {
  const maxConcurrency = typeof config === "number" ? config : config.maxConcurrency;
  const stopOnError = typeof config === "number" ? false : (config.stopOnError ?? false);

  const results: ConcurrentResult<T>[] = [];
  const semaphore = new Semaphore(maxConcurrency);
  let stopped = false;

  const executeTask = async (
    task: () => Promise<T>,
    index: number,
  ): Promise<ConcurrentResult<T>> => {
    if (stopped) {
      return { index, error: new Error("Execution stopped due to error") };
    }

    return semaphore.withPermit(async () => {
      if (stopped) {
        return { index, error: new Error("Execution stopped due to error") };
      }

      try {
        const result = await task();
        return { index, result };
      } catch (error) {
        if (stopOnError) {
          stopped = true;
        }
        return {
          index,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    });
  };

  const promises = tasks.map((task, index) => executeTask(task, index));
  const settledResults = await Promise.all(promises);

  // Sort by original index
  for (const result of settledResults) {
    results[result.index] = result;
  }

  return results;
}

/**
 * Streams results as tasks complete (not in order).
 */
export async function* streamConcurrently<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrency: number,
): AsyncGenerator<ConcurrentResult<T>, void, unknown> {
  const semaphore = new Semaphore(maxConcurrency);
  const pending = new Map<number, Promise<ConcurrentResult<T>>>();

  for (let i = 0; i < tasks.length; i++) {
    const index = i;
    const task = tasks[i];

    const promise = semaphore.withPermit(async () => {
      try {
        const result = await task();
        return { index, result };
      } catch (error) {
        return {
          index,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    });

    pending.set(index, promise);
  }

  while (pending.size > 0) {
    const completed = await Promise.race(pending.values());
    pending.delete(completed.index);
    yield completed;
  }
}

/**
 * Maps over an array with concurrent execution.
 */
export async function mapConcurrently<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  maxConcurrency: number,
): Promise<R[]> {
  const tasks = items.map((item, index) => () => fn(item, index));
  const results = await runConcurrently(tasks, maxConcurrency);

  // Check for errors
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    throw new AggregateError(
      errors.map((e) => e.error!),
      `${errors.length} of ${items.length} tasks failed`,
    );
  }

  return results.map((r) => r.result!);
}
