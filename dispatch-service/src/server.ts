import type { NextFunction, Request, Response } from "express";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { notifyPipelineResult, notifySubTickets } from "./callback.js";
import { pollCiChecks } from "./ci-check.js";
import { Semaphore } from "./concurrency.js";
import {
  COST_JOURNAL_DIR,
  DAILY_BUDGET_CAP_USD,
  REPOS_BASE_DIR,
  SESSION_INIT_TIMEOUT_MS,
  SESSION_MAX_DURATION_MS,
} from "./config.js";
import { CostJournal } from "./cost-journal.js";
import { appendEvent } from "./event-journal.js";
import { postReviewComment } from "./github-comment.js";
import { clearLoopHistory } from "./hooks.js";
import { logger } from "./logger.js";
import { runFeaturePipeline } from "./pipelines/feature.js";
import { runFixerPipeline } from "./pipelines/fixer.js";
import { runHotfixPipeline } from "./pipelines/hotfix.js";
import { runRefinePipeline } from "./pipelines/refine.js";
import { runReviewPipeline } from "./pipelines/review.js";
import { sanitize } from "./sanitize.js";
import type {
  ActiveSession,
  FeatureRequest,
  FixerRequest,
  HotfixRequest,
  PipelineResult,
  PipelineType,
  RefineRequest,
  RefineResult,
  ReviewRequest,
  ServiceStatus,
} from "./types.js";
import { buildBranchName, createWorktree, createWorktreeForBranch, getDefaultBranch, removeWorktree } from "./worktree.js";

// ─── Zod schemas for request validation ────────────────────────
// Coerce string enums to lowercase before validation
const ticketTypeSchema = z.string().transform((v) => v.toLowerCase()).pipe(z.enum(["feature", "bug", "refactor", "chore"]));
const prioritySchema = z.string().transform((v) => v.toLowerCase()).pipe(z.enum(["critical", "high", "medium", "low"]));
const FIBONACCI_POINTS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144] as const;
const complexitySchema = z.coerce.number().refine(
  (v): v is (typeof FIBONACCI_POINTS)[number] => (FIBONACCI_POINTS as readonly number[]).includes(v),
  { message: "Complexity must be a Fibonacci number: 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144" },
);

const featureSchema = z.object({
  ticketId: z.string().min(1),
  title: z.string().min(1),
  type: ticketTypeSchema,
  priority: prioritySchema,
  complexity: complexitySchema.optional().default(3),
  repository: z.string().min(1),
  criteria: z.string().optional().default(""),
  description: z.string().optional().default(""),
  skills: z.array(z.string()).optional(),
});

const reviewSchema = z.object({
  ticketId: z.string().min(1),
  prNumber: z.number().int().positive(),
  repository: z.string().min(1),
  skills: z.array(z.string()).optional(),
});

const hotfixSchema = z.object({
  ticketId: z.string().min(1),
  title: z.string().min(1),
  priority: prioritySchema,
  repository: z.string().min(1),
  description: z.string().optional().default(""),
  skills: z.array(z.string()).optional(),
});

const severitySchema = z.string().transform((v) => v.toUpperCase()).pipe(z.enum(["CRITICAL", "HIGH", "WARNING"]));

const fixerIssueSchema = z.object({
  source: z.string(),
  severity: severitySchema,
  file: z.string(),
  line: z.number(),
  description: z.string(),
  suggestion: z.string().optional(),
});

const fixerSchema = z.object({
  ticketId: z.string().min(1),
  prNumber: z.number().int().positive(),
  repository: z.string().min(1),
  issues: z.array(fixerIssueSchema).min(1),
});

const refineSchema = z.object({
  ticketId: z.string().min(1),
  title: z.string().min(1),
  type: ticketTypeSchema,
  priority: prioritySchema,
  complexity: complexitySchema.optional(),
  repository: z.string().min(1),
  criteria: z.string().optional(),
  description: z.string().optional(),
});

// ─── Server state ──────────────────────────────────────────────
const semaphore = new Semaphore();
const costJournal = new CostJournal(COST_JOURNAL_DIR);
const activeSessions = new Map<string, ActiveSession>();
const startedAt = Date.now();
let paused = false;

// Track dispatched ticket IDs for idempotency
const dispatchedTickets = new Set<string>();

/**
 * Resolve the local repo directory from a repository identifier.
 */
function resolveRepoDir(repository: string): string {
  const parts = repository.replace("github.com/", "").split("/");
  return `${REPOS_BASE_DIR}/${parts.join("/")}`;
}

/**
 * Create and configure the Express HTTP server.
 */
export function createServer(): express.Express {
  const app = express();

  app.use(express.json({ limit: "500kb" }));

  // ─── Middleware: request ID ───────────────────────────────────
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Request-Id", crypto.randomUUID());
    next();
  });

  // ─── Middleware: JSON parse error handler ─────────────────────
  // Must come right after express.json() to catch malformed JSON bodies
  app.use((err: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err.type === "entity.parse.failed") {
      logger.warn("JSON parse error in request body", { error: err.message });
      res.status(400).json({
        error: "Invalid JSON in request body",
        errorType: "JSON_PARSE_ERROR",
        details: err.message,
      });
      return;
    }
    next(err);
  });

  // ─── Middleware: auth token check ─────────────────────────────
  app.use("/dispatch", (req: Request, res: Response, next: NextFunction) => {
    const authToken = process.env.DISPATCH_AUTH_TOKEN;
    if (authToken && req.headers.authorization !== `Bearer ${authToken}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  // ─── Middleware: pause check ──────────────────────────────────
  app.use("/dispatch", (_req: Request, res: Response, next: NextFunction) => {
    if (paused) {
      res.status(503).json({ error: "Dispatch service paused" });
      return;
    }
    next();
  });

  // ─── Middleware: daily budget guard ─────────────────────────
  app.use("/dispatch", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const todayCost = await costJournal.getTodayCost();
      if (todayCost >= DAILY_BUDGET_CAP_USD) {
        logger.warn(`Daily budget cap reached: $${todayCost.toFixed(2)} >= $${DAILY_BUDGET_CAP_USD}`);
        res.status(429).json({
          error: "Daily budget cap reached",
          todayCost: todayCost.toFixed(2),
          cap: DAILY_BUDGET_CAP_USD,
        });
        return;
      }
    } catch (err) {
      logger.warn("Budget check failed, allowing dispatch", err);
    }
    next();
  });

  // ─── POST /dispatch/feature ──────────────────────────────────
  app.post("/dispatch/feature", async (req: Request, res: Response) => {
    const parsed = featureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    if (dispatchedTickets.has(data.ticketId)) {
      res.status(409).json({ error: "Ticket already dispatched", ticketId: data.ticketId });
      return;
    }

    const sanitized = sanitize(data);
    if (sanitized === "quarantined") {
      appendEvent("dispatch.quarantined", {
        pipeline: "feature",
        ticketId: data.ticketId,
        repository: data.repository,
      }).catch((err: unknown) => logger.error("Failed to log quarantine event", err));
      res.status(422).json({ error: "Content quarantined — invalid input" });
      return;
    }

    await dispatchPipeline(
      "feature",
      data.repository,
      res,
      { ticketId: data.ticketId },
      (sessionId) => dispatchWithWorktree("feature", sessionId, data as FeatureRequest, runFeaturePipeline),
    );
  });

  // ─── POST /dispatch/review ───────────────────────────────────
  app.post("/dispatch/review", async (req: Request, res: Response) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    if (dispatchedTickets.has(data.ticketId)) {
      res.status(409).json({ error: "Ticket already dispatched", ticketId: data.ticketId });
      return;
    }

    await dispatchPipeline(
      "review",
      data.repository,
      res,
      { ticketId: data.ticketId, prNumber: data.prNumber },
      (sessionId) => dispatchWithPrWorktree("review", sessionId, data as ReviewRequest, runReviewPipeline),
    );
  });

  // ─── POST /dispatch/hotfix ───────────────────────────────────
  app.post("/dispatch/hotfix", async (req: Request, res: Response) => {
    const parsed = hotfixSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    if (dispatchedTickets.has(data.ticketId)) {
      res.status(409).json({ error: "Ticket already dispatched", ticketId: data.ticketId });
      return;
    }

    await dispatchPipeline(
      "hotfix",
      data.repository,
      res,
      { ticketId: data.ticketId },
      (sessionId) => dispatchWithWorktree("hotfix", sessionId, data as HotfixRequest, runHotfixPipeline),
    );
  });

  // ─── POST /dispatch/fixer ────────────────────────────────────
  app.post("/dispatch/fixer", async (req: Request, res: Response) => {
    const parsed = fixerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    if (dispatchedTickets.has(data.ticketId)) {
      res.status(409).json({ error: "Ticket already dispatched", ticketId: data.ticketId });
      return;
    }

    await dispatchPipeline(
      "fixer",
      data.repository,
      res,
      { ticketId: data.ticketId, prNumber: data.prNumber },
      (sessionId) => dispatchWithPrWorktree("fixer", sessionId, data as FixerRequest, runFixerPipeline),
    );
  });

  // ─── POST /dispatch/refine ──────────────────────────────────
  app.post("/dispatch/refine", async (req: Request, res: Response) => {
    const parsed = refineSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    const sanitized = sanitize({
      ...data,
      complexity: data.complexity ?? 3,
      criteria: data.criteria ?? "",
      description: data.description ?? "",
    });
    if (sanitized === "quarantined") {
      appendEvent("dispatch.quarantined", {
        pipeline: "refine",
        ticketId: data.ticketId,
        repository: data.repository,
      }).catch((err: unknown) => logger.error("Failed to log quarantine event", err));
      res.status(422).json({ error: "Content quarantined — invalid input" });
      return;
    }

    await dispatchPipeline(
      "refine",
      data.repository,
      res,
      { ticketId: data.ticketId },
      (sessionId) => {
        const repoDir = resolveRepoDir(data.repository);
        void runPipelineInBackground("refine", sessionId, async () => {
          const result = await runRefinePipeline(data as RefineRequest, repoDir);
          return refineResultToPipelineResult(result);
        });
      },
    );
  });

  // ─── GET /dispatch/ci-check ─────────────────────────────────
  const ciCheckSchema = z.object({
    prNumber: z.coerce.number().int().positive(),
    repository: z.string().min(1),
  });

  app.get("/dispatch/ci-check", async (req: Request, res: Response) => {
    const parsed = ciCheckSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const { prNumber, repository } = parsed.data;
    logger.info(`CI check requested for PR #${String(prNumber)} on ${repository}`);

    const result = await pollCiChecks(prNumber, repository);

    logger.info(`CI check result for PR #${String(prNumber)}: ${result.conclusion}`);
    res.json(result);
  });

  // ─── GET /status ─────────────────────────────────────────────
  app.get("/status", async (_req: Request, res: Response) => {
    const todayCost = await costJournal.getTodayCost();
    const remaining = Math.max(0, DAILY_BUDGET_CAP_USD - todayCost);
    const status: ServiceStatus = {
      paused,
      activeSessions: Array.from(activeSessions.values()),
      queueDepth: semaphore.queueDepth,
      totalCostToday: todayCost,
      budgetCapUsd: DAILY_BUDGET_CAP_USD,
      budgetRemainingUsd: remaining,
      budgetUtilizationPct: DAILY_BUDGET_CAP_USD > 0
        ? Math.round((todayCost / DAILY_BUDGET_CAP_USD) * 100)
        : 0,
      uptime: Date.now() - startedAt,
    };
    res.json(status);
  });

  // ─── POST /kill/:sessionId ───────────────────────────────────
  app.post("/kill/:sessionId", (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId);
    const session = activeSessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    activeSessions.delete(sessionId);
    semaphore.release(sessionId);
    logger.warn(`Killed session ${sessionId}`);

    appendEvent("session.killed", {
      sessionId,
      pipeline: session.pipeline,
      repository: session.repository,
    }).catch((err: unknown) => logger.error("Failed to log session kill event", err));

    res.json({ status: "killed", sessionId });
  });

  // ─── POST /pause ─────────────────────────────────────────────
  app.post("/pause", (_req: Request, res: Response) => {
    paused = true;
    logger.warn("Dispatch service PAUSED");
    appendEvent("service.paused").catch((err: unknown) => logger.error("Failed to log pause event", err));
    res.json({ status: "paused" });
  });

  // ─── POST /resume ────────────────────────────────────────────
  app.post("/resume", (_req: Request, res: Response) => {
    paused = false;
    logger.info("Dispatch service RESUMED");
    appendEvent("service.resumed").catch((err: unknown) => logger.error("Failed to log resume event", err));
    res.json({ status: "resumed" });
  });

  // ─── GET /health ─────────────────────────────────────────────
  app.get("/health", (_req: Request, res: Response) => {
    const health = {
      status: paused ? "degraded" : "healthy",
      paused,
      activeSessions: activeSessions.size,
      queueDepth: semaphore.queueDepth,
      uptime: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || "0.1.0",
    };
    res.status(paused ? 503 : 200).json(health);
  });

  // ─── Error handler ───────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled error", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

// ─── Generic dispatch helper ──────────────────────────────────
async function dispatchPipeline(
  pipeline: PipelineType,
  repository: string,
  res: Response,
  meta: { ticketId?: string; prNumber?: number },
  runBackground: (sessionId: string) => void,
): Promise<void> {
  const repoDir = resolveRepoDir(repository);
  if (!fs.existsSync(repoDir)) {
    logger.error(`Repository not found at ${repoDir} for ${repository}`);
    res.status(404).json({
      error: "Repository not cloned on server",
      repository,
      expected: repoDir,
    });
    return;
  }

  try {
    const sessionId = await semaphore.acquire(repository);

    if (meta.ticketId) {
      dispatchedTickets.add(meta.ticketId);
    }

    const session: ActiveSession = {
      sessionId,
      pipeline,
      repository,
      ticketId: meta.ticketId,
      prNumber: meta.prNumber,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    activeSessions.set(sessionId, session);

    appendEvent("dispatch.started", {
      pipeline,
      sessionId,
      repository,
      ticketId: meta.ticketId,
      prNumber: meta.prNumber,
    }).catch((err: unknown) => logger.error("Failed to log dispatch start event", err));

    res.status(200).json({
      status: "dispatched",
      sessionId,
      pipeline,
    });

    runBackground(sessionId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Queue full")) {
      res.status(429).json({ error: "Queue full" });
    } else {
      res.status(500).json({ error: "Internal error" });
    }
  }
}

// ─── Two-phase watchdog for background pipelines ───────────────
// Phase 1 (init): SESSION_INIT_TIMEOUT_MS — cancelled when SDK responds
// Phase 2 (max duration): SESSION_MAX_DURATION_MS — absolute safety net
async function runPipelineInBackground(
  pipeline: PipelineType,
  sessionId: string,
  runner: () => Promise<PipelineResult>,
): Promise<void> {
  let sessionInitialized = false;

  // Phase 1: init timeout — if the SDK never starts responding
  const initTimeout = setTimeout(() => {
    if (sessionInitialized) return;
    const session = activeSessions.get(sessionId);
    logger.error(`Session ${sessionId} (${pipeline}) did not initialize within ${String(SESSION_INIT_TIMEOUT_MS)}ms — assuming stuck`);
    appendEvent("dispatch.failed", {
      pipeline,
      sessionId,
      ticketId: session?.ticketId,
      metadata: { reason: "init_timeout" },
    }).catch((err: unknown) => logger.error("Failed to log init timeout event", err));
    notifyPipelineResult({
      sessionId,
      pipeline,
      status: "timeout",
      ticketId: session?.ticketId,
      errorType: "INIT_TIMEOUT",
      errorMessage: `Session did not initialize within ${SESSION_INIT_TIMEOUT_MS}ms`,
      costUsd: 0,
      durationMs: SESSION_INIT_TIMEOUT_MS,
      timestamp: new Date().toISOString(),
    });
    releaseTicketId(sessionId);
    void cleanupSession(sessionId);
  }, SESSION_INIT_TIMEOUT_MS);

  // Phase 2: max duration timeout — absolute safety net
  const maxDurationTimeout = setTimeout(() => {
    const session = activeSessions.get(sessionId);
    if (!session) return; // already cleaned up
    logger.error(`Session ${sessionId} (${pipeline}) exceeded max duration ${String(SESSION_MAX_DURATION_MS)}ms — force killing`);
    appendEvent("dispatch.failed", {
      pipeline,
      sessionId,
      ticketId: session.ticketId,
      metadata: { reason: "max_duration" },
    }).catch((err: unknown) => logger.error("Failed to log max duration event", err));
    notifyPipelineResult({
      sessionId,
      pipeline,
      status: "timeout",
      ticketId: session.ticketId,
      errorType: "MAX_DURATION",
      errorMessage: `Session exceeded max duration of ${SESSION_MAX_DURATION_MS}ms`,
      costUsd: 0,
      durationMs: SESSION_MAX_DURATION_MS,
      timestamp: new Date().toISOString(),
    });
    releaseTicketId(sessionId);
    void cleanupSession(sessionId);
  }, SESSION_MAX_DURATION_MS);

  try {
    const result = await runner();
    sessionInitialized = true;
    clearTimeout(initTimeout);
    clearTimeout(maxDurationTimeout);
    await recordResult(sessionId, result);
    if (result.status !== "success") {
      // Allow retry on non-success (failure, timeout, cancelled)
      releaseTicketId(sessionId);
    }
  } catch (error) {
    sessionInitialized = true;
    clearTimeout(initTimeout);
    clearTimeout(maxDurationTimeout);
    const session = activeSessions.get(sessionId);
    logger.error(`Background ${pipeline} pipeline error`, error);
    await appendEvent("dispatch.failed", { pipeline, sessionId, ticketId: session?.ticketId }).catch((err: unknown) => logger.error("Failed to log dispatch failure event", err));
    notifyPipelineResult({
      sessionId,
      pipeline,
      status: "failure",
      ticketId: session?.ticketId,
      errorType: "PIPELINE_ERROR",
      errorMessage: error instanceof Error ? error.message : String(error),
      costUsd: 0,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    });
    releaseTicketId(sessionId);
    await cleanupSession(sessionId);
  }
}

/**
 * Background dispatch with PR branch worktree isolation.
 * Fetches and checks out the existing PR branch, runs the pipeline, then cleans up.
 */
function dispatchWithPrWorktree<T extends { repository: string; prNumber: number }>(
  pipeline: PipelineType,
  sessionId: string,
  request: T,
  runner: (req: T, repoDir: string) => Promise<PipelineResult>,
): void {
  const repoDir = resolveRepoDir(request.repository);

  void runPipelineInBackground(pipeline, sessionId, async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const repo = request.repository.replace("github.com/", "");
    const { stdout } = await execFileAsync(
      "gh",
      ["api", `repos/${repo}/pulls/${request.prNumber}`, "--jq", ".head.ref"],
      { cwd: repoDir, timeout: 30_000 },
    );
    const prBranch = stdout.trim();

    logger.info(`${pipeline}: checking out PR #${request.prNumber} branch: ${prBranch}`);

    const worktreePath = await createWorktreeForBranch(repoDir, sessionId, prBranch);

    // Track worktree in session for cleanup on timeout
    const session = activeSessions.get(sessionId);
    if (session) {
      session.worktreePath = worktreePath;
      session.repoDir = repoDir;
    }

    try {
      const result = await runner(request, worktreePath);

      // Verify the fixer actually pushed commits
      try {
        const { stdout: unpushed } = await execFileAsync(
          "git",
          ["log", "--oneline", `origin/${prBranch}..HEAD`],
          { cwd: worktreePath, timeout: 10_000 },
        );
        if (unpushed.trim()) {
          logger.warn(
            `[${pipeline}] Session ${sessionId} has UNPUSHED commits — ` +
              `they will be lost when the worktree is cleaned up:\n${unpushed.trim()}`,
          );
        }
      } catch {
        // Non-blocking: don't fail the pipeline over a verification check
      }

      return result;
    } finally {
      await removeWorktree(repoDir, sessionId).catch((err: unknown) => {
        logger.warn(`Failed to cleanup worktree for ${sessionId}`, err);
      });
    }
  });
}

/**
 * Background dispatch with worktree isolation for feature/hotfix pipelines.
 * Creates a dedicated branch and worktree, runs the pipeline, then cleans up.
 */
function dispatchWithWorktree<T extends { repository: string; ticketId: string }>(
  pipeline: "feature" | "hotfix",
  sessionId: string,
  request: T,
  runner: (req: T, repoDir: string, branch: string, baseBranch: string) => Promise<PipelineResult>,
): void {
  const repoDir = resolveRepoDir(request.repository);

  void runPipelineInBackground(pipeline, sessionId, async () => {
    const branch = buildBranchName(pipeline, request.ticketId);
    const worktreePath = await createWorktree(repoDir, sessionId, branch);

    // Track worktree in session for cleanup on timeout
    const session = activeSessions.get(sessionId);
    if (session) {
      session.worktreePath = worktreePath;
      session.repoDir = repoDir;
    }

    try {
      const baseBranch = await getDefaultBranch(repoDir);
      return await runner(request, worktreePath, branch, baseBranch);
    } finally {
      await removeWorktree(repoDir, sessionId).catch((err: unknown) => {
        logger.warn(`Failed to cleanup worktree for ${sessionId}`, err);
      });
    }
  });
}

/**
 * Convert RefineResult to PipelineResult for recording.
 * The full RefineResult (with sub-tickets) is serialized into summary
 * so OpenClaw can parse it and create sub-tickets.
 */
function refineResultToPipelineResult(result: RefineResult): PipelineResult {
  return {
    ticketId: result.ticketId,
    sessionId: result.sessionId,
    pipeline: result.pipeline,
    status: result.status,
    summary: JSON.stringify(result),
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    timestamp: result.timestamp,
  };
}

async function recordResult(
  sessionId: string,
  result: PipelineResult,
): Promise<void> {
  await costJournal.record({
    pipeline: result.pipeline,
    sessionId: result.sessionId,
    ticketId: result.ticketId,
    costUsd: result.costUsd,
    modelUsage: {},
    durationMs: result.durationMs,
  });

  await appendEvent("dispatch.completed", {
    pipeline: result.pipeline,
    sessionId: result.sessionId,
    ticketId: result.ticketId,
    prNumber: result.prNumber,
    metadata: {
      status: result.status,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    },
  }).catch((err: unknown) => logger.error("Failed to log dispatch completion event", err));

  notifyPipelineResult(result);

  // Send dedicated sub-ticket callback when refine produces decomposed tickets
  if (result.pipeline === "refine" && result.summary) {
    try {
      const refineData = JSON.parse(result.summary) as RefineResult;
      if (refineData.action === "decompose" && refineData.subTickets?.length) {
        appendEvent("dispatch.subtasks_created", {
          pipeline: "refine",
          ticketId: result.ticketId,
          metadata: { count: refineData.subTickets.length },
        }).catch((err: unknown) => logger.error("Failed to log subtasks event", err));
        notifySubTickets(refineData.ticketId, refineData.subTickets);
      }
    } catch {
      // summary is not valid RefineResult JSON — skip sub-ticket notification
    }
  }

  if (result.pipeline === "review" && result.prNumber && result.repository) {
    postReviewComment(result).catch((err: unknown) => logger.error("Failed to post review comment", err));
  }

  await cleanupSession(sessionId);

  logger.info(
    `Pipeline ${result.pipeline} completed: ${result.status} ($${result.costUsd.toFixed(2)})`,
  );
}

function releaseTicketId(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (session?.ticketId) {
    dispatchedTickets.delete(session.ticketId);
    logger.info(`Released ticket ${session.ticketId} for retry`);
  }
}

async function cleanupSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);

  // Clean up worktree if tracked on the session
  if (session?.worktreePath && session.repoDir) {
    await removeWorktree(session.repoDir, sessionId).catch((err: unknown) => {
      logger.warn(`Failed to cleanup worktree for ${sessionId} during session cleanup`, err);
    });
  }

  activeSessions.delete(sessionId);
  semaphore.release(sessionId);
  clearLoopHistory(sessionId);
}

// Export for testing
export { activeSessions, costJournal, dispatchedTickets, semaphore };
