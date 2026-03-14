import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedRun } from "@neo-cli/core";
import { getRunsDir, listReposFromGlobalConfig, toRepoSlug } from "@neo-cli/core";

export interface RepoFilter {
  mode: "cwd" | "all" | "named";
  repoSlug?: string;
  repoPath?: string;
}

/**
 * Resolve which repos to query based on --all / --repo flags.
 * Default: CWD-based (finds the matching registered repo slug, or uses basename).
 */
export async function resolveRepoFilter(args: {
  all?: boolean | undefined;
  repo?: string | undefined;
}): Promise<RepoFilter> {
  if (args.all) return { mode: "all" };

  if (args.repo) {
    const repo = args.repo;
    // Could be a name/slug or a path
    const repos = await listReposFromGlobalConfig();
    const match = repos.find(
      (r) => toRepoSlug(r) === repo || path.resolve(r.path) === path.resolve(repo),
    );
    if (match) {
      return { mode: "named", repoSlug: toRepoSlug(match), repoPath: match.path };
    }
    // Treat as path, derive slug
    return { mode: "named", repoSlug: toRepoSlug({ path: repo }), repoPath: repo };
  }

  // Default: CWD
  const cwd = process.cwd();
  const repos = await listReposFromGlobalConfig();
  const match = repos.find((r) => path.resolve(r.path) === cwd);
  const slug = match ? toRepoSlug(match) : toRepoSlug({ path: cwd });
  return { mode: "cwd", repoSlug: slug, repoPath: cwd };
}

/**
 * Load persisted runs, filtered by RepoFilter.
 */
export async function loadRunsFiltered(filter: RepoFilter): Promise<PersistedRun[]> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) return [];

  const runs: PersistedRun[] = [];

  if (filter.mode === "all") {
    // Scan all slug subdirs + legacy flat files
    const entries = await readdir(runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await loadRunsFromDir(path.join(runsDir, entry.name), runs);
      } else if (entry.name.endsWith(".json")) {
        await loadRunFile(path.join(runsDir, entry.name), runs);
      }
    }
  } else {
    // Specific slug dir
    const slugDir = path.join(runsDir, filter.repoSlug ?? "unknown");
    await loadRunsFromDir(slugDir, runs);
    // Also check legacy flat files matching this repo
    await loadLegacyRuns(runsDir, filter.repoPath, runs);
  }

  runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return runs;
}

async function loadRunsFromDir(dir: string, runs: PersistedRun[]): Promise<void> {
  if (!existsSync(dir)) return;
  const files = await readdir(dir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    await loadRunFile(path.join(dir, file), runs);
  }
}

async function loadRunFile(filePath: string, runs: PersistedRun[]): Promise<void> {
  try {
    const content = await readFile(filePath, "utf-8");
    runs.push(JSON.parse(content) as PersistedRun);
  } catch {
    // Skip corrupt files
  }
}

async function loadLegacyRuns(
  runsDir: string,
  repoPath: string | undefined,
  runs: PersistedRun[],
): Promise<void> {
  if (!repoPath) return;
  const resolvedRepo = path.resolve(repoPath);

  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(runsDir, entry.name);
      const content = await readFile(filePath, "utf-8");
      const run = JSON.parse(content) as PersistedRun;
      if (path.resolve(run.repo) === resolvedRepo) {
        // Avoid duplicates
        if (!runs.some((r) => r.runId === run.runId)) {
          runs.push(run);
        }
      }
    }
  } catch {
    // Non-critical
  }
}
