import type { NextFunction, Request, Response } from "express";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { pollCiChecks } from "./ci-check.js";
import { notifyPipelineResult } from "./callback.js";
import { Semaphore } from "./concurrency.js";
import { COST_JOURNAL_DIR, REPOS_BASE_DIR } from "./config.js";
import { CostJournal } from "./cost-journal.js";
import { appendEvent } from "./event-journal.js";
import { logger } from "./logger.js";
import { buildBranchName, createWorktree, createWorktreeForBranch, getDefaultBranch, removeWorktree } from "./worktree.js";
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

// ─── Zod schemas for request validation ────────────────────────
const featureSchema = z.object({
  ticketId: z.string().min(1),
  title: z.string().min(1),
  type: z.enum(["feature", "bug", "refactor", "chore"]),
  priority: z.enum(["critical", "high", "medium", "low"]),
  size: z.enum(["xs", "s", "m", "l", "xl"]).optional().default("m"),
  repository: z.string().min(1),
  criteria: z.string().optional().default(""),
  description: z.string().optional().default(""),
  skills: z.array(z.string()).optional(),
});

const reviewSchema = z.object({
  prNumber: z.number().int().positive(),
  repository: z.string().min(1),
  skills: z.array(z.string()).optional(),
});

const hotfixSchema = z.object({
  ticketId: z.string().min(1),
  title: z.string().min(1),
  priority: z.enum(["critical", "high", "medium", "low"]),
  repository: z.string().min(1),
  description: z.string().optional().default(""),
  skills: z.array(z.string()).optional(),
});

const fixerIssueSchema = z.object({
  source: z.string(),
  severity: z.enum(["CRITICAL", "HIGH", "WARNING"]),
  file: z.string(),
  line: z.number(),
  description: z.string(),
  suggestion: z.string().optional(),
});

const fixerSchema = z.object({
  prNumber: z.number().int().positive(),
  repository: z.string().min(1),
  issues: z.array(fixerIssueSchema).min(1),
});

const refineSchema = z.object({
  ticketId: z.string().min(1),
  title: z.string().min(1),
  type: z.enum(["feature", "bug", "refactor", "chore"]),
  priority: z.enum(["critical", "high", "medium", "low"]),
  size: z.enum(["xs", "s", "m", "l", "xl"]).optional(),
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

  app.use(express.json({ limit: "100kb" }));

  // ─── Middleware: request ID ───────────────────────────────────
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Request-Id", crypto.randomUUID());
    next();
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
      }).catch(() => {});
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

    await dispatchPipeline(
      "review",
      data.repository,
      res,
      { prNumber: data.prNumber },
      (sessionId) => dispatchBackground("review", sessionId, data as ReviewRequest, runReviewPipeline),
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

    await dispatchPipeline(
      "fixer",
      data.repository,
      res,
      { prNumber: data.prNumber },
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
      size: data.size ?? "m",
      criteria: data.criteria ?? "",
      description: data.description ?? "",
    });
    if (sanitized === "quarantined") {
      appendEvent("dispatch.quarantined", {
        pipeline: "refine",
        ticketId: data.ticketId,
        repository: data.repository,
      }).catch(() => {});
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
    const status: ServiceStatus = {
      paused,
      activeSessions: Array.from(activeSessions.values()),
      queueDepth: semaphore.queueDepth,
      totalCostToday: todayCost,
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
    }).catch(() => {});

    res.json({ status: "killed", sessionId });
  });

  // ─── POST /pause ─────────────────────────────────────────────
  app.post("/pause", (_req: Request, res: Response) => {
    paused = true;
    logger.warn("Dispatch service PAUSED");
    appendEvent("service.paused").catch(() => {});
    res.json({ status: "paused" });
  });

  // ─── POST /resume ────────────────────────────────────────────
  app.post("/resume", (_req: Request, res: Response) => {
    paused = false;
    logger.info("Dispatch service RESUMED");
    appendEvent("service.resumed").catch(() => {});
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
    }).catch(() => {});

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

// ─── Background pipeline runners ───────────────────────────────
async function runPipelineInBackground(
  pipeline: PipelineType,
  sessionId: string,
  runner: () => Promise<PipelineResult>,
): Promise<void> {
  try {
    const result = await runner();
    await recordResult(sessionId, result);
    if (result.status !== "success") {
      // Allow retry on non-success (failure, timeout, cancelled)
      releaseTicketId(sessionId);
    }
  } catch (error) {
    logger.error(`Background ${pipeline} pipeline error`, error);
    await appendEvent("dispatch.failed", { pipeline, sessionId }).catch(() => {});
    releaseTicketId(sessionId);
    cleanupSession(sessionId);
  }
}

/**
 * Generic background dispatch: resolves repo dir and runs the pipeline.
 */
function dispatchBackground<T extends { repository: string }>(
  pipeline: PipelineType,
  sessionId: string,
  request: T,
  runner: (req: T, repoDir: string) => Promise<PipelineResult>,
): void {
  const repoDir = resolveRepoDir(request.repository);
  void runPipelineInBackground(pipeline, sessionId, () => runner(request, repoDir));
}

/**
 * Background dispatch with PR branch worktree isolation for fixer pipeline.
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

    const { stdout } = await execFileAsync(
      "gh",
      ["api", `repos/${request.repository}/pulls/${request.prNumber}`, "--jq", ".head.ref"],
      { cwd: repoDir, timeout: 30_000 },
    );
    const prBranch = stdout.trim();

    logger.info(`Fixer: checking out PR #${request.prNumber} branch: ${prBranch}`);

    const worktreePath = await createWorktreeForBranch(repoDir, sessionId, prBranch);

    try {
      return await runner(request, worktreePath);
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
  }).catch(() => {});

  notifyPipelineResult(result);

  cleanupSession(sessionId);

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

function cleanupSession(sessionId: string): void {
  activeSessions.delete(sessionId);
  semaphore.release(sessionId);
}

// Export for testing
export { activeSessions, costJournal, dispatchedTickets, semaphore };
