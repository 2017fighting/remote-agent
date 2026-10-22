import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Trigger } from "./scheduler.js";

/** Event types that wake a reconcile pass (ADR-0014 / spec #33 §8). */
const WAKE_EVENTS = new Set([
  "issues",
  "issue_comment",
  "sub_issues",
  "issue_dependencies",
  "installation_repositories",
]);

export interface WebhookServerDeps {
  webhookSecret: string;
  /** The only thing the webhook endpoint does with an accepted delivery. */
  wake: (trigger: Trigger) => void;
}

export interface WebhookServer {
  host: string;
  port: number;
  /** Resolves once the listener is bound and host/port are filled in. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The App's single HTTP surface: `/webhook` only (ADR-0002 / spec #33 §8).
 * HMAC-SHA256 verification → event-type filter → one scheduler wake signal.
 * It does not parse business content; the body is read only to verify the
 * signature. Synchronous construction: listening starts immediately; host/port
 * are filled in on the returned object once the listener is bound.
 */
export function createWebhookServer(deps: WebhookServerDeps): WebhookServer {
  const server: Server = createServer((req, res) => {
    void handle(req, res, deps).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  function handle(req: IncomingMessage, res: ServerResponse, d: WebhookServerDeps): Promise<void> {
    return new Promise((resolve) => {
      const finish = (status: number): void => {
        res.writeHead(status);
        res.end();
        resolve();
      };

      if (req.method !== "POST" || req.url !== "/webhook") {
        finish(404);
        return;
      }

      const event = req.headers["x-github-event"];
      const signature = req.headers["x-hub-signature-256"];
      if (event === undefined || Array.isArray(event) || event === "") {
        finish(400);
        return;
      }
      if (typeof signature !== "string" || !signature.startsWith("sha256=")) {
        finish(401);
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (!verifySignature(body, signature, deps.webhookSecret)) {
          finish(401);
          return;
        }
        // Scheduler signal only — no business parsing.
        if (WAKE_EVENTS.has(event)) deps.wake("webhook");
        finish(200);
      });
      req.on("error", () => finish(400));
    });
  }

  let listeningResolve: (() => void) | null = null;
  const listeningPromise = new Promise<void>((resolve) => {
    listeningResolve = resolve;
  });
  const handleObj: WebhookServer = {
    host: "127.0.0.1",
    port: 0,
    ready: () => listeningPromise,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("unexpected server address");
    }
    handleObj.port = address.port;
    listeningResolve?.();
  });
  return handleObj;
}

function verifySignature(body: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature.slice("sha256=".length), "hex");
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
