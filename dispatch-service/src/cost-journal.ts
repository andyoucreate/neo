import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CostEntry, PipelineType } from "./types.js";
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "./logger.js";

/**
 * Append-only JSONL cost journal.
 * Records cost per pipeline session, organized by month.
 */
export class CostJournal {
  private readonly baseDir: string;
  private dirEnsured = false;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Record a cost entry from a completed SDK query() result.
   */
  async record(params: {
    pipeline: PipelineType;
    sessionId: string;
    ticketId?: string;
    costUsd: number;
    modelUsage: Record<string, ModelUsage>;
    durationMs: number;
  }): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(this.baseDir, { recursive: true });
      this.dirEnsured = true;
    }

    const entry: CostEntry = {
      ts: new Date().toISOString(),
      pipeline: params.pipeline,
      sessionId: params.sessionId,
      ticketId: params.ticketId,
      costUsd: params.costUsd,
      models: Object.fromEntries(
        Object.entries(params.modelUsage).map(([model, usage]) => [
          model,
          usage.costUSD,
        ]),
      ),
      durationMs: params.durationMs,
    };

    const fileName = this.getFileName();
    const filePath = join(this.baseDir, fileName);

    await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    logger.info(`Cost recorded: $${params.costUsd.toFixed(2)} for ${params.pipeline}`, {
      sessionId: params.sessionId,
      pipeline: params.pipeline,
    });
  }

  /**
   * Get total cost for today by reading the current month's journal.
   */
  async getTodayCost(): Promise<number> {
    const { readFile } = await import("node:fs/promises");
    const filePath = join(this.baseDir, this.getFileName());
    const today = new Date().toISOString().slice(0, 10);

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      let total = 0;

      for (const line of lines) {
        const entry = JSON.parse(line) as CostEntry;
        if (entry.ts.startsWith(today)) {
          total += entry.costUsd;
        }
      }

      return total;
    } catch {
      return 0; // file doesn't exist yet
    }
  }

  private getFileName(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}.jsonl`;
  }
}
