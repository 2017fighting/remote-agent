/**
 * Scenario fixture and world state for the stub GitHub (spec #33 Testing
 * Decisions 3).
 *
 * The stub holds the same world shape the App's `GitHubPort` reads and writes,
 * so the fixture is the only thing a scenario supplies: issues, the sub-issue
 * tree, blockers, comments and PRs. Every mutation the App performs lands here,
 * which is what the scenario's final assertions read back.
 *
 * Nothing here models GitHub behaviour the App does not use: no pagination, no
 * search, no webhooks, no assignees. The endpoint surface is exactly the one
 * `GitHubPort` declares (app/src/ports/GitHubPort.ts), so the production
 * octokit adapter (#43) and this stub agree on the wire.
 */

export interface StubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
}

export interface StubComment {
  id: number;
  issueNumber: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface StubPullRequest {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

/** The JSON scenario fixture. `repo` is `owner/name` — the single target repo. */
export interface Scenario {
  repo: string;
  issues: StubIssue[];
  /** spec number → its sub-issue numbers, in the order the stub returns them. */
  subIssues: Record<string, number[]>;
  /** issue number → the numbers of the issues that block it. */
  blockers: Record<string, number[]>;
  comments?: StubComment[];
  pullRequests?: StubPullRequest[];
}

/** One request the stub served, recorded for assertions (spec #33 #41 AC 6). */
export interface RecordedRequest {
  method: string;
  path: string;
  /** Decoded Basic-auth username/password pair, when the request carried one. */
  auth?: { username: string; password: string };
  /** Parsed JSON body, when there was one. */
  body?: unknown;
  at: string;
}

/** One git operation the stub served through `git http-backend`. */
export interface RecordedGitOperation {
  /** `upload-pack` (clone/fetch/ls-remote) or `receive-pack` (push). */
  service: "upload-pack" | "receive-pack";
  path: string;
  auth?: { username: string; password: string };
  /** Exit status of the `git http-backend` process that served it. */
  exitCode: number;
  at: string;
}

/**
 * The mutable world. Reads return copies so a handler cannot accidentally hand
 * out a reference the App could mutate; writes go through the methods.
 */
export class StubWorld {
  private readonly issues = new Map<number, StubIssue>();
  private readonly subIssues = new Map<number, number[]>();
  private readonly blockers = new Map<number, number[]>();
  private readonly comments: StubComment[] = [];
  private readonly pullRequests: StubPullRequest[] = [];
  private nextCommentId = 1;
  private nextIssueNumber = 1;
  private nextPullRequestNumber = 1;
  private clock: () => Date = () => new Date();

  constructor(readonly repo: string, scenario: Scenario) {
    if (scenario.repo !== repo) {
      throw new Error(`scenario repo ${scenario.repo} does not match the stub's repo ${repo}`);
    }
    for (const issue of scenario.issues) this.issues.set(issue.number, { ...issue, labels: [...issue.labels] });
    for (const [specNumber, numbers] of Object.entries(scenario.subIssues)) {
      this.subIssues.set(Number(specNumber), [...numbers]);
    }
    for (const [issueNumber, numbers] of Object.entries(scenario.blockers)) {
      this.blockers.set(Number(issueNumber), [...numbers]);
    }
    for (const comment of scenario.comments ?? []) this.comments.push({ ...comment });
    for (const pr of scenario.pullRequests ?? []) this.pullRequests.push({ ...pr });

    this.nextCommentId = Math.max(1, ...this.comments.map((c) => c.id + 1));
    this.nextIssueNumber = Math.max(1, ...[...this.issues.keys()].map((n) => n + 1));
    this.nextPullRequestNumber = Math.max(1, ...this.pullRequests.map((p) => p.number + 1));
  }

  setClock(clock: () => Date): void {
    this.clock = clock;
  }

  // --- reads ---

  listIssues(): StubIssue[] {
    return [...this.issues.values()]
      .sort((a, b) => a.number - b.number)
      .map((issue) => ({ ...issue, labels: [...issue.labels] }));
  }

  getIssue(number: number): StubIssue | null {
    const issue = this.issues.get(number);
    return issue === undefined ? null : { ...issue, labels: [...issue.labels] };
  }

  listSubIssues(specNumber: number): StubIssue[] {
    return (this.subIssues.get(specNumber) ?? [])
      .map((number) => this.issues.get(number))
      .filter((issue): issue is StubIssue => issue !== undefined)
      .map((issue) => ({ ...issue, labels: [...issue.labels] }));
  }

  listBlockers(issueNumber: number): StubIssue[] {
    return (this.blockers.get(issueNumber) ?? [])
      .map((number) => this.issues.get(number))
      .filter((issue): issue is StubIssue => issue !== undefined)
      .map((issue) => ({ ...issue, labels: [...issue.labels] }));
  }

  listComments(issueNumber: number): StubComment[] {
    return this.comments
      .filter((comment) => comment.issueNumber === issueNumber)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id))
      .map((comment) => ({ ...comment }));
  }

  findPullRequestByBranch(headBranch: string): StubPullRequest | null {
    const found = this.pullRequests.find((pr) => pr.headBranch === headBranch && pr.state === "open");
    return found === undefined ? null : { ...found };
  }

  listPullRequests(): StubPullRequest[] {
    return this.pullRequests.map((pr) => ({ ...pr }));
  }

  // --- writes ---

  /** Set semantics: the final label set is exactly `labels` (GitHubPort.editLabels). */
  setLabels(issueNumber: number, labels: string[]): StubIssue {
    const issue = this.requireIssue(issueNumber);
    issue.labels = [...labels];
    return { ...issue, labels: [...issue.labels] };
  }

  addComment(issueNumber: number, body: string, author = "remote-agent[bot]"): StubComment {
    this.requireIssue(issueNumber);
    const comment: StubComment = {
      id: this.nextCommentId++,
      issueNumber,
      author,
      body,
      createdAt: this.clock().toISOString(),
    };
    this.comments.push(comment);
    return { ...comment };
  }

  closeIssue(issueNumber: number): StubIssue {
    const issue = this.requireIssue(issueNumber);
    issue.state = "closed";
    return { ...issue, labels: [...issue.labels] };
  }

  createIssue(input: { title: string; body: string; labels: string[] }): StubIssue {
    const issue: StubIssue = {
      number: this.nextIssueNumber++,
      title: input.title,
      body: input.body,
      state: "open",
      labels: [...input.labels],
    };
    this.issues.set(issue.number, issue);
    return { ...issue, labels: [...issue.labels] };
  }

  /** Link an existing issue as a sub-issue; already-linked is a no-op (replayability). */
  addSubIssue(specNumber: number, issueNumber: number): void {
    this.requireIssue(specNumber);
    this.requireIssue(issueNumber);
    const list = this.subIssues.get(specNumber) ?? [];
    if (!list.includes(issueNumber)) {
      list.push(issueNumber);
      this.subIssues.set(specNumber, list);
    }
  }

  createPullRequest(input: {
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
  }): StubPullRequest {
    const pr: StubPullRequest = {
      number: this.nextPullRequestNumber++,
      state: "open",
      draft: false,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      title: input.title,
      body: input.body,
    };
    this.pullRequests.push(pr);
    return { ...pr };
  }

  private requireIssue(number: number): StubIssue {
    const issue = this.issues.get(number);
    if (issue === undefined) throw new StubNotFound(`issue #${number} does not exist`);
    return issue;
  }
}

export class StubNotFound extends Error {}

/** Parse and validate a scenario fixture read from disk. */
export function parseScenario(raw: unknown): Scenario {
  const value = raw as Partial<Scenario>;
  if (typeof value.repo !== "string" || !value.repo.includes("/")) {
    throw new Error("scenario.repo must be owner/name");
  }
  if (!Array.isArray(value.issues)) throw new Error("scenario.issues must be an array");
  return {
    repo: value.repo,
    issues: value.issues,
    subIssues: value.subIssues ?? {},
    blockers: value.blockers ?? {},
    comments: value.comments ?? [],
    pullRequests: value.pullRequests ?? [],
  };
}
