import { defineDoc } from "@earendil-works/pi-durable";

/**
 * The review fixed point, committed before the agent's first model request and
 * read back unchanged after `resume()` (ADR-0009). Ticket role: the run's start
 * `HEAD`; spec role: `git merge-base origin/main HEAD`. A crash between reading
 * the sha and committing this doc is harmless — the agent has not started.
 */
export type ReviewFixedPoint = {
  /** The sha the reviewer diffs against. */
  fixedPoint: string;
  /** Which rule produced it, so a resume can verify it is the same rule. */
  source: "run-start" | "merge-base";
  /** The branch the run works on (`agent/spec-<n>`). */
  branch: string;
  computedAt: string;
};

export const ReviewFixedPointDoc = defineDoc<ReviewFixedPoint>({
  kind: "remote-agent.review-fixed-point",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ fixedPoint: "", source: "run-start", branch: "", computedAt: "" }),
  // Never worth a checkpoint of its own: the value is written once, in the commit
  // that records it, and never edited again.
  checkpointWhen: () => false,
});
