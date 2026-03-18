import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Webhook payload structure matching WebhookDispatcher output.
 */
export interface WebhookPayload {
  id: string;
  version: 1;
  event: string;
  payload: Record<string, unknown>;
  source: "neo";
  deliveredAt: string;
}

/**
 * Captured webhook with metadata for test assertions.
 */
export interface CapturedWebhook {
  receivedAt: Date;
  payload: WebhookPayload;
  headers: Record<string, string | undefined>;
}

/**
 * Mock HTTP server that captures webhook POST requests for E2E testing.
 *
 * Usage:
 * ```ts
 * const server = new MockWebhookServer();
 * await server.start();
 * // configure webhook to post to `http://localhost:${server.getPort()}`
 * // ... trigger events ...
 * const webhooks = server.getReceivedWebhooks();
 * await server.stop();
 * ```
 */
export class MockWebhookServer {
  private server: Server | null = null;
  private port = 0;
  private receivedWebhooks: CapturedWebhook[] = [];

  /**
   * Start the HTTP server on a random available port.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", reject);

      // Listen on port 0 to get a random available port
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server?.address();
        if (address && typeof address === "object") {
          this.port = address.port;
        }
        resolve();
      });
    });
  }

  /**
   * Get the port number the server is listening on.
   * Returns 0 if the server is not started.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get all captured webhook events.
   */
  getReceivedWebhooks(): CapturedWebhook[] {
    return [...this.receivedWebhooks];
  }

  /**
   * Clear all captured webhook events.
   */
  reset(): void {
    this.receivedWebhooks = [];
  }

  /**
   * Stop the server and clean up resources.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.server = null;
        this.port = 0;
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only accept POST requests
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const payload = JSON.parse(body) as WebhookPayload;

        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key] = Array.isArray(value) ? value[0] : value;
        }

        this.receivedWebhooks.push({
          receivedAt: new Date(),
          payload,
          headers,
        });

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
      } catch {
        res.statusCode = 400;
        res.end("Invalid JSON");
      }
    });

    req.on("error", () => {
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
  }
}
