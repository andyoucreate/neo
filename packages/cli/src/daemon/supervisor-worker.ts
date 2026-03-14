/**
 * Detached worker process for the supervisor daemon.
 *
 * Launched via child_process.fork() from the supervise command.
 * Runs the SupervisorDaemon which starts the heartbeat loop,
 * webhook server, and event queue.
 *
 * Usage: node supervisor-worker.js <name>
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { getSupervisorDir, loadGlobalConfig, SupervisorDaemon } from "@neotx/core";

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    process.stderr.write("Usage: supervisor-worker.js <name>\n");
    process.exit(1);
  }

  // Redirect stdout/stderr to a log file
  const dir = getSupervisorDir(name);
  await mkdir(dir, { recursive: true });
  const logPath = `${dir}/daemon.log`;
  const logStream = createWriteStream(logPath, { flags: "a" });
  process.stdout.write = logStream.write.bind(logStream);
  process.stderr.write = logStream.write.bind(logStream);

  try {
    const config = await loadGlobalConfig();
    const daemon = new SupervisorDaemon({ name, config });
    await daemon.start();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[supervisor-worker] Fatal: ${msg}`);
    process.exit(1);
  }
}

main();
