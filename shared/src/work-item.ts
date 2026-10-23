/**
 * Work item v1 — what the App renders into Job env `AGENT_WORK_ITEM` (spec #33 §0).
 * The App is the only GitHub reader, so the Job never fetches the issue: the body
 * arrives verbatim, comments oldest first (truncation is the App's job).
 */
export interface WorkItemComment {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * One ticket of the spec role's ticket map: the ticket as the App read it, with
 * its own comments oldest first. `number` is what `Part of #<spec>` points back
 * from; the title and body are the acceptance surface the prompt renders.
 */
export interface WorkItemTicket {
  number: number;
  title: string;
  body: string;
  comments: WorkItemComment[];
}

export interface WorkItemV1 {
  v: 1;
  /** Target repo as `owner/name`. */
  repo: string;
  /** The issue number of this work item (ticket, or the spec itself for the spec role). */
  number: number;
  /** The spec this work item belongs to; equals `number` for the spec role. */
  specNumber: number;
  title: string;
  body: string;
  /**
   * The parent spec's body, when the App could read it. The Spec axis of `code_review`
   * compares the diff against this text; for the spec role `body` already is the spec
   * body, so the field stays absent there.
   */
  specBody?: string;
  comments: WorkItemComment[];
  /**
   * The spec role's ticket map: every sub-issue of the spec, newest last, each
   * with its own comments in chronological order (spec #33 user story 26).
   * Absent for the ticket role — its acceptance surface is its own body.
   */
  tickets?: WorkItemTicket[];
}

/** True when a parsed value is a work item's ticket entry (one nested level). */
export function isWorkItemTicket(value: unknown): value is WorkItemTicket {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["number"] === "number" &&
    Number.isInteger(v["number"]) &&
    typeof v["title"] === "string" &&
    typeof v["body"] === "string" &&
    Array.isArray(v["comments"]) &&
    v["comments"].every(isWorkItemComment)
  );
}

function isWorkItemComment(value: unknown): value is WorkItemComment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["author"] === "string" && typeof v["body"] === "string" && typeof v["createdAt"] === "string";
}

export function isWorkItemV1(value: unknown): value is WorkItemV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["v"] === 1 &&
    typeof v["repo"] === "string" &&
    v["repo"].includes("/") &&
    typeof v["number"] === "number" &&
    Number.isInteger(v["number"]) &&
    typeof v["specNumber"] === "number" &&
    Number.isInteger(v["specNumber"]) &&
    typeof v["title"] === "string" &&
    typeof v["body"] === "string" &&
    (v["specBody"] === undefined || typeof v["specBody"] === "string") &&
    Array.isArray(v["comments"]) &&
    v["comments"].every((comment) => typeof comment === "object" && comment !== null) &&
    (v["tickets"] === undefined ||
      (Array.isArray(v["tickets"]) && v["tickets"].every(isWorkItemTicket)))
  );
}

/** Parse `AGENT_WORK_ITEM`; throws with the reason the payload is unusable. */
export function parseWorkItem(raw: string): WorkItemV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_WORK_ITEM is not valid JSON");
  }
  if (!isWorkItemV1(parsed)) throw new Error("AGENT_WORK_ITEM does not match work item v1");
  return parsed;
}
