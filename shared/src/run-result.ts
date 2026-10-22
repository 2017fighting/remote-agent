/**
 * Run result v1 — the payload the runner writes on its own Job annotation
 * `remote-agent/run-result` (ADR-0007). The agent can only self-report
 * `done` or `blocked`; `error` is judged by the runner/App, never by the agent,
 * so it is not part of this payload.
 */
export type RunResultOutcome = "done" | "blocked";

export interface NewTicket {
  title: string;
  body: string;
  readyForAgent: boolean;
}

export interface RunResultV1 {
  v: 1;
  outcome: RunResultOutcome;
  summary: string;
  /** `blocked` requires a comment body; for `done` it is optional. */
  commentBody?: string;
  /** Only written by `finish_spec`; required there. */
  prBody?: string;
  newTickets?: NewTicket[];
  warnings?: string[];
}

export function isRunResultV1(value: unknown): value is RunResultV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["v"] === 1 &&
    (v["outcome"] === "done" || v["outcome"] === "blocked") &&
    typeof v["summary"] === "string"
  );
}
