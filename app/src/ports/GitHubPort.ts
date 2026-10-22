/**
 * GitHubPort — the only GitHub seam (spec #33 §1). Production implementation
 * is octokit (behind app/src/adapters); tests use the in-memory fake that
 * holds full world state. Decision code talks to this interface only and
 * cannot tell which implementation it is talking to.
 */

export interface GitHubIssue {
  ownerRepo: string;
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  labels: string[];
}

export interface GitHubComment {
  id: number;
  ownerRepo: string;
  issueNumber: number;
  /** Login of the comment author; carried into AGENT_WORK_ITEM for the agent's context. */
  author?: string;
  body: string;
  createdAt: string;
}

export interface GitHubPullRequest {
  ownerRepo: string;
  number: number;
  state: "open" | "closed";
  /** Ready (non-draft) PRs only in v1; this flag is part of the port surface for future close paths. */
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface MintedToken {
  token: string;
  /** RFC3339, as returned by GitHub. */
  expiresAt: string;
}

export interface GitHubPort {
  // --- reads ---
  /** All known issues — the universe the App recomputes from each pass (startup list + passes). */
  listIssues(): Promise<GitHubIssue[]>;
  /** A spec's sub-issues in their listed order (determinism source for Frontier). */
  listSubIssues(ownerRepo: string, specNumber: number): Promise<GitHubIssue[]>;
  /** Issues (blockers) that block the given issue; an open blocker holds it at the Gate. */
  listBlockers(ownerRepo: string, issueNumber: number): Promise<GitHubIssue[]>;
  getIssue(ownerRepo: string, issueNumber: number): Promise<GitHubIssue | null>;
  /** Comments of an issue, oldest first. */
  listComments(ownerRepo: string, issueNumber: number): Promise<GitHubComment[]>;
  /** The open PR for a head branch, if any (PR idempotence is by branch). */
  findPullRequestByBranch(ownerRepo: string, branch: string): Promise<GitHubPullRequest | null>;

  // --- writes (App is the sole GitHub writer, ADR-0002) ---
  /** Set semantics: adds and removes so the final label set matches the intent. */
  editLabels(ownerRepo: string, issueNumber: number, add: string[], remove: string[]): Promise<void>;
  addComment(ownerRepo: string, issueNumber: number, body: string): Promise<void>;
  closeIssue(ownerRepo: string, issueNumber: number): Promise<void>;
  createPullRequest(input: {
    ownerRepo: string;
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<GitHubPullRequest>;
  /** Mint an installation token scoped to one target repo with `contents: write`. */
  mintInstallationToken(ownerRepo: string): Promise<MintedToken>;
}
