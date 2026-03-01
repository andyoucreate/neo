import express from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Semaphore } from "./concurrency.js";
import { CostJournal } from "./cost-journal.js";
import { sanitize } from "./sanitize.js";
import { runFeaturePipeline } from "./pipelines/feature.js";
import { runReviewPipeline } from "./pipelines/review.js";
import { runQaPipeline } from "./pipelines/qa.js";
import { runHotfixPipeline } from "./pipelines/hotfix.js";
import { runFixerPipeline } from "./pipelines/fixer.js";
import { COST_JOURNAL_DIR } from "./config.js";
import { logger } from "./logger.js";
import type {
  FeatureRequest,
  ReviewRequest,
  QaRequest,
  HotfixRequest,
  FixerRequest,
  ActiveSession,
  ServiceStatus,
  PipelineResult,
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

const qaSchema = z.object({
  prNumber: z.number().int().positive(),
  repository: z.string().min(1),
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
  // Convention: repos are cloned to /home/voltaire/repos/{org}/{name}
  const parts = repository.replace("github.com/", "").split("/");
  return `/home/voltaire/repos/${parts.join("/")}`;
}

/**
 * Create and configure the Express HTTP server.
 */
export function createServer(): express.Express {
  const app = express();

  app.use(express.json({ limit: "100kb" }));

  // ─── Middleware: pause check ────────────────────────────────
  app.use("/dispatch", (_req: Request, res: Response, next: NextFunction) => {
    if (paused) {
      res.status(503).json({ error: "Dispatch service paused" });
      return;
    }
    next();
  });

  // ─── POST /dispatch/feature ────────────────────────────────
  app.post("/dispatch/feature", async (req: Request, res: Response) => {
    const parsed = featureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    // Idempotency check
    if (dispatchedTickets.has(data.ticketId)) {
      res.status(409).json({ error: "Ticket already dispatched", ticketId: data.ticketId });
      return;
    }

    // Input sanitization
    const sanitized = sanitize(data);
    if (sanitized === "quarantined") {
      res.status(422).json({ error: "Content quarantined — suspicious input detected" });
      return;
    }

    try {
      const sessionId = await semaphore.acquire(data.repository);
      dispatchedTickets.add(data.ticketId);

      const session: ActiveSession = {
        sessionId,
        pipeline: "feature",
        repository: data.repository,
        ticketId: data.ticketId,
        startedAt: new Date().toISOString(),
        status: "running",
      };
      activeSessions.set(sessionId, session);

      res.status(200).json({
        status: "dispatched",
        sessionId,
        pipeline: "feature",
      });

      // Run pipeline in background
      runFeaturePipelineBackground(data as FeatureRequest, sessionId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Queue full")) {
        res.status(429).json({ error: "Queue full" });
      } else {
        res.status(500).json({ error: "Internal error" });
      }
    }
  });

  // ─── POST /dispatch/review ─────────────────────────────────
  app.post("/dispatch/review", async (req: Request, res: Response) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    try {
      const sessionId = await semaphore.acquire(data.repository);

      const session: ActiveSession = {
        sessionId,
        pipeline: "review",
        repository: data.repository,
        prNumber: data.prNumber,
        startedAt: new Date().toISOString(),
        status: "running",
      };
      activeSessions.set(sessionId, session);

      res.status(200).json({
        status: "dispatched",
        sessionId,
        pipeline: "review",
      });

      runReviewPipelineBackground(data as ReviewRequest, sessionId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Queue full")) {
        res.status(429).json({ error: "Queue full" });
      } else {
        res.status(500).json({ error: "Internal error" });
      }
    }
  });

  // ─── POST /dispatch/qa ─────────────────────────────────────
  app.post("/dispatch/qa", async (req: Request, res: Response) => {
    const parsed = qaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    try {
      const sessionId = await semaphore.acquire(data.repository);

      const session: ActiveSession = {
        sessionId,
        pipeline: "qa",
        repository: data.repository,
        prNumber: data.prNumber,
        startedAt: new Date().toISOString(),
        status: "running",
      };
      activeSessions.set(sessionId, session);

      res.status(200).json({
        status: "dispatched",
        sessionId,
        pipeline: "qa",
      });

      runQaPipelineBackground(data as QaRequest, sessionId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Queue full")) {
        res.status(429).json({ error: "Queue full" });
      } else {
        res.status(500).json({ error: "Internal error" });
      }
    }
  });

  // ─── POST /dispatch/hotfix ─────────────────────────────────
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

    try {
      const sessionId = await semaphore.acquire(data.repository);
      dispatchedTickets.add(data.ticketId);

      const session: ActiveSession = {
        sessionId,
        pipeline: "hotfix",
        repository: data.repository,
        ticketId: data.ticketId,
        startedAt: new Date().toISOString(),
        status: "running",
      };
      activeSessions.set(sessionId, session);

      res.status(200).json({
        status: "dispatched",
        sessionId,
        pipeline: "hotfix",
      });

      runHotfixPipelineBackground(data as HotfixRequest, sessionId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Queue full")) {
        res.status(429).json({ error: "Queue full" });
      } else {
        res.status(500).json({ error: "Internal error" });
      }
    }
  });

  // ─── POST /dispatch/fixer ──────────────────────────────────
  app.post("/dispatch/fixer", async (req: Request, res: Response) => {
    const parsed = fixerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    try {
      const sessionId = await semaphore.acquire(data.repository);

      const session: ActiveSession = {
        sessionId,
        pipeline: "fixer",
        repository: data.repository,
        prNumber: data.prNumber,
        startedAt: new Date().toISOString(),
        status: "running",
      };
      activeSessions.set(sessionId, session);

      res.status(200).json({
        status: "dispatched",
        sessionId,
        pipeline: "fixer",
      });

      runFixerPipelineBackground(data as FixerRequest, sessionId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Queue full")) {
        res.status(429).json({ error: "Queue full" });
      } else {
        res.status(500).json({ error: "Internal error" });
      }
    }
  });

  // ─── GET /status ───────────────────────────────────────────
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

  // ─── POST /kill/:sessionId ─────────────────────────────────
  app.post("/kill/:sessionId", (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId);
    const session = activeSessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    semaphore.release(sessionId);
    activeSessions.delete(sessionId);
    logger.warn(`Killed session ${sessionId}`);

    res.json({ status: "killed", sessionId });
  });

  // ─── POST /pause ───────────────────────────────────────────
  app.post("/pause", (_req: Request, res: Response) => {
    paused = true;
    logger.warn("Dispatch service PAUSED");
    res.json({ status: "paused" });
  });

  // ─── POST /resume ──────────────────────────────────────────
  app.post("/resume", (_req: Request, res: Response) => {
    paused = false;
    logger.info("Dispatch service RESUMED");
    res.json({ status: "resumed" });
  });

  // ─── Error handler ─────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled error", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

// ─── Background pipeline runners ───────────────────────────────
async function runFeaturePipelineBackground(
  request: FeatureRequest,
  sessionId: string,
): Promise<void> {
  const repoDir = resolveRepoDir(request.repository);
  try {
    const result = await runFeaturePipeline(request, repoDir);
    await recordResult(sessionId, result);
  } catch (error) {
    logger.error(`Background feature pipeline error`, error);
    cleanupSession(sessionId);
  }
}

async function runReviewPipelineBackground(
  request: ReviewRequest,
  sessionId: string,
): Promise<void> {
  const repoDir = resolveRepoDir(request.repository);
  try {
    const result = await runReviewPipeline(request, repoDir);
    await recordResult(sessionId, result);
  } catch (error) {
    logger.error(`Background review pipeline error`, error);
    cleanupSession(sessionId);
  }
}

async function runQaPipelineBackground(
  request: QaRequest,
  sessionId: string,
): Promise<void> {
  const repoDir = resolveRepoDir(request.repository);
  try {
    const result = await runQaPipeline(request, repoDir);
    await recordResult(sessionId, result);
  } catch (error) {
    logger.error(`Background QA pipeline error`, error);
    cleanupSession(sessionId);
  }
}

async function runHotfixPipelineBackground(
  request: HotfixRequest,
  sessionId: string,
): Promise<void> {
  const repoDir = resolveRepoDir(request.repository);
  try {
    const result = await runHotfixPipeline(request, repoDir);
    await recordResult(sessionId, result);
  } catch (error) {
    logger.error(`Background hotfix pipeline error`, error);
    cleanupSession(sessionId);
  }
}

async function runFixerPipelineBackground(
  request: FixerRequest,
  sessionId: string,
): Promise<void> {
  const repoDir = resolveRepoDir(request.repository);
  try {
    const result = await runFixerPipeline(request, repoDir);
    await recordResult(sessionId, result);
  } catch (error) {
    logger.error(`Background fixer pipeline error`, error);
    cleanupSession(sessionId);
  }
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

  cleanupSession(sessionId);

  logger.info(
    `Pipeline ${result.pipeline} completed: ${result.status} ($${result.costUsd.toFixed(2)})`,
  );
}

function cleanupSession(sessionId: string): void {
  activeSessions.delete(sessionId);
  semaphore.release(sessionId);
}

// Export for testing
export { semaphore, costJournal, activeSessions, dispatchedTickets };
