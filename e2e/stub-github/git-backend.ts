import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Real git over HTTP (spec #33 Testing Decisions 3): clone, `ls-remote` and push
 * all go through `git http-backend`, the same CGI program a real git host runs.
 *
 * Nothing about git is mocked. Seed's `git ls-remote` + clone, the runner's
 * `merge-base`, the commit list and the final push are all executed by git
 * against a real bare repository on disk, so a scenario that reaches its final
 * assertions has proven the Job image's git code paths — not a stand-in for
 * them. The stub only supplies the transport and the credential check.
 */

export interface GitBackendOptions {
  /** Directory holding `<repo-name>.git` bare repositories (`GIT_PROJECT_ROOT`). */
  projectRoot: string;
  /** `owner/name` of the one served repository. */
  repo: string;
  /** Token the stub accepts as the Basic-auth password (`x-access-token` as username). */
  token: string;
  /** Called with the outcome of every served operation, for the git-operation assertions. */
  onOperation?(operation: {
    service: "upload-pack" | "receive-pack";
    path: string;
    auth?: { username: string; password: string };
    exitCode: number;
  }): void;
}

export interface GitRequest {
  method: string;
  /** Request path, e.g. `/owner/name.git/info/refs?service=git-upload-pack`. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  auth?: { username: string; password: string };
}

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** The bare repository path for `owner/name`: `<projectRoot>/<owner>/<name>.git`. */
export function bareRepoPath(projectRoot: string, repo: string): string {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined) throw new Error(`repo ${repo} is not owner/name`);
  return join(projectRoot, owner, `${name}.git`);
}

/**
 * Serve one git smart-HTTP request. Returns `null` when the path is not a git
 * endpoint, so the caller can fall through to the REST routes.
 *
 * The CGI contract is what `git http-backend` expects: `GIT_PROJECT_ROOT` +
 * `PATH_INFO`, `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`, and the request
 * body on stdin. Its stdout is a CGI response (headers, blank line, body) which
 * this function parses back into an HTTP response.
 */
export async function serveGitRequest(options: GitBackendOptions, request: GitRequest): Promise<GitResponse | null> {
  if (!existsSync(bareRepoPath(options.projectRoot, options.repo))) return null;

  const pathInfo = gitPathInfo(request.path, options.repo);
  if (pathInfo === null) return null;

  const service = request.path.includes("git-receive-pack") ? "receive-pack" : "upload-pack";
  // Authentication is required for both directions: the App mints a token and the
  // Job mounts it, so an unauthenticated git operation must fail the same way it
  // would against GitHub (ADR-0009).
  if (request.auth === undefined || request.auth.password !== options.token) {
    options.onOperation?.({ service, path: request.path, ...(request.auth === undefined ? {} : { auth: request.auth }), exitCode: 401 });
    return { status: 401, headers: { "www-authenticate": 'Basic realm="stub-github"' }, body: Buffer.alloc(0) };
  }

  const query = request.path.includes("?") ? request.path.slice(request.path.indexOf("?") + 1) : "";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PROJECT_ROOT: options.projectRoot,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: pathInfo,
    REQUEST_METHOD: request.method,
    QUERY_STRING: query,
    CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
    CONTENT_LENGTH: String(request.body.length),
    REMOTE_USER: request.auth.username,
    GIT_COMMITTER_NAME: "stub-github",
    GIT_COMMITTER_EMAIL: "stub-github@example.invalid",
  };

  const result = await runGitHttpBackend(env, request.body);
  options.onOperation?.({
    service,
    path: request.path,
    auth: request.auth,
    exitCode: result.exitCode,
  });
  return parseCgiResponse(result.stdout, result.exitCode);
}

/**
 * `PATH_INFO` is the request path **relative to `GIT_PROJECT_ROOT`** — that is,
 * the whole URL path, because the bare repos live at `<root>/<owner>/<name>.git`.
 * Returns `null` for anything outside the served repository so the caller can
 * fall through to the REST routes.
 */
function gitPathInfo(requestPath: string, repo: string): string | null {
  const withoutQuery = requestPath.includes("?") ? requestPath.slice(0, requestPath.indexOf("?")) : requestPath;
  const prefix = `/${repo}.git`;
  if (!withoutQuery.startsWith(prefix)) return null;
  return withoutQuery;
}

function runGitHttpBackend(
  env: NodeJS.ProcessEnv,
  body: Buffer,
): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
    child.stdin.end(body);
  });
}

/**
 * Parse a CGI response: `Name: value` header lines, one blank line, then the
 * body. `git http-backend` emits a `Status:` header only on failure.
 */
export function parseCgiResponse(stdout: Buffer, exitCode: number): GitResponse {
  const separator = stdout.indexOf("\r\n\r\n");
  const separatorLength = 4;
  if (separator === -1) {
    return {
      status: exitCode === 0 ? 200 : 500,
      headers: {},
      body: stdout,
    };
  }
  const headerText = stdout.subarray(0, separator).toString("utf8");
  const body = stdout.subarray(separator + separatorLength);
  const headers: Record<string, string> = {};
  let status = exitCode === 0 ? 200 : 500;
  for (const line of headerText.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "status") {
      status = Number.parseInt(value, 10);
      continue;
    }
    headers[name] = value;
  }
  return { status, headers, body };
}
