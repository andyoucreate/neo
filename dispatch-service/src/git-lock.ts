/**
 * Per-repository mutex to serialise git operations (fetch, worktree add)
 * that are not safe to run concurrently on the same repo directory.
 */

const locks = new Map<string, Promise<void>>();

/**
 * Execute `fn` while holding an exclusive lock for `repoDir`.
 * Concurrent calls for the same repo are queued and executed serially.
 */
export async function withGitLock<T>(
  repoDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Wait for any pending operation on this repo
  const previous = locks.get(repoDir) ?? Promise.resolve();

  let releaseLock: () => void;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  locks.set(repoDir, current);

  await previous;

  try {
    return await fn();
  } finally {
    releaseLock!();
    // Clean up if we're the last in the chain
    if (locks.get(repoDir) === current) {
      locks.delete(repoDir);
    }
  }
}
