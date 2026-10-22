import { StubNotFound, type StubComment, type StubIssue, type StubPullRequest, type StubWorld } from "./state.js";

/**
 * The REST surface of the stub GitHub.
 *
 * Every route below corresponds to one `GitHubPort` method
 * (app/src/ports/GitHubPort.ts), and the URL shapes are GitHub's own REST
 * shapes, because that is what the production octokit adapter (#43) will call:
 * the stub is the server side of that contract, so #43 can land on top without
 * this file changing. Routes the App never calls are not implemented on
 * purpose — an unhandled path is a 404, which makes an accidental extra call
 * loud instead of silently accepted.
 *
 * `GITHUB_API_BASE_URL` points the App here (spec #33 §0); nothing in product
 * code knows this server exists.
 */

export interface RestResponse {
  status: number;
  body: unknown;
}

/** GitHub's issue JSON, trimmed to the fields the adapter maps onto `GitHubIssue`. */
function issueJson(issue: StubIssue): Record<string, unknown> {
  return {
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function commentJson(comment: StubComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    created_at: comment.createdAt,
    user: { login: comment.author },
  };
}

function pullRequestJson(pr: StubPullRequest): Record<string, unknown> {
  return {
    number: pr.number,
    state: pr.state,
    draft: pr.draft,
    title: pr.title,
    body: pr.body,
    head: { ref: pr.headBranch },
    base: { ref: pr.baseBranch },
  };
}

export interface RestContext {
  world: StubWorld;
  /** The `owner/name` this stub serves; a route for another repo is a 404. */
  repo: string;
  /**
   * The single installation the stub reports. octokit's App auth resolves this
   * before any data read, so the App-JWT hand-off needs it even though the stub
   * does not verify the JWT itself.
   */
  installationId: number;
  /** Token value returned by the installation-token mint. */
  installationToken: string;
  /** Installation-token lifetime in seconds (GitHub returns ~1h). */
  tokenTtlSeconds: number;
  now: () => Date;
}

/**
 * Route one REST request. `segments` is the path split on `/` with the empty
 * leading element removed, already URL-decoded.
 */
export async function routeRest(
  context: RestContext,
  method: string,
  segments: string[],
  body: unknown,
): Promise<RestResponse> {
  const { world, repo } = context;

  // GET /app/installations — the App-level listing octokit's `eachInstallation`
  // paginates before it can hand out an installation client.
  if (method === "GET" && segments[0] === "app" && segments[1] === "installations" && segments.length === 2) {
    return { status: 200, body: [{ id: context.installationId }] };
  }

  // POST /app/installations/:id/access_tokens — mintInstallationToken.
  if (method === "POST" && segments[0] === "app" && segments[1] === "installations" && segments[3] === "access_tokens") {
    const expiresAt = new Date(context.now().getTime() + context.tokenTtlSeconds * 1000).toISOString();
    return {
      status: 201,
      body: { token: context.installationToken, expires_at: expiresAt, permissions: { contents: "write" } },
    };
  }

  // GET /installation/repositories — the installation-token-scoped repo list
  // octokit walks to turn an installation into repositories.
  if (method === "GET" && segments[0] === "installation" && segments[1] === "repositories") {
    const [owner, name] = repo.split("/");
    return {
      status: 200,
      body: { total_count: 1, repositories: [{ id: 1, name, full_name: `${owner}/${name}` }] },
    };
  }

  // Everything below is `/repos/:owner/:name/...`.
  if (segments[0] !== "repos") return notFound();
  const ownerRepo = `${segments[1]}/${segments[2]}`;
  if (ownerRepo !== repo) return notFound();
  const rest = segments.slice(3);

  // GET /repos/:o/:n/installation — the repo → installation lookup.
  if (method === "GET" && rest.length === 1 && rest[0] === "installation") {
    return { status: 200, body: { id: context.installationId } };
  }

  // GET /repos/:o/:n/issues — listIssues (the App's universe).
  if (method === "GET" && rest.length === 1 && rest[0] === "issues") {
    return { status: 200, body: world.listIssues().map(issueJson) };
  }

  // GET /repos/:o/:n/issues/:number
  if (method === "GET" && rest.length === 2 && rest[0] === "issues") {
    const issue = world.getIssue(Number(rest[1]));
    return issue === null ? notFound() : { status: 200, body: issueJson(issue) };
  }

  // PATCH /repos/:o/:n/issues/:number — closeIssue / label edits go through here.
  if (method === "PATCH" && rest.length === 2 && rest[0] === "issues") {
    const number = Number(rest[1]);
    const patch = (body ?? {}) as { state?: string; labels?: string[] };
    let issue: StubIssue | null = null;
    if (patch.labels !== undefined) issue = world.setLabels(number, patch.labels);
    if (patch.state === "closed") issue = world.closeIssue(number);
    if (issue === null) issue = world.getIssue(number);
    return issue === null ? notFound() : { status: 200, body: issueJson(issue) };
  }

  // POST /repos/:o/:n/issues — createIssue.
  if (method === "POST" && rest.length === 1 && rest[0] === "issues") {
    const input = (body ?? {}) as { title?: string; body?: string; labels?: string[] };
    const issue = world.createIssue({
      title: input.title ?? "",
      body: input.body ?? "",
      labels: input.labels ?? [],
    });
    return { status: 201, body: issueJson(issue) };
  }

  // GET/POST /repos/:o/:n/issues/:number/comments — listComments / addComment.
  if (rest.length === 3 && rest[0] === "issues" && rest[2] === "comments") {
    const number = Number(rest[1]);
    if (method === "GET") {
      return { status: 200, body: world.listComments(number).map(commentJson) };
    }
    if (method === "POST") {
      const input = (body ?? {}) as { body?: string };
      return { status: 201, body: commentJson(world.addComment(number, input.body ?? "")) };
    }
  }

  // POST /repos/:o/:n/issues/:number/sub_issues — addSubIssue.
  if (method === "POST" && rest.length === 3 && rest[0] === "issues" && rest[2] === "sub_issues") {
    const specNumber = Number(rest[1]);
    const input = (body ?? {}) as { sub_issue_id?: number; number?: number };
    const subIssueNumber = input.number ?? input.sub_issue_id;
    if (typeof subIssueNumber !== "number") return { status: 422, body: { message: "sub_issue_id is required" } };
    world.addSubIssue(specNumber, subIssueNumber);
    return { status: 201, body: {} };
  }

  // GET /repos/:o/:n/issues/:number/sub_issues — listSubIssues.
  if (method === "GET" && rest.length === 3 && rest[0] === "issues" && rest[2] === "sub_issues") {
    return { status: 200, body: world.listSubIssues(Number(rest[1])).map(issueJson) };
  }

  // GET /repos/:o/:n/issues/:number/dependencies/blocked_by — listBlockers.
  if (method === "GET" && rest.length === 4 && rest[0] === "issues" && rest[2] === "dependencies" && rest[3] === "blocked_by") {
    return { status: 200, body: world.listBlockers(Number(rest[1])).map(issueJson) };
  }

  // GET /repos/:o/:n/pulls?head=owner:branch — findPullRequestByBranch.
  if (method === "GET" && rest.length === 1 && rest[0] === "pulls") {
    return { status: 200, body: [] };
  }

  // POST /repos/:o/:n/pulls — createPullRequest.
  if (method === "POST" && rest.length === 1 && rest[0] === "pulls") {
    const input = (body ?? {}) as { title?: string; body?: string; head?: string; base?: string };
    if (input.head === undefined || input.base === undefined) {
      return { status: 422, body: { message: "head and base are required" } };
    }
    const pr = world.createPullRequest({
      title: input.title ?? "",
      body: input.body ?? "",
      headBranch: input.head,
      baseBranch: input.base,
    });
    return { status: 201, body: pullRequestJson(pr) };
  }

  return notFound();
}

/** `/repos/:o/:n/pulls` with `?head=` is a search; the caller passes the branch in. */
export function pullsByBranchResponse(world: StubWorld, branch: string): RestResponse {
  const pr = world.findPullRequestByBranch(branch);
  return { status: 200, body: pr === null ? [] : [pullRequestJson(pr)] };
}

function notFound(): RestResponse {
  return { status: 404, body: { message: "Not Found" } };
}

export { StubNotFound };
