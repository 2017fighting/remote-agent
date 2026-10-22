import type { GitHubComment, GitHubIssue } from "../ports/GitHubPort.js";

/**
 * AGENT_WORK_ITEM (spec #33 Implementation Decisions §0): the work item is
 * rendered as JSON and handed to the Job through one env var — no new object,
 * no new channel.
 *
 * Budget is 512 KB. The body is always kept verbatim (it is the ticket's whole
 * acceptance surface); comments are dropped **oldest first** and replaced by a
 * single pointer line, so what survives is the most recent discussion.
 *
 * The wire shape is work item v1; the runner is its reader and lives in the Job
 * image, so the fields here are the ones the runner parses.
 */

export const WORK_ITEM_MAX_BYTES = 512 * 1024;
export const OMITTED_COMMENTS_PLACEHOLDER = "… earlier comments omitted, see GitHub";

export interface WorkItemComment {
  author: string;
  body: string;
  createdAt: string;
}

/** Work item v1 — the JSON payload of `AGENT_WORK_ITEM`. */
export interface WorkItemV1 {
  v: 1;
  /** Target repo as `owner/name`. */
  repo: string;
  /** This issue's number (a ticket, or the spec itself for the spec role). */
  number: number;
  /** The spec this work item belongs to. */
  specNumber: number;
  title: string;
  body: string;
  /** Oldest first. */
  comments: WorkItemComment[];
}

export interface WorkItemInput {
  issue: GitHubIssue;
  specNumber: number;
  /** Oldest first, as GitHubPort.listComments returns them. */
  comments: GitHubComment[];
}

export function renderWorkItem(input: WorkItemInput): WorkItemV1 {
  return {
    v: 1,
    repo: input.issue.ownerRepo,
    number: input.issue.number,
    specNumber: input.specNumber,
    title: input.issue.title,
    body: input.issue.body,
    comments: input.comments.map((comment) => ({
      author: comment.author ?? "",
      body: comment.body,
      createdAt: comment.createdAt,
    })),
  };
}

/**
 * Fit the work item into the byte budget and return the JSON string that goes
 * into `AGENT_WORK_ITEM`.
 *
 * The body is never touched: comments are dropped from the front (oldest) until
 * the serialized item fits, and one pointer comment is prepended once anything
 * was dropped, so the reader can see that history was truncated.
 */
export function serializeWorkItem(item: WorkItemV1): string {
  const comments = [...item.comments];
  let json = serialize({ ...item, comments });

  while (byteLength(json) > WORK_ITEM_MAX_BYTES && comments.length > 0) {
    comments.shift();
    json = serialize({ ...item, comments: [pointerComment(), ...comments] });
  }

  // The body alone can exceed the budget; it is kept verbatim by contract, so
  // this is the one case where the budget cannot be met.
  return json;
}

/** The single line standing in for every dropped comment. */
function pointerComment(): WorkItemComment {
  return { author: "remote-agent", body: OMITTED_COMMENTS_PLACEHOLDER, createdAt: "" };
}

function serialize(item: WorkItemV1): string {
  return JSON.stringify(item);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
