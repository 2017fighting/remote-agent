import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";

/**
 * Local HTTP stub for the production adapter tests (spec #43: "no real network,
 * no real cluster"). It records every request it received, so a test asserts the
 * method → path/verb/body mapping the port implies, and answers from a handler
 * the test owns.
 */

export interface StubRequest {
  method: string;
  /** Path only (no query), as the server saw it. */
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** Raw request body; JSON replies are parsed by the test when it cares. */
  body: string;
  /** Parsed JSON body; `undefined` when the body was empty or not JSON. */
  json(): unknown;
}

export interface StubReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Full control over the response (used for the k8s watch stream). */
  write?: (res: ServerResponse) => void;
}

export type StubHandler = (request: StubRequest) => StubReply | undefined;

export interface StubServer {
  /** Base URL, e.g. `http://127.0.0.1:43211`. */
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

export async function startStubServer(handler: StubHandler): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub");
      const body = Buffer.concat(chunks).toString("utf8");
      const recorded: StubRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        json: () => {
          try {
            return JSON.parse(body) as unknown;
          } catch {
            return undefined;
          }
        },
      };
      requests.push(recorded);
      const reply = handler(recorded);
      if (reply === undefined) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      res.statusCode = reply.status ?? 200;
      for (const [key, value] of Object.entries(reply.headers ?? {})) res.setHeader(key, value);
      if (reply.write !== undefined) {
        reply.write(res);
        return;
      }
      if (reply.body !== undefined) res.end(reply.body);
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server has no port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** JSON reply helper. */
export function json(status: number, body: unknown): StubReply {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
