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
 * Three things here are structural rather than conventional:
 *
 * - **A spec never carries `agent:in-progress`.** Its "running" is expressed by
 *   being inside the label gate with an empty or non-empty Frontier, so the
 *   label keeps exactly one meaning: a Job currently occupies this ticket. For
 *   S3–S5 the spec's "this outcome was already consumed" marker is the label
 *   migration below (all three leave the gate); S3N needs a carrier of its own,
 *   the next bullet. That is also why the k8s half of the Claim-gate still has
 *   to apply to the closeout Job.
 * - **The closeout Job object is the S2 state.** While it exists — running,
 *   finished, or inside its retention window — S1 starts no second one, and the
 *   outcome is judged on the pass that migrates the spec's labels.
 * - **S3N needs a carrier of its own** (`closeout-consumed`, ticket #49): S3N
 *   stays in the gate, and its only other carrier — the created follow-ups —
 *   dies when they all close. See `LABEL_CLOSEOUT_CONSUMED` below.
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
  /**
   * S2 already consumed (ticket #49): the closeout Job object still exists but
   * its outcome was acted on. Nothing to do but wait for the object's `DELETED`
   * event, exactly like the k8s half of the Claim-gate.
   */
  | { kind: "closeout-consumed" }
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
 * S3N's "this outcome is consumed" marker on the spec (ticket #49).
 *
 * S3 / S4 / S5 do not need one: their label migration takes the spec out of the
 * gate, so the next pass has nothing to judge. S3N deliberately stays in the
 * gate ("there is still work left" must not look like "the spec is complete"),
 * and the follow-ups it creates were the only thing that said "already done" —
 * a carrier that dies as soon as every follow-up closes, while the closeout Job
 * object is still inside its 30-minute retention window. The outcome would then
 * be judged a second time and the same `newTickets` created again.
 *
 * So the marker is an explicit label on the spec, with the same life cycle as a
 * Ticket PVC's `expires-at`: written in the pass that consumed the outcome,
 * cleared in the pass that starts the next closeout Job. The closeout Job object
 * is what bounds its life — a marked spec never starts a closeout, and starting
 * one is the only thing that clears the marker.
 *
 * Ordering is the crash-window choice (ticket #49): the marker goes on **before**
 * the first `createIssue`. A crash between the two loses that batch of
 * follow-ups once; the Job's TTL deletes the object, the next pass starts a new
 * closeout, and the spec role re-reports whatever is still missing. The reverse
 * order would create the batch twice, which is the bug being fixed.
 */
export const LABEL_CLOSEOUT_CONSUMED = "closeout-consumed";

/** Labels are a set: is this spec's closeout outcome already consumed? */
export function isCloseoutConsumed(spec: GitHubIssue): boolean {
  return spec.labels.includes(LABEL_CLOSEOUT_CONSUMED);
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

  // The object outlives its own outcome (ticket #49): once the outcome was
  // consumed, this Job is not a result any more — whatever shape it has. Checked
  // before the Job is judged at all, so a consumed run's annotation is never
  // read a second time (ADR-0007: read exactly once) and a consumed `done`
  // cannot create the same follow-ups twice. A marked spec never reaches
  // `start-closeout` (the marker is cleared there), so the marker can only ever
  // describe a run that already ended.
  if (isCloseoutConsumed(spec)) return { kind: "closeout-consumed" };

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
