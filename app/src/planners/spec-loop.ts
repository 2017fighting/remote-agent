import { jobName } from "@remote-agent/shared";
import type { NewTicket, RunResultV1 } from "@remote-agent/shared";
import type { GitHubIssue } from "../ports/GitHubPort.js";
import type { K8sJob } from "../ports/K8sPort.js";
import {
  LABEL_AGENT_BLOCKED,
  LABEL_AGENT_ERROR,
  LABEL_READY_FOR_AGENT,
  LABEL_READY_FOR_HUMAN,
  authorizationGate,
  loopGate,
} from "./gate.js";
import type { FrontierOutcome } from "./frontier.js";
import { judgeJob, type AppErrorReason } from "./outcome.js";

/**
 * The spec loop's three-way branch at S1 and its outcome at S2
 * (docs/architecture.md §4.5). Pure: the world is passed in.
 *
 * ```
 * S1  frontier non-empty                      → claim that ticket (Claim's job)
 *     frontier empty ∧ no open sub-issue       → start the closeout Job (S2)
 *     frontier empty ∧ open sub-issues remain  → do nothing, log only
 * S2  closeout done ∧ newTickets empty         → S3  open the PR, ready-for-human
 *     closeout done ∧ newTickets non-empty     → S3N create the sub-issues, no PR
 *     closeout blocked                         → S4  ready-for-human + agent:blocked
 *     closeout error                           → S5  ready-for-human + agent:error
 * ```
 *
 * The spec's own label gate is read **twice, for two different questions**
 * (ticket #46):
 *
 * - Advancing a ticket needs only the **Loop** — the spec's own facts (open, no
 *   open blocker, `ready-for-agent`, no `agent:*`). The spec's `agent:implement`
 *   is not required here, because the ticket's own label may be the
 *   authorization instead: that is the "implement just this one" entry point.
 * - The closeout (S2–S5) is the **spec's own run**, so it needs the full Gate,
 *   authorization included.
 *
 * Two things here are structural rather than conventional:
 *
 * - **A spec never carries `agent:in-progress`.** Its "running" is expressed by
 *   being inside the label gate with an empty or non-empty Frontier, so the
 *   label keeps exactly one meaning: a Job currently occupies this ticket. The
 *   spec's "this outcome was already consumed" marker is the label migration
 *   below (S3–S5 all leave the gate), which is why the k8s half of the
 *   Claim-gate still has to apply to the closeout Job.
 * - **The closeout Job object is the S2 state.** While it exists — running,
 *   finished, or inside its retention window — S1 starts no second one, and the
 *   outcome is judged on the pass that migrates the spec's labels.
 */

export type SpecStep =
  /** S1 first branch: a ticket is claimable; the Frontier drives Claim. */
  | { kind: "advance"; ticket: GitHubIssue }
  /** S1 third branch: open sub-issues exist but none passes the Claim-gate. */
  | { kind: "idle" }
  /** S1 second branch: nothing left to do but close out. */
  | { kind: "start-closeout" }
  /** S2 while the closeout Job is live, or finished and about to be judged. */
  | { kind: "closeout-running" }
  /** S3: done with no follow-ups — the App opens the PR. */
  | { kind: "open-pull-request"; prBody: string }
  /** S3N: done with follow-ups — the App creates them and opens no PR. */
  | { kind: "create-sub-issues"; newTickets: NewTicket[] }
  /** S4: the spec takes the same label migration and comment a ticket does. */
  | { kind: "closeout-blocked"; result: RunResultV1 }
  /** S5: every `error` shape lands here, as it does for a ticket. */
  | { kind: "closeout-error"; reason: AppErrorReason; summary: string | null }
  /** Not a spec, or its own label gate is closed (S0 / after S3–S5 / S6 pending). */
  | { kind: "out-of-gate" };

/** The closeout Job's deterministic name — a ticket Job's rule applied to the spec's own number. */
export function closeoutJobName(ownerRepo: string, specNumber: number): string {
  return jobName(ownerRepo, specNumber);
}

/**
 * Label sets per S3–S5. Note what is missing: `agent:in-progress` is never
 * added, and `agent:implement` is never removed (the App never revokes
 * authorization). `ready-for-agent` is the exit condition — dropping it is what
 * takes the spec out of the gate, so it needs no run marker of its own.
 */
export const SPEC_DONE_LABELS = { add: [LABEL_READY_FOR_HUMAN], remove: [LABEL_READY_FOR_AGENT] };
export const SPEC_BLOCKED_LABELS = {
  add: [LABEL_READY_FOR_HUMAN, LABEL_AGENT_BLOCKED],
  remove: [LABEL_READY_FOR_AGENT],
};
export const SPEC_ERROR_LABELS = {
  add: [LABEL_READY_FOR_HUMAN, LABEL_AGENT_ERROR],
  remove: [LABEL_READY_FOR_AGENT],
};

export interface SpecStepInput {
  spec: GitHubIssue;
  /** `planFrontier`'s verdict for this spec. */
  frontier: FrontierOutcome;
  /** Open blockers on the spec itself (its own Gate). */
  openSpecBlockerCount: number;
  /** Every Job object in the namespace, by name. */
  jobsByName: ReadonlyMap<string, K8sJob>;
}

export function planSpecStep(input: SpecStepInput): SpecStep {
  const { spec, frontier, openSpecBlockerCount, jobsByName } = input;
  // The spec's own facts decide whether it drives its sub-issues at all. Its
  // `agent:implement` is deliberately not part of this: a ticket may carry the
  // authorization itself (ticket #46), and the parent's label would then be
  // required for no reason.
  if (!loopGate({ issue: spec, openBlockerCount: openSpecBlockerCount }).passed) return { kind: "out-of-gate" };

  if (frontier.kind === "has-frontier") return { kind: "advance", ticket: frontier.ticket };
  if (frontier.kind === "no-frontier-open-sub-issues") return { kind: "idle" };

  // Frontier empty and no open sub-issue: the closeout Job's turn (S2). That run
  // is the spec's own, so it needs the spec's own authorization.
  if (!authorizationGate({ issue: spec, openBlockerCount: openSpecBlockerCount }).passed) return { kind: "out-of-gate" };
  // …unless an object under its deterministic name exists (ADR-0013, k8s half).
  const job = jobsByName.get(closeoutJobName(spec.ownerRepo, spec.number)) ?? null;
  if (job === null) return { kind: "start-closeout" };

  const verdict = judgeJob(job);
  if (verdict.kind === "running") return { kind: "closeout-running" };
  if (verdict.kind === "done") {
    const newTickets = verdict.result.newTickets ?? [];
    if (newTickets.length > 0) return { kind: "create-sub-issues", newTickets };
    // `finish_spec` requires `prBody`; an absent one still gets a PR, because
    // S3's product is the PR plus the `Closes` trailer, not the prose.
    return { kind: "open-pull-request", prBody: verdict.result.prBody ?? "" };
  }
  if (verdict.kind === "blocked") return { kind: "closeout-blocked", result: verdict.result };
  return { kind: "closeout-error", reason: verdict.reason, summary: verdict.summary };
}
