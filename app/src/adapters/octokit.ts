import { App, Octokit } from "octokit";
import type {
  GitHubComment,
  GitHubIssue,
  GitHubPort,
  GitHubPullRequest,
  MintedToken,
} from "../ports/GitHubPort.js";

/**
 * Production GitHubPort implementation (spec #33 §1: "生产实现是 octokit").
 *
 * Authentication is GitHub App (ADR-0002): the App id + private key sign a JWT,
 * the JWT resolves an installation id per target repo, and every read/write
 * goes through an installation token. `mintInstallationToken` is the one path
 * that asks GitHub for a *fresh* token — the per-Job Secret needs a new expiry
 * each renewal, so it must not come out of the installation-token cache.
 *
 * `GITHUB_API_BASE_URL` is honoured by every call: the base class handed to the
 * App is `Octokit.defaults({ baseUrl })`, and octokit derives the installation
 * client (and the token-mint request) from that same base. That is what lets
 * the kind e2e point the App at a stub (spec #33 §0).
 */

/**
 * The GitHub REST API version every request pins (#50).
 *
 * Unversioned requests default to `2022-11-28`, which GitHub marks as closing
 * down (sunset 2028-03-10), so `@octokit/request` warns on *every* response
 * carrying a `Deprecation` header. Once that version retires, unversioned
 * requests silently fall through to the next supported version instead — pinning
 * turns both into a reviewed one-line change.
 *
 * Sent through the plugin below rather than `Octokit.defaults({ headers })`:
 * `@octokit/core` 7 reads only `userAgent` / `baseUrl` / `previews` / `timeZone`
 * from its constructor options and drops `headers` on the floor, so a header set
 * that way never reaches the wire. The plugin's `hook.before("request")` does,
 * for all four request paths: `app.octokit` (JWT), the per-installation clients,
 * the token mint, and `eachRepository`.
 */
const GITHUB_API_VERSION = "2026-03-10";

/** Adds the pinned API version to every request this class issues. */
function pinApiVersion(octokit: { hook: OctokitClient["hook"] }): void {
  octokit.hook.before("request", (options) => {
    options.headers["x-github-api-version"] = GITHUB_API_VERSION;
  });
}

/** Everything this adapter needs from the environment; read once in `main.ts`. */
export interface OctokitGitHubConfig {
  /** GITHUB_APP_ID. */
  appId: string;
  /** GITHUB_APP_PRIVATE_KEY (PEM, may carry escaped newlines). */
  privateKey: string;
  /** GITHUB_API_BASE_URL, e.g. `https://api.github.com`. */
  apiBaseUrl: string;
}

type OctokitClient = InstanceType<typeof Octokit>;

/**
 * The subset of GitHub's issue / pull payloads this adapter reads. Structural,
 * not imported from `@octokit/types`: those types widen ids to
 * `number | bigint`, which is noise for fields the App only compares and never
 * sends back.
 */
interface IssueShape {
  id: number | bigint;
  number: number;
  state: string;
  title: string;
  body?: string | null;
  labels?: Array<string | { name?: string | null }>;
  pull_request?: unknown;
}

interface PullShape {
  number: number;
  state: string;
  draft?: boolean | null;
  title: string;
  body?: string | null;
  head: { ref: string };
  base: { ref: string };
}

export class OctokitGitHub implements GitHubPort {
  private readonly app: App;
  /** Installation id per `owner/repo`. Stable identity, not world state. */
  private readonly installationIds = new Map<string, number>();
  /** Installation-scoped clients, so a pass reuses one token per repo. */
  private readonly clients = new Map<string, OctokitClient>();

  constructor(config: OctokitGitHubConfig) {
    // Fail at startup with the env names, not at the first request with
    // octokit's own wording: a missing App credential is a deployment fault.
    if (config.appId === "") throw new Error("GITHUB_APP_ID is required for the GitHub App adapter");
    if (config.privateKey === "") {
      throw new Error("GITHUB_APP_PRIVATE_KEY is required for the GitHub App adapter");
    }
    const base = Octokit.defaults({ baseUrl: config.apiBaseUrl.replace(/\/+$/, "") }).plugin(pinApiVersion);
    this.app = new App({
      appId: config.appId,
      privateKey: config.privateKey.replace(/\\n/g, "\n"),
      Octokit: base,
    });
  }

  // --- reads ---

  /**
   * Every issue the installation can see, across its repositories — the
   * universe a pass recomputes from. Pull requests come back from the issues
   * endpoint too and are not issues for the Gate, so they are dropped.
   *
   * This is also where the per-repo installation clients are learned, so the
   * rest of the pass reuses them instead of resolving an installation id per
   * repo (one fewer App-JWT round trip, and the world always contains the
   * target repo).
   */
  async listIssues(): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    for await (const { octokit, repository } of this.app.eachRepository.iterator()) {
      const client = octokit as OctokitClient;
      this.clients.set(repository.full_name, client);
      const { owner, repo } = splitRepo(repository.full_name);
      const items = await client.paginate("GET /repos/{owner}/{repo}/issues", {
        owner,
        repo,
        state: "all",
        per_page: 100,
      });
      for (const item of items) {
        if (isPullRequest(item)) continue;
        issues.push(toIssue(repository.full_name, item));
      }
    }
    return issues;
  }

  async listSubIssues(ownerRepo: string, specNumber: number): Promise<GitHubIssue[]> {
    const client = await this.clientFor(ownerRepo);
    const { owner, repo } = splitRepo(ownerRepo);
    // The endpoint returns sub-issues in their listed order — the Frontier's
    // determinism source — and pagination keeps that order.
    const items = await client.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
      owner,
      repo,
      issue_number: specNumber,
      per_page: 100,
    });
    return items.map((item) => toIssue(ownerRepo, item));
  }

  async listBlockers(ownerRepo: string, issueNumber: number): Promise<GitHubIssue[]> {
    const client = await this.clientFor(ownerRepo);
    const { owner, repo } = splitRepo(ownerRepo);
    const items = await client.paginate(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
      { owner, repo, issue_number: issueNumber, per_page: 100 },
    );
    return items.map((item) => toIssue(ownerRepo, item));
  }

  async getIssue(ownerRepo: string, issueNumber: number): Promise<GitHubIssue | null> {
    const client = await this.clientFor(ownerRepo);
    const { owner, repo } = splitRepo(ownerRepo);
    try {
      const { data } = await client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner,
        repo,
        issue_number: issueNumber,
      });
      if (isPullRequest(data)) return null;
      return toIssue(ownerRepo, data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listComments(ownerRepo: string, issueNumber: number): Promise<GitHubComment[]> {
    const client = await this.clientFor(ownerRepo);
    const { owner, repo } = splitRepo(ownerRepo);
    const items = await client.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    return items
      .map((item) => ({
        id: item.id,
        ownerRepo,
        issueNumber,
        author: item.user?.login,
        body: item.body ?? "",
        createdAt: item.created_at,
      }))
      .sort((a, b) => (a.createdAt === b.createdAt ? a.id - b.id : a.createdAt.localeCompare(b.createdAt)));
  }

  async findPullRequestByBranch(ownerRepo: string, branch: string): Promise<GitHubPullRequest | null> {
    const client = await this.clientFor(ownerRepo);
    const { owner, repo } = splitRepo(ownerRepo);
    const { data } = await client.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      state: "open",
      head: `${owner}:${branch}`,
      per_page: 100,
    });
    const match = data.find((pull) => pull.head.ref === branch);
    return match === undefined ? null : toPullRequest(ownerRepo, match);
  }

  // --- writes (App is the sole GitHub writer, ADR-0002) ---

  /**
   * Set semantics. GitHub's issue PATCH takes the *whole* label set in one
   * request, which is the only shape that cannot leave a half-migrated label
   * set behind (a crash between an add and a remove would), and the shape both
   * the fake and the e2e stub model (`state.setLabels`). So this reads the
   * current set, computes the target, and writes nothing when it already
   * matches — a replayed pass issues no label write at all.
   */
  async editLabels(
    ownerRepo: string,
    issueNumber: number,
    add: string[],
    remove: string[],
  ): Promise<void> {
    const client = await this.clientFor(ownerRepo);
    const { owner, repo } = splitRepo(ownerRepo);
    const { data } = await client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner,
      repo,
      issue_number: issueNumber,
    });
    const current = (data.labels ?? []).map((label) =>
      typeof label === "string" ? label : (label.name ?? ""),
    );
    const target = new Set(current);
    for (const name of add) target.add(name);
    for (const name of remove) target.delete(name);
    const labels = [...target];
    if (labels.length === current.length && labels.every((name, index) => name === current[index])) return;

    await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
      owner,
      repo,
      issue_number: issueNumber,
      labels,
    });
  }

  async addComment(ownerRepo: string, issueNumber: number, body: string): Promise<void> {
    const client = await this.clientFor(ownerRepo);
    const { owner, repo } = splitRepo(ownerRepo);
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }

  async closeIssue(ownerRepo: string, issueNumber: number): Promise<void> {
    const client = await this.clientFor(ownerRepo);
    const { owner, repo } = splitRepo(ownerRepo);
    await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
      owner,
      repo,
      issue_number: issueNumber,
      state: "closed",
    });
  }

  async createIssue(input: {
    ownerRepo: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<GitHubIssue> {
    const client = await this.clientFor(input.ownerRepo);
    const { owner, repo } = splitRepo(input.ownerRepo);
    const { data } = await client.request("POST /repos/{owner}/{repo}/issues", {
      owner,
      repo,
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    return toIssue(input.ownerRepo, data);
  }

  /**
   * Link an existing issue as a sub-issue. GitHub addresses the child by its
   * numeric *id*, not its number, so this costs one read; the read is also the
   * create-if-absent probe (an existing link is a no-op, keeping a replay
   * write-free).
   */
  async addSubIssue(ownerRepo: string, specNumber: number, issueNumber: number): Promise<void> {
    const existing = await this.listSubIssues(ownerRepo, specNumber);
    if (existing.some((issue) => issue.number === issueNumber)) return;
    const client = await this.clientFor(ownerRepo);
    const { owner, repo } = splitRepo(ownerRepo);
    const { data: child } = await client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner,
      repo,
      issue_number: issueNumber,
    });
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
      owner,
      repo,
      issue_number: specNumber,
      sub_issue_id: Number(child.id),
    });
  }

  /** PR idempotence is by head branch (spec #33 §2): an existing PR is returned, not duplicated. */
  async createPullRequest(input: {
    ownerRepo: string;
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<GitHubPullRequest> {
    const existing = await this.findPullRequestByBranch(input.ownerRepo, input.headBranch);
    if (existing !== null) return existing;
    const client = await this.clientFor(input.ownerRepo);
    const { owner, repo } = splitRepo(input.ownerRepo);
    const { data } = await client.request("POST /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      title: input.title,
      body: input.body,
      head: input.headBranch,
      base: input.baseBranch,
    });
    return toPullRequest(input.ownerRepo, data);
  }

  /**
   * Mint a fresh installation token scoped to one repository with
   * `contents: write` only (ADR-0009). The request is signed with the App JWT,
   * and the token comes back in the response body — never in a URL, where a
   * 600+ character credential could be truncated by a proxy.
   */
  async mintInstallationToken(ownerRepo: string): Promise<MintedToken> {
    const installationId = await this.installationIdFor(ownerRepo);
    const { repo } = splitRepo(ownerRepo);
    const { data } = await this.app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
        repositories: [repo],
        permissions: { contents: "write" },
      },
    );
    return { token: data.token, expiresAt: data.expires_at };
  }

  // --- plumbing ---

  private async installationIdFor(ownerRepo: string): Promise<number> {
    const cached = this.installationIds.get(ownerRepo);
    if (cached !== undefined) return cached;
    const { owner, repo } = splitRepo(ownerRepo);
    const { data } = await this.app.octokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
    });
    this.installationIds.set(ownerRepo, data.id);
    return data.id;
  }

  private async clientFor(ownerRepo: string): Promise<OctokitClient> {
    const cached = this.clients.get(ownerRepo);
    if (cached !== undefined) return cached;
    const client = (await this.app.getInstallationOctokit(
      await this.installationIdFor(ownerRepo),
    )) as OctokitClient;
    this.clients.set(ownerRepo, client);
    return client;
  }
}

/** `owner/repo` → the two path segments every endpoint wants. */
function splitRepo(ownerRepo: string): { owner: string; repo: string } {
  const slash = ownerRepo.indexOf("/");
  if (slash <= 0 || slash === ownerRepo.length - 1) {
    throw new Error(`ownerRepo must be "owner/name", got "${ownerRepo}"`);
  }
  return { owner: ownerRepo.slice(0, slash), repo: ownerRepo.slice(slash + 1) };
}

/** The issues endpoints return pull requests too; the Gate must never see them. */
function isPullRequest(issue: { pull_request?: unknown }): boolean {
  return issue.pull_request !== undefined;
}

function toIssue(ownerRepo: string, issue: IssueShape): GitHubIssue {
  return {
    ownerRepo,
    number: issue.number,
    state: issue.state === "closed" ? "closed" : "open",
    title: issue.title,
    body: issue.body ?? "",
    labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : (label.name ?? ""))),
  };
}

function toPullRequest(ownerRepo: string, pull: PullShape): GitHubPullRequest {
  return {
    ownerRepo,
    number: pull.number,
    state: pull.state === "closed" ? "closed" : "open",
    draft: pull.draft ?? false,
    headBranch: pull.head.ref,
    baseBranch: pull.base.ref,
    title: pull.title,
    body: pull.body ?? "",
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;
}
