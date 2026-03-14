/**
 * Per-repository in-memory mutex to serialise git operations.
 * Concurrent git commands on the same repo corrupt the index — this prevents that.
 */

const locks = new Map<string, Promise<void>>();

/**
 * Execute `fn` while holding an exclusive lock for `repoPath`.
 * Concurrent calls for the same repo are queued and executed serially.
 * Operations on different repos run in parallel.
 */
export async function withGitLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(repoPath) ?? Promise.resolve();

  let releaseLock: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  locks.set(repoPath, current);

  await previous;

  try {
    return await fn();
  } finally {
    releaseLock?.();
    if (locks.get(repoPath) === current) {
      locks.delete(repoPath);
    }
  }
}
