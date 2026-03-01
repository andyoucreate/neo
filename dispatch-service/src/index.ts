import { createServer } from "./server.js";
import { SERVER_PORT, SERVER_HOST } from "./config.js";
import { logger } from "./logger.js";

const app = createServer();

app.listen(SERVER_PORT, SERVER_HOST, () => {
  logger.info(
    `Voltaire Dispatch Service running on ${SERVER_HOST}:${SERVER_PORT}`,
  );
});

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
});
