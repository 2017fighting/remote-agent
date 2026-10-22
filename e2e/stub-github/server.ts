import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { parseScenario, StubWorld, type RecordedGitOperation } from "./state.js";
import { routeRest, pullsByBranchResponse, type RestContext } from "./rest.js";
import { serveGitRequest } from "./git-backend.js";

/**
 * The stub GitHub service (spec #33 Testing Decisions 3).
 *
 * Two protocols on one port, exactly as a real git host serves them:
 *
 * - REST under `/` for the endpoints `GitHubPort` uses (issue read, labels,
 *   sub-issue tree, blockers, comments, PR-by-branch + PR create, issue
 *   close/create, installation-token mint);
 * - real git smart HTTP under `/<owner>/<name>.git/...`, served by
 *   `git http-backend` against a real bare repository.
 *
 * State comes from a JSON scenario fixture and every request is recorded, so a
 * scenario can assert both the final world and the operations that produced it.
 * The App reaches this server only through `GITHUB_API_BASE_URL` /
 * `GIT_BASE_URL`; no product code branches on it being a stub.
 *
 * Usage:
 *   node e2e/stub-github/server.ts --scenario <file.json> --project-root <dir> \
 *        --token <token> [--port 8080] [--record <file.json>]
 */

export interface StubGitHubOptions {
  scenarioPath: string;
  /** Directory containing `<owner>/<name>.git` (GIT_PROJECT_ROOT). */
  projectRoot: string;
  /** Token the stub accepts for git Basic auth and returns from the mint endpoint. */
  token: string;
  port?: number;
  host?: string;
  tokenTtlSeconds?: number;
  /** The installation id the stub reports for its one repo. */
  installationId?: number;
}

export interface StubGitHub {
  server: Server;
  port: number;
  world: StubWorld;
  /**
   * Every git operation the stub served, in order. This is the evidence for the
   * scenario's "the git work was real" assertion (spec #33 #41 AC 6): the
   * operations came from `git http-backend` processes, with their exit codes.
   */
  gitOperations: RecordedGitOperation[];
  close(): Promise<void>;
}

export async function startStubGitHub(options: StubGitHubOptions): Promise<StubGitHub> {
  const scenario = parseScenario(JSON.parse(await readFile(options.scenarioPath, "utf8")));
  const world = new StubWorld(scenario.repo, scenario);
  const context: RestContext = {
    world,
    repo: scenario.repo,
    installationToken: options.token,
    installationId: options.installationId ?? 1,
    tokenTtlSeconds: options.tokenTtlSeconds ?? 3600,
    now: () => new Date(),
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    });
  });

  const gitOperations: RecordedGitOperation[] = [];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const auth = parseBasicAuth(req.headers.authorization);
    const body = await readBody(req);

    // Git first: a smart-HTTP path is unambiguous (`.../info/refs?service=` or
    // `.../git-upload-pack`), and it must not fall through to REST.
    const git = await serveGitRequest(
      {
        projectRoot: options.projectRoot,
        repo: scenario.repo,
        token: options.token,
        onOperation: (operation) => {
          gitOperations.push({ ...operation, at: new Date().toISOString() });
        },
      },
      { method: req.method ?? "GET", path: url, headers: req.headers, body, ...(auth === undefined ? {} : { auth }) },
    );
    if (git !== null) {
      res.writeHead(git.status, git.headers);
      res.end(git.body);
      return;
    }

    const { segments, query } = parseUrl(url);
    // `GET /repos/:o/:n/pulls?head=owner:branch` — the by-branch lookup.
    if (
      (req.method ?? "GET") === "GET" &&
      segments[0] === "repos" &&
      segments[3] === "pulls" &&
      segments.length === 4 &&
      query.get("head") !== null
    ) {
      const head = query.get("head") ?? "";
      const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
      const response = pullsByBranchResponse(world, branch);
      sendJson(res, response.status, response.body);
      return;
    }

    const parsedBody = body.length > 0 ? safeJsonParse(body) : undefined;
    const response = await routeRest(context, req.method ?? "GET", segments, parsedBody);
    sendJson(res, response.status, response.body);
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const port = address !== null && typeof address !== "string" ? address.port : 0;

  return {
    server,
    port,
    world,
    gitOperations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseUrl(url: string): { segments: string[]; query: URLSearchParams } {
  const [pathPart, queryPart = ""] = url.split("?", 2) as [string, string?];
  const segments = pathPart
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => decodeURIComponent(segment));
  return { segments, query: new URLSearchParams(queryPart) };
}

export function parseBasicAuth(header: string | undefined): { username: string; password: string } | undefined {
  if (header === undefined || !header.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon === -1) return undefined;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
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
  const scenarioPath = flag("--scenario");
  const projectRoot = flag("--project-root");
  const token = flag("--token");
  if (scenarioPath === undefined || projectRoot === undefined || token === undefined) {
    console.error("usage: server.ts --scenario <file> --project-root <dir> --token <token> [--port N]");
    process.exit(2);
  }
  const port = flag("--port");
  const stub = await startStubGitHub({
    scenarioPath,
    projectRoot,
    token,
    ...(port === undefined ? {} : { port: Number.parseInt(port, 10) }),
  });
  console.log(`stub-github listening on 0.0.0.0:${stub.port} repo=${stub.world.repo}`);
}
