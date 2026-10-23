import { jobName } from "@remote-agent/shared";
import type { GitHubIssue } from "../ports/GitHubPort.js";
import type { K8sJob } from "../ports/K8sPort.js";
import {
  LABEL_AGENT_BLOCKED,
  LABEL_AGENT_ERROR,
  LABEL_AGENT_IN_PROGRESS,
  claimGate,
  type GateFailure,
  type ParentSpec,
} from "./gate.js";

/**
 * Frontier (docs/architecture.md §4.2): the spec's first sub-issue that passes
 * the Claim-gate. Three outcomes, because the spec loop acts differently on
 * each (S1 → Claim / idle / closeout):
 *
 * - `has-frontier` — claim this ticket;
 * - `no-frontier-open-sub-issues` — no open sub-issue passes the Claim-gate: do
 *   nothing, log only. Each holdout carries the *next action* it needs, so the
 *   pass log can say why the Frontier is empty without the reader re-deriving it
 *   from labels (ticket #47);
 * - `all-closed` — nothing left: the closeout Job's turn.
 *
 * Order is the sub-issue list order as GitHub returns it, so the same world
 * always yields the same frontier. The spec's sub-issues are tried in that
 * order; specs themselves are ordered by number by the caller.
 */

/**
 * What has to happen before this ticket can be claimed — the gate condition
 * translated into the actor that resolves it (ticket #47). Two holdouts with the
 * same `GateFailure` can need different actions, so the log groups by this, not
 * by the raw gate verdict.
 */
export type HoldoutReason =
  /** `agent:in-progress`: a run holds it. Nothing to do but wait for its outcome. */
  | "in-flight"
  /** `agent:blocked` / `agent:error`: only a human re-enters it. */
  | "exit-marker"
  /** No `ready-for-agent`: a human has not triaged it in (or the spec closed out). */
  | "not-ready"
  /** An open blocker: it has to close first; nothing to do but wait. */
  | "open-blocker"
  /** No own `agent:implement`, and the parent spec does not authorize it either. */
  | "unauthorized"
  /** ADR-0013: the old Job object's `DELETED` event is the next step. */
  | "job-object-present";

/** One open sub-issue the Frontier skipped, with the action that unblocks it. */
export interface FrontierHoldout {
  issue: GitHubIssue;
  reason: HoldoutReason;
}

/**
 * The exit marker a ticket carries, read as the action it needs. The two are not
 * the same question: `agent:in-progress` means a Job is running it right now
 * (wait for the outcome), while `agent:blocked` / `agent:error` mean a run
 * already ended and a human has to re-enter it. No marker at all is a ticket
 * nobody has triaged into the gate yet.
 */
function exitMarkerReason(labels: string[]): HoldoutReason {
  if (labels.includes(LABEL_AGENT_IN_PROGRESS)) return "in-flight";
  if (labels.includes(LABEL_AGENT_BLOCKED) || labels.includes(LABEL_AGENT_ERROR)) return "exit-marker";
  return "not-ready";
}

/**
 * A `GateFailure` says which condition failed; this says who fixes it. A
 * blocked ticket reports `missing-ready-for-agent` (the outcome migration drops
 * `ready-for-agent`), which would read as "just re-add the label" — the exit
 * marker is what makes it "a human must re-enter this".
 */
function holdoutReason(issue: GitHubIssue, failure: GateFailure): HoldoutReason {
  switch (failure) {
    case "open-blocker":
      return "open-blocker";
    case "missing-agent-implement":
    case "spec-out-of-gate":
      return "unauthorized";
    case "job-object-present":
      return "job-object-present";
    case "agent-label-present":
      return exitMarkerReason(issue.labels);
    case "missing-ready-for-agent":
      // A ticket that carries an exit marker but lost `ready-for-agent` is the
      // post-outcome shape; the marker is the truer answer than "not ready".
      return exitMarkerReason(issue.labels);
    case "closed":
      // Open sub-issues only, so this is unreachable; "not-ready" is the honest
      // fallback for a ticket that is not (yet) something to work on.
      return "not-ready";
  }
}

export type FrontierOutcome =
  | { kind: "has-frontier"; ticket: GitHubIssue }
  | { kind: "no-frontier-open-sub-issues"; holdouts: FrontierHoldout[] }
  | { kind: "all-closed" };

export interface FrontierInput {
  ownerRepo: string;
  /** Sub-issues in their listed order (determinism source). */
  subIssues: GitHubIssue[];
  /** issue number → count of that issue's still-open blockers. */
  openBlockerCounts: ReadonlyMap<number, number>;
  /** Every Job object currently in the namespace, by name. */
  jobsByName: ReadonlyMap<string, K8sJob>;
  /**
   * The spec these are sub-issues of. Its `agent:implement` authorizes every
   * one of them (ticket #46); without it each ticket needs its own.
   */
  parentSpec?: ParentSpec;
}

export function planFrontier(input: FrontierInput): FrontierOutcome {
  const openSubIssues = input.subIssues.filter((issue) => issue.state === "open");

  const holdouts: FrontierHoldout[] = [];
  for (const issue of openSubIssues) {
    const existingJob = input.jobsByName.get(jobName(input.ownerRepo, issue.number)) ?? null;
    const gate = claimGate({
      issue,
      openBlockerCount: input.openBlockerCounts.get(issue.number) ?? 0,
      existingJob,
      parentSpec: input.parentSpec,
    });
    if (gate.passed) return { kind: "has-frontier", ticket: issue };
    holdouts.push({ issue, reason: holdoutReason(issue, gate.reason) });
  }

  if (openSubIssues.length === 0) return { kind: "all-closed" };
  return { kind: "no-frontier-open-sub-issues", holdouts };
}
