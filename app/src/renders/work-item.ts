import type { WorkItemComment, WorkItemV1 } from "@remote-agent/shared";
import type { GitHubComment, GitHubIssue } from "../ports/GitHubPort.js";

/**
 * AGENT_WORK_ITEM (spec #33 Implementation Decisions §0): the work item is
 * rendered as JSON and handed to the Job through one env var — no new object,
 * no new channel.
 *
 * The wire shape is `WorkItemV1` from `@remote-agent/shared`: one definition for
 * the App that renders it and the runner that parses it. This module only owns
 * the App's half — what goes in, and the byte budget.
 *
 * Budget is 512 KB. The body is always kept verbatim (it is the ticket's whole
 * acceptance surface); comments are dropped **oldest first** and replaced by a
 * single pointer line, so what survives is the most recent discussion.
 */

export const WORK_ITEM_MAX_BYTES = 512 * 1024;
export const OMITTED_COMMENTS_PLACEHOLDER = "… earlier comments omitted, see GitHub";

export interface WorkItemInput {
  issue: GitHubIssue;
  specNumber: number;
  /**
   * The parent spec's body, for a ticket's work item. The Spec axis of
   * `code_review` compares the diff against it, so a ticket run without it
   * reports "no spec available". Left absent for the spec role, whose `body`
   * already is the spec body.
   */
  specBody?: string;
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
    // Absent, not `undefined`: the spec role must not carry the key at all.
    ...(input.specBody === undefined ? {} : { specBody: input.specBody }),
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
