import type {
  GitHubComment,
  GitHubIssue,
  GitHubPort,
  GitHubPullRequest,
  MintedToken,
} from "../ports/GitHubPort.js";

/**
 * In-memory GitHubPort fake (App seam, spec #33 Testing Decisions 1).
 * Holds full world state and records every write call so tests can assert
 * external behavior: which writes were issued and the final world.
 */
export class FakeGitHub implements GitHubPort {
  issues: GitHubIssue[] = [];
  comments: GitHubComment[] = [];
  pullRequests: GitHubPullRequest[] = [];
  /** Sub-issue lists: ownerRepo:specNumber → sub-issue numbers in order. */
  subIssues = new Map<string, number[]>();
  /** Blockers: ownerRepo:issueNumber → blocker issue numbers. */
  blockers = new Map<string, number[]>();
  /** Every write call issued, in order. Used for replayability assertions. */
  writeLog: string[] = [];
  private nextCommentId = 1;
  private nextPrNumber = 1000;
  private nextTokenId = 1;
  /**
   * Numbers handed out by `createIssue`. Seeded above every issue the world
   * starts with so a created ticket never collides with a fixture number.
   */
  nextIssueNumber = 100;

  constructor(world?: {
    issues?: GitHubIssue[];
    comments?: GitHubComment[];
    pullRequests?: GitHubPullRequest[];
    subIssues?: Array<{ ownerRepo: string; specNumber: number; issueNumbers: number[] }>;
    blockers?: Array<{ ownerRepo: string; issueNumber: number; blockerNumbers: number[] }>;
  }) {
    if (world?.issues) {
      this.issues.push(...world.issues);
      this.nextIssueNumber = Math.max(this.nextIssueNumber, ...world.issues.map((i) => i.number + 1));
    }
    if (world?.comments) {
      this.comments.push(...world.comments);
      this.nextCommentId = world.comments.length + 1;
    }
    if (world?.pullRequests) this.pullRequests.push(...world.pullRequests);
    for (const s of world?.subIssues ?? []) {
      this.subIssues.set(`${s.ownerRepo}:${s.specNumber}`, [...s.issueNumbers]);
    }
    for (const b of world?.blockers ?? []) {
      this.blockers.set(`${b.ownerRepo}:${b.issueNumber}`, [...b.blockerNumbers]);
    }
  }

  private key(ownerRepo: string, number: number): string {
    return `${ownerRepo}:${number}`;
  }

  private requireIssue(ownerRepo: string, issueNumber: number): GitHubIssue {
    const issue = this.issues.find((i) => i.ownerRepo === ownerRepo && i.number === issueNumber);
    if (!issue) throw new Error(`issue not found: ${this.key(ownerRepo, issueNumber)}`);
    return issue;
  }

  private record(entry: string): void {
    this.writeLog.push(entry);
  }

  async listIssues(): Promise<GitHubIssue[]> {
    return [...this.issues];
  }

  async listSubIssues(ownerRepo: string, specNumber: number): Promise<GitHubIssue[]> {
    const numbers = this.subIssues.get(this.key(ownerRepo, specNumber)) ?? [];
    return numbers
      .map((n) => this.issues.find((i) => i.ownerRepo === ownerRepo && i.number === n))
      .filter((i): i is GitHubIssue => i !== undefined);
  }

  async listBlockers(ownerRepo: string, issueNumber: number): Promise<GitHubIssue[]> {
    const numbers = this.blockers.get(this.key(ownerRepo, issueNumber)) ?? [];
    return numbers
      .map((n) => this.issues.find((i) => i.ownerRepo === ownerRepo && i.number === n))
      .filter((i): i is GitHubIssue => i !== undefined);
  }

  async getIssue(ownerRepo: string, issueNumber: number): Promise<GitHubIssue | null> {
    return (
      this.issues.find((i) => i.ownerRepo === ownerRepo && i.number === issueNumber) ?? null
    );
  }

  async listComments(ownerRepo: string, issueNumber: number): Promise<GitHubComment[]> {
    return this.comments
      .filter((c) => c.ownerRepo === ownerRepo && c.issueNumber === issueNumber)
      .sort((a, b) => (a.createdAt === b.createdAt ? a.id - b.id : a.createdAt.localeCompare(b.createdAt)));
  }

  async findPullRequestByBranch(ownerRepo: string, branch: string): Promise<GitHubPullRequest | null> {
    return (
      this.pullRequests.find(
        (pr) => pr.ownerRepo === ownerRepo && pr.headBranch === branch && pr.state === "open",
      ) ?? null
    );
  }

  async editLabels(
    ownerRepo: string,
    issueNumber: number,
    add: string[],
    remove: string[],
  ): Promise<void> {
    const issue = this.requireIssue(ownerRepo, issueNumber);
    const set = new Set(issue.labels);
    for (const l of add) set.add(l);
    for (const l of remove) set.delete(l);
    const next = [...set];
    if (next.length !== issue.labels.length || next.some((l, i) => issue.labels[i] !== l)) {
      issue.labels = next;
      this.record(`editLabels ${ownerRepo}#${issueNumber} +[${add}] -[${remove}]`);
    }
  }

  async addComment(ownerRepo: string, issueNumber: number, body: string): Promise<void> {
    this.requireIssue(ownerRepo, issueNumber);
    this.comments.push({
      id: this.nextCommentId++,
      ownerRepo,
      issueNumber,
      body,
      createdAt: new Date().toISOString(),
    });
    this.record(`addComment ${ownerRepo}#${issueNumber}`);
  }

  async createIssue(input: {
    ownerRepo: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<GitHubIssue> {
    const created: GitHubIssue = {
      ownerRepo: input.ownerRepo,
      number: this.nextIssueNumber++,
      state: "open",
      title: input.title,
      body: input.body,
      labels: [...input.labels],
    };
    this.issues.push(created);
    this.record(`createIssue ${input.ownerRepo} ${input.title} +[${input.labels}]`);
    return created;
  }

  async closeIssue(ownerRepo: string, issueNumber: number): Promise<void> {
    const issue = this.requireIssue(ownerRepo, issueNumber);
    if (issue.state !== "closed") {
      issue.state = "closed";
      this.record(`closeIssue ${ownerRepo}#${issueNumber}`);
    }
  }

  async createPullRequest(input: {
    ownerRepo: string;
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<GitHubPullRequest> {
    const existing = await this.findPullRequestByBranch(input.ownerRepo, input.headBranch);
    if (existing) return existing;
    const pr: GitHubPullRequest = {
      ownerRepo: input.ownerRepo,
      number: this.nextPrNumber++,
      state: "open",
      draft: false,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      title: input.title,
      body: input.body,
    };
    this.pullRequests.push(pr);
    this.record(`createPullRequest ${input.ownerRepo} ${input.headBranch}`);
    return pr;
  }

  async mintInstallationToken(ownerRepo: string): Promise<MintedToken> {
    this.record(`mintInstallationToken ${ownerRepo}`);
    const id = this.nextTokenId++;
    return {
      token: `ghs_fake_${ownerRepo.replace(/[^a-z0-9]/gi, "")}_${id}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }
}
