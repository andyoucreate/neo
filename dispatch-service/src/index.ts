import type { Server } from "node:http";
import { createServer, startWatchdog, stopWatchdog, activeSessions } from "./server.js";
import { SERVER_PORT, SERVER_HOST } from "./config.js";
import { appendEvent, replayJournal } from "./event-journal.js";
import { logger } from "./logger.js";
import { notifyServiceEvent } from "./slack.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;
let server: Server | null = null;
let shuttingDown = false;

async function start(): Promise<void> {
  const app = createServer();

  // Replay journal to detect unfinished sessions from previous run
  const pending = await replayJournal();
  if (pending.length > 0) {
    logger.warn(
      `Found ${pending.length} unfinished session(s) from previous run — ` +
        pending.map((e) => e.sessionId ?? e.ticketId).join(", "),
    );
  }

  // Start HTTP server
  server = app.listen(SERVER_PORT, SERVER_HOST, () => {
    logger.info(
      `Voltaire Dispatch Service v${process.env.npm_package_version ?? "0.1.0"} ` +
        `running on ${SERVER_HOST}:${SERVER_PORT}`,
    );
  });

  // Start session timeout watchdog
  await startWatchdog();

  // Record startup event
  await appendEvent("service.started");
  void notifyServiceEvent("started", {
    version: process.env.npm_package_version ?? "0.1.0",
    host: `${SERVER_HOST}:${String(SERVER_PORT)}`,
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      logger.info("HTTP server closed");
    });
  }

  // Stop watchdog
  stopWatchdog();

  // Wait for active sessions to complete (up to timeout)
  if (activeSessions.size > 0) {
    logger.info(
      `Waiting for ${activeSessions.size} active session(s) to complete (max ${String(SHUTDOWN_TIMEOUT_MS / 1000)}s)...`,
    );

    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (activeSessions.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (activeSessions.size > 0) {
      logger.warn(
        `Forcing shutdown with ${activeSessions.size} session(s) still active`,
      );
    }
  }

  // Record shutdown event
  await appendEvent("service.stopped").catch(() => {});
  void notifyServiceEvent("stopped", { signal });

  logger.info("Shutdown complete");
  process.exit(0);
}

// Signal handlers
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Error handlers
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception — shutting down", error);
  void shutdown("uncaughtException");
});

// Boot
start().catch((error: unknown) => {
  logger.error("Failed to start dispatch service", error);
  process.exit(1);
});
