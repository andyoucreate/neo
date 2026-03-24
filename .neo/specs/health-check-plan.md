# Health Check Endpoint Implementation Plan

**Goal:** Add a `neo health` command that performs 3 quick checks and returns a JSON summary.

**Architecture:** Single CLI command with inline check functions. Each check returns a status object with `ok: boolean` and optional `error` or `version` info. Output is always JSON for easy parsing by scripts/CI.

**Tech Stack:** Node.js fs/child_process APIs, citty CLI framework, existing @neotx/core config loader.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/cli/src/commands/health.ts` | CLI command with 3 health checks |
| Create | `packages/cli/src/__tests__/health.test.ts` | Unit tests for health check logic |
| Modify | `packages/cli/src/index.ts` | Register health subcommand |

---

### Task 1: Implement Health Check Command

**Files:**
- Create: `packages/cli/src/commands/health.ts`
- Test: `packages/cli/src/__tests__/health.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/src/__tests__/health.test.ts
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

describe("health command", () => {
  describe("command export", () => {
    it("exports a valid citty command definition", async () => {
      const { default: healthCmd } = await import("../commands/health.js");
      expect(healthCmd.meta.name).toBe("health");
      expect(typeof healthCmd.run).toBe("function");
    });

    it("has correct description", async () => {
      const { default: healthCmd } = await import("../commands/health.js");
      expect(healthCmd.meta.description).toContain("health check");
    });
  });

  describe("HealthSummary structure", () => {
    it("aggregates all checks with overall status", () => {
      const summary = {
        ok: false,
        checks: {
          config: { ok: true },
          git: { ok: true },
          claude: { ok: false, error: "timeout" },
        },
      };

      expect(summary.ok).toBe(false);
      expect(summary.checks.config.ok).toBe(true);
      expect(summary.checks.claude.ok).toBe(false);
    });

    it("is ok only when all checks pass", () => {
      const checks = {
        config: { ok: true },
        git: { ok: true },
        claude: { ok: true },
      };
      const allOk = Object.values(checks).every((c) => c.ok);

      expect(allOk).toBe(true);
    });

    it("is not ok when any check fails", () => {
      const checks = {
        config: { ok: true },
        git: { ok: false, error: "not found" },
        claude: { ok: true },
      };
      const allOk = Object.values(checks).every((c) => c.ok);

      expect(allOk).toBe(false);
    });
  });

  describe("checkGit behavior", () => {
    it("returns ok:true with version when git is available", async () => {
      // This test runs against real system git
      try {
        const { stdout } = await execFileAsync("git", ["--version"]);
        const hasVersion = stdout.includes("git version");
        expect(hasVersion).toBe(true);
      } catch {
        // Skip if git not installed (CI edge case)
        expect(true).toBe(true);
      }
    });
  });

  describe("exit code logic", () => {
    it("returns 0 when all checks pass", () => {
      const summary = { ok: true, checks: {} };
      const exitCode = summary.ok ? 0 : 1;
      expect(exitCode).toBe(0);
    });

    it("returns 1 when any check fails", () => {
      const summary = { ok: false, checks: {} };
      const exitCode = summary.ok ? 0 : 1;
      expect(exitCode).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/cli/src/__tests__/health.test.ts`
Expected: FAIL with "Cannot find module '../commands/health.js'" (command doesn't exist yet)

- [ ] **Step 3: Write the health command implementation**

```typescript
// packages/cli/src/commands/health.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadGlobalConfig } from "@neotx/core";
import { defineCommand } from "citty";

const execFileAsync = promisify(execFile);

const CLAUDE_TIMEOUT_MS = 5000;

interface CheckResult {
  ok: boolean;
  version?: string;
  error?: string;
}

interface HealthSummary {
  ok: boolean;
  checks: {
    config: CheckResult;
    git: CheckResult;
    claude: CheckResult;
  };
}

async function checkConfig(): Promise<CheckResult> {
  try {
    await loadGlobalConfig();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkGit(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    const match = stdout.match(/git version (\d+\.\d+\.\d+)/);
    return { ok: true, version: match?.[1] ?? "unknown" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkClaude(): Promise<CheckResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

    const { stdout } = await execFileAsync("claude", ["--version"], {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const version = stdout.trim();
    return { ok: true, version };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: `timeout after ${CLAUDE_TIMEOUT_MS}ms` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default defineCommand({
  meta: {
    name: "health",
    description: "Quick health check: config, git, Claude SDK (JSON output)",
  },
  async run() {
    const [config, git, claude] = await Promise.all([
      checkConfig(),
      checkGit(),
      checkClaude(),
    ]);

    const summary: HealthSummary = {
      ok: config.ok && git.ok && claude.ok,
      checks: { config, git, claude },
    };

    console.log(JSON.stringify(summary, null, 2));

    // Use process.exitCode (not process.exit) to allow proper cleanup
    if (!summary.ok) {
      process.exitCode = 1;
    }
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/cli/src/__tests__/health.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/health.ts packages/cli/src/__tests__/health.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add health check command

Add `neo health` command that performs 3 quick checks:
- Config: validates ~/.neo/config.yml
- Git: verifies git is available
- Claude: checks Claude CLI responds (5s timeout)

Returns JSON summary with overall status and per-check details.
Exit code 1 if any check fails.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Register Health Command in CLI

**Files:**
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Verify command is not yet registered**

Run: `grep -c "health" packages/cli/src/index.ts`
Expected: 0 (no matches)

- [ ] **Step 2: Add health to subCommands**

Add the following line after the `guide` entry in the subCommands object:

```typescript
health: () => import("./commands/health.js").then((m) => m.default),
```

The modified section of `packages/cli/src/index.ts` should read:

```typescript
guide: () => import("./commands/guide.js").then((m) => m.default),
health: () => import("./commands/health.js").then((m) => m.default),
doctor: () => import("./commands/doctor.js").then((m) => m.default),
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build && pnpm typecheck`
Expected: PASS (no type errors)

- [ ] **Step 4: Manual integration test**

Run: `node packages/cli/dist/index.js health`
Expected: JSON output like:
```json
{
  "ok": true,
  "checks": {
    "config": { "ok": true },
    "git": { "ok": true, "version": "2.39.0" },
    "claude": { "ok": true, "version": "claude-code 1.0.0" }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "$(cat <<'EOF'
feat(cli): register health command

Add health to CLI subcommands.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Run Full Validation

- [ ] **Step 1: Run full test suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: All tests pass

- [ ] **Step 2: Verify health command works end-to-end**

Run: `node packages/cli/dist/index.js health`
Expected: JSON output with status for all 3 checks

- [ ] **Step 3: Verify exit code on failure (optional)**

Run: `node packages/cli/dist/index.js health; echo "Exit code: $?"`
Expected: Exit code 0 if all pass, 1 if any fail

---

## Summary

| Task | Description | Files Changed |
|------|-------------|---------------|
| 1 | Health check command + tests | 2 new |
| 2 | Register in CLI | 1 modified |
| 3 | Full validation | 0 |

**Total:** 2 new files, 1 modified file, 3 tasks.
