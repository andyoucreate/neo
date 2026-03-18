import { readFile } from "node:fs/promises";
import path from "node:path";
import { type SupervisorStatus, supervisorStatusSchema } from "./schemas.js";

const STATE_FILE = "state.json";

/**
 * Reads supervisor status from the daemon state file.
 * Returns null if the supervisor is not running or state file doesn't exist.
 */
export class StatusReader {
  readonly dataDir: string;
  private readonly statePath: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, STATE_FILE);
  }

  /**
   * Read and parse supervisor status from disk.
   * Returns null if the state file doesn't exist (supervisor not running).
   */
  async getStatus(): Promise<SupervisorStatus | null> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf-8");
    } catch {
      // File not found — supervisor not running
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed JSON — treat as not running
      return null;
    }

    const result = supervisorStatusSchema.safeParse(parsed);
    if (!result.success) {
      // Schema validation failed — state file is incompatible
      return null;
    }

    return result.data;
  }
}
