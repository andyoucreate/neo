import { timingSafeEqual } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WebhookIncomingEvent } from "./schemas.js";

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

interface WebhookServerOptions {
  port: number;
  secret?: string | undefined;
  eventsPath: string;
  onEvent: (event: WebhookIncomingEvent) => void;
  getHealth: () => Record<string, unknown>;
}

/**
 * Minimal HTTP server for receiving incoming webhooks.
 *
 * Routes:
 *   POST /webhook — receive any JSON payload, persist to disk, push to queue
 *   GET  /health  — liveness check with daemon status
 *
 * Uses raw http.createServer — zero external dependencies.
 */
export class WebhookServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly secret: string | undefined;
  private readonly eventsPath: string;
  private readonly onEvent: (event: WebhookIncomingEvent) => void;
  private readonly getHealth: () => Record<string, unknown>;

  constructor(options: WebhookServerOptions) {
    this.port = options.port;
    this.secret = options.secret;
    this.eventsPath = options.eventsPath;
    this.onEvent = options.onEvent;
    this.getHealth = options.getHealth;
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.sendJson(res, 500, { error: "Internal server error", detail: String(err) });
        });
      });

      this.server.on("error", reject);

      this.server.listen(this.port, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";

    if (req.method === "GET" && url === "/health") {
      this.sendJson(res, 200, this.getHealth());
      return;
    }

    if (req.method === "POST" && url === "/webhook") {
      await this.handleWebhook(req, res);
      return;
    }

    this.sendJson(res, 404, { error: "Not found" });
  }

  private async handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Validate secret if configured
    if (this.secret) {
      const provided = req.headers["x-neo-secret"] as string | undefined;
      if (!provided) {
        this.sendJson(res, 401, { error: "Missing X-Neo-Secret header" });
        return;
      }

      const expected = Buffer.from(this.secret, "utf-8");
      const actual = Buffer.from(provided, "utf-8");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        this.sendJson(res, 403, { error: "Invalid secret" });
        return;
      }
    }

    // Read body with size limit
    const body = await this.readBody(req);
    if (body === null) {
      this.sendJson(res, 413, { error: "Payload too large (max 1MB)" });
      return;
    }

    // Parse JSON
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      this.sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    const event: WebhookIncomingEvent = {
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      source: typeof parsed.source === "string" ? parsed.source : undefined,
      event: typeof parsed.event === "string" ? parsed.event : undefined,
      payload: (parsed.payload as Record<string, unknown> | undefined) ?? parsed,
      receivedAt: new Date().toISOString(),
    };

    // Disk-first: persist before pushing to memory
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf-8");

    // Push to in-memory queue
    this.onEvent(event);

    this.sendJson(res, 200, { ok: true, id: event.id });
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_SIZE) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });

      req.on("error", () => resolve(null));
    });
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
}
