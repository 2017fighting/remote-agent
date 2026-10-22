import type { GitHubComment, GitHubIssue } from "../ports/GitHubPort.js";

/**
 * AGENT_WORK_ITEM (spec #33 Implementation Decisions §0): the work item is
 * rendered as JSON and handed to the Job through one env var — no new object,
 * no new channel.
 *
 * Budget is 512 KB. The body is always kept verbatim (it is the ticket's whole
 * acceptance surface); comments are dropped **oldest first** and replaced by a
 * single pointer line, so what survives is the most recent discussion.
 */

export const WORK_ITEM_MAX_BYTES = 512 * 1024;
export const OMITTED_COMMENTS_PLACEHOLDER = "… earlier comments omitted, see GitHub";

export interface WorkItemComment {
  author?: string;
  createdAt: string;
  body: string;
}

export interface WorkItem {
  repo: string;
  issueNumber: number;
  specNumber: number;
  title: string;
  body: string;
  comments: WorkItemComment[];
  /** `… earlier comments omitted, see GitHub` when the budget forced truncation. */
  omittedComments?: string;
  newTicketsContext?: string;
}

export interface WorkItemInput {
  issue: GitHubIssue;
  specNumber: number;
  /** Oldest first, as GitHubPort.listComments returns them. */
  comments: GitHubComment[];
  /** Context about sub-issues created by a previous closeout run, if any. */
  newTicketsContext?: string;
}

export function renderWorkItem(input: WorkItemInput): WorkItem {
  const item: WorkItem = {
    repo: input.issue.ownerRepo,
    issueNumber: input.issue.number,
    specNumber: input.specNumber,
    title: input.issue.title,
    body: input.issue.body,
    comments: input.comments.map((c) => ({ createdAt: c.createdAt, body: c.body })),
  };
  if (input.newTicketsContext !== undefined) item.newTicketsContext = input.newTicketsContext;
  return item;
}

/**
 * Fit the work item into the byte budget. The body is never touched; comments
 * are dropped from the front (oldest) until the serialized item fits, and the
 * `omittedComments` marker is added once anything was dropped.
 *
 * Returns the JSON string that goes into `AGENT_WORK_ITEM`.
 */
export function serializeWorkItem(item: WorkItem): string {
  const comments = [...item.comments];
  let omitted = false;
  let json = serialize({ ...item, comments });

  while (byteLength(json) > WORK_ITEM_MAX_BYTES && comments.length > 0) {
    comments.shift();
    omitted = true;
    json = serialize({
      ...item,
      comments,
      ...(omitted ? { omittedComments: OMITTED_COMMENTS_PLACEHOLDER } : {}),
    });
  }

  // The body alone can exceed the budget; it is kept verbatim by contract, so
  // this is the one case where the budget cannot be met and the caller has to
  // live with it (the Job's env limit is the real ceiling).
  return json;
}

function serialize(item: WorkItem): string {
  return JSON.stringify(item);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
