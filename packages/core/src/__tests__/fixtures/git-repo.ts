import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Initializes a git repository with a main branch and initial commit.
 * Configures test user identity to avoid git config errors.
 */
export async function createTestRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

/**
 * Creates a file at the specified path within the repo and commits it.
 */
export async function createTestFile(
  repo: string,
  filePath: string,
  content: string,
): Promise<void> {
  const fullPath = path.join(repo, filePath);
  const fileDir = path.dirname(fullPath);
  await mkdir(fileDir, { recursive: true });
  await writeFile(fullPath, content);
  await execFileAsync("git", ["add", filePath], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", `Add ${filePath}`], { cwd: repo });
}

/**
 * Creates a new branch from the current HEAD.
 */
export async function createTestBranch(repo: string, name: string): Promise<void> {
  await execFileAsync("git", ["checkout", "-b", name], { cwd: repo });
}

/**
 * Removes a test repository directory recursively.
 */
export async function cleanupTestRepo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
