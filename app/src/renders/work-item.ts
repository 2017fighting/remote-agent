import type { WorkItemComment, WorkItemTicket, WorkItemV1 } from "@remote-agent/shared";
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
 * The spec role's work item carries the **ticket map**: every sub-issue with its
 * title, body and comments (user story 26 — the spec role must be able to read
 * its acceptance surface without `gh`). The ticket role's work item carries its
 * own issue only; its acceptance surface is its own body.
 *
 * Budget is 512 KB. Bodies are always kept verbatim (the ticket's whole
 * acceptance surface); comments are dropped **oldest first across the whole
 * payload** and replaced by a single pointer line per truncated list, so what
 * survives is the most recent discussion.
 */

export const WORK_ITEM_MAX_BYTES = 512 * 1024;
export const OMITTED_COMMENTS_PLACEHOLDER = "… earlier comments omitted, see GitHub";

/** One sub-issue of the spec role's ticket map, with its comments oldest first. */
export interface WorkItemTicketInput {
  issue: GitHubIssue;
  comments: GitHubComment[];
}

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
  /**
   * The spec role's ticket map, in the spec's listed sub-issue order. Present —
   * possibly empty — for the spec role only; the ticket role leaves it absent.
   */
  tickets?: WorkItemTicketInput[];
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
    comments: renderComments(input.comments),
    ...(input.tickets === undefined ? {} : { tickets: input.tickets.map(renderTicket) }),
  };
}

function renderTicket(ticket: WorkItemTicketInput): WorkItemTicket {
  return {
    number: ticket.issue.number,
    title: ticket.issue.title,
    body: ticket.issue.body,
    comments: renderComments(ticket.comments),
  };
}

function renderComments(comments: GitHubComment[]): WorkItemComment[] {
  return comments.map((comment) => ({
    author: comment.author ?? "",
    body: comment.body,
    createdAt: comment.createdAt,
  }));
}

/**
 * Fit the work item into the byte budget and return the JSON string that goes
 * into `AGENT_WORK_ITEM`.
 *
 * Titles and bodies are never touched. Comments are dropped one at a time from
 * the oldest end of the whole payload — the spec's own comments and every
 * ticket's comments are one history — and each list that lost an entry gets one
 * pointer line prepended, so the reader can see that history was truncated.
 */
export function serializeWorkItem(item: WorkItemV1): string {
  const tickets = (item.tickets ?? []).map((ticket) => ({ ...ticket, comments: [...ticket.comments] }));
  const comments = [...item.comments];
  // Index 0 is the work item's own comment list; 1..n follow the ticket map.
  const lists = [comments, ...tickets.map((ticket) => ticket.comments)];
  const truncated = lists.map(() => false);

  const build = (): string =>
    serialize({
      ...item,
      comments: withPointer(comments, truncated[0]!),
      ...(item.tickets === undefined
        ? {}
        : {
            tickets: tickets.map((ticket, index) => ({
              ...ticket,
              comments: withPointer(ticket.comments, truncated[index + 1]!),
            })),
          }),
    });

  let json = build();
  for (let oldest = oldestList(lists); oldest !== -1; oldest = oldestList(lists)) {
    if (byteLength(json) <= WORK_ITEM_MAX_BYTES) break;
    lists[oldest]!.shift();
    truncated[oldest] = true;
    json = build();
  }

  // The bodies alone can exceed the budget; they are kept verbatim by contract,
  // so this is the one case where the budget cannot be met.
  return json;
}

/** The list holding the globally oldest surviving comment, or -1 when none is left. */
function oldestList(lists: WorkItemComment[][]): number {
  let oldest = -1;
  let oldestKey = "";
  for (const [index, list] of lists.entries()) {
    const head = list[0];
    if (head === undefined) continue;
    if (oldest === -1 || head.createdAt < oldestKey) {
      oldest = index;
      oldestKey = head.createdAt;
    }
  }
  return oldest;
}

/** The single line standing in for every comment dropped from this list. */
function withPointer(comments: WorkItemComment[], truncated: boolean): WorkItemComment[] {
  return truncated ? [pointerComment(), ...comments] : comments;
}

function pointerComment(): WorkItemComment {
  return { author: "remote-agent", body: OMITTED_COMMENTS_PLACEHOLDER, createdAt: "" };
}

function serialize(item: WorkItemV1): string {
  return JSON.stringify(item);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
