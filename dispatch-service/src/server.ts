import type { NextFunction, Request, Response } from "express";
import express from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { notifyPipelineResult } from "./callback.js";
import { Semaphore } from "./concurrency.js";
import { COST_JOURNAL_DIR, REPOS_BASE_DIR } from "./config.js";
import { CostJournal } from "./cost-journal.js";
import { appendEvent } from "./event-journal.js";
import { logger } from "./logger.js";
import { runFeaturePipeline } from "./pipelines/feature.js";
import { runFixerPipeline } from "./pipelines/fixer.js";
import { runHotfixPipeline } from "./pipelines/hotfix.js";
import { runQaPipeline } from "./pipelines/qa.js";
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
  QaRequest,
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
      (sessionId) => runFeaturePipelineBackground(data as FeatureRequest, sessionId),
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
      (sessionId) => runReviewPipelineBackground(data as ReviewRequest, sessionId),
    );
  });

  // ─── POST /dispatch/qa ───────────────────────────────────────
  app.post("/dispatch/qa", async (req: Request, res: Response) => {
    const parsed = qaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;

    await dispatchPipeline(
      "qa",
      data.repository,
      res,
      { prNumber: data.prNumber },
      (sessionId) => runQaPipelineBackground(data as QaRequest, sessionId),
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
      (sessionId) => runHotfixPipelineBackground(data as HotfixRequest, sessionId),
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
      (sessionId) => runFixerPipelineBackground(data as FixerRequest, sessionId),
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
      (sessionId) => runRefinePipelineBackground(data as RefineRequest, sessionId),
    );
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
  } catch (error) {
    logger.error(`Background ${pipeline} pipeline error`, error);
    await appendEvent("dispatch.failed", { pipeline, sessionId }).catch(() => {});
    cleanupSession(sessionId);
  }
}

function runFeaturePipelineBackground(request: FeatureRequest, sessionId: string): void {
  const repoDir = resolveRepoDir(request.repository);
  void runPipelineInBackground("feature", sessionId, () =>
    runFeaturePipeline(request, repoDir),
  );
}

function runReviewPipelineBackground(request: ReviewRequest, sessionId: string): void {
  const repoDir = resolveRepoDir(request.repository);
  void runPipelineInBackground("review", sessionId, () =>
    runReviewPipeline(request, repoDir),
  );
}

function runQaPipelineBackground(request: QaRequest, sessionId: string): void {
  const repoDir = resolveRepoDir(request.repository);
  void runPipelineInBackground("qa", sessionId, () =>
    runQaPipeline(request, repoDir),
  );
}

function runHotfixPipelineBackground(request: HotfixRequest, sessionId: string): void {
  const repoDir = resolveRepoDir(request.repository);
  void runPipelineInBackground("hotfix", sessionId, () =>
    runHotfixPipeline(request, repoDir),
  );
}

function runFixerPipelineBackground(request: FixerRequest, sessionId: string): void {
  const repoDir = resolveRepoDir(request.repository);
  void runPipelineInBackground("fixer", sessionId, () =>
    runFixerPipeline(request, repoDir),
  );
}

function runRefinePipelineBackground(request: RefineRequest, sessionId: string): void {
  const repoDir = resolveRepoDir(request.repository);
  void runRefineInBackground("refine", sessionId, () =>
    runRefinePipeline(request, repoDir),
  );
}

async function runRefineInBackground(
  pipeline: PipelineType,
  sessionId: string,
  runner: () => Promise<RefineResult>,
): Promise<void> {
  try {
    const result = await runner();
    // Convert RefineResult to PipelineResult for recording.
    // The full RefineResult (with sub-tickets) is serialized into summary
    // so OpenClaw can parse it and create sub-tickets.
    const pipelineResult: PipelineResult = {
      ticketId: result.ticketId,
      sessionId: result.sessionId,
      pipeline: result.pipeline,
      status: result.status,
      summary: JSON.stringify(result),
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      timestamp: result.timestamp,
    };
    await recordResult(sessionId, pipelineResult);
  } catch (error) {
    logger.error(`Background ${pipeline} pipeline error`, error);
    await appendEvent("dispatch.failed", { pipeline, sessionId }).catch(() => {});
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

function cleanupSession(sessionId: string): void {
  activeSessions.delete(sessionId);
  semaphore.release(sessionId);
}

// Export for testing
export { activeSessions, costJournal, dispatchedTickets, semaphore };
