import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import {
  ScriptCursor,
  lastUserText,
  offeredToolNames,
  renderStream,
  type ModelScript,
  type RecordedModelRequest,
} from "./script.js";

/**
 * The stub model service (spec #33 Testing Decisions 3), served as an
 * OpenAI-compatible `/v1/chat/completions` endpoint.
 *
 * `OMNIROUTE_BASE_URL` points the runner here (spec #33 §9), so the runner's
 * provider wiring — model ids, `high` thinking, the openai-completions API —
 * runs unmodified. Only the answers are scripted.
 *
 * Two routes, because that is what a real OmniRoute exposes and what the runner
 * may read: `/v1/chat/completions` (streaming) and `/v1/models`.
 *
 *   node e2e/stub-model/server.ts --script <file.json> [--port 8080] [--record <file.json>]
 */

export interface StubModelOptions {
  scriptPath: string;
  port?: number;
  host?: string;
  /** Appended one JSON line per request, for the scenario's assertions. */
  recordPath?: string;
}

export interface StubModel {
  server: Server;
  port: number;
  /** Every request served, in order. */
  requests: RecordedModelRequest[];
  close(): Promise<void>;
}

export async function startStubModel(options: StubModelOptions): Promise<StubModel> {
  const script = JSON.parse(await readFile(options.scriptPath, "utf8")) as ModelScript;
  if (!Array.isArray(script.steps)) throw new Error("script.steps must be an array");
  const cursor = new ScriptCursor(script.steps);
  const requests: RecordedModelRequest[] = [];

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";

    if (req.method === "GET" && path === "/v1/models") {
      // The model ids the runner's provider declares (docs/deployment.md §9).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "default", object: "model", owned_by: "stub" },
            { id: "review", object: "model", owned_by: "stub" },
          ],
        }),
      );
      return;
    }

    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}` } }));
      return;
    }

    const body = await readBody(req);
    const parsed = safeJsonParse(body) as Record<string, unknown> | undefined;
    if (parsed === undefined) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "request body is not JSON" } }));
      return;
    }
    const model = typeof parsed["model"] === "string" ? parsed["model"] : "default";
    const { step, index } = cursor.next(model);
    const record: RecordedModelRequest = {
      at: new Date().toISOString(),
      model,
      offeredTools: offeredToolNames(parsed),
      lastUserMessage: lastUserText(parsed).slice(0, 2000),
      step: index,
    };
    requests.push(record);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(renderStream(step, model, `stub-${requests.length}`));
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const port = address !== null && typeof address !== "string" ? address.port : 0;

  return {
    server,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeJsonParse(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

// --- CLI entry -------------------------------------------------------------

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const scriptPath = flag("--script");
  if (scriptPath === undefined) {
    console.error("usage: server.ts --script <file> [--port N]");
    process.exit(2);
  }
  const port = flag("--port");
  const stub = await startStubModel({
    scriptPath,
    ...(port === undefined ? {} : { port: Number.parseInt(port, 10) }),
  });
  console.log(`stub-model listening on 0.0.0.0:${stub.port}`);
}
