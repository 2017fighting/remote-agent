import { jobName } from "@remote-agent/shared";
import type { GitHubIssue, GitHubPort } from "./ports/GitHubPort.js";
import type { K8sJob, K8sPod, K8sPort } from "./ports/K8sPort.js";
import { judgeOutcome, type OutcomeTransition } from "./planners/outcome.js";
import { LABEL_AGENT_IN_PROGRESS } from "./planners/gate.js";
import { renderDoneComment } from "./renders/comments.js";
import {
  migrateLabels,
  postFailureComment,
  postOnce,
  setExpiresAtIfAbsent,
  type FailureOutcome,
} from "./outcome-effects.js";

/**
 * Outcome handling for tickets (spec #33 §2 step 2, docs/architecture.md §4.3).
 * Runs before Claim, over every ticket that carries `agent:in-progress`.
 *
 * Write order per ticket is the one the state table pins down:
 *
 * 1. `done` — sub-issues first (if `newTickets` is non-empty), then the comment,
 *    the label migration and finally the close. Creating sub-issues *before*
 *    closing leaves no window where the ticket is closed and the follow-ups do
 *    not exist yet.
 * 2. `blocked` / `error` — label migration, then the comment. The ticket stays
 *    open: `error` and `blocked` are the human's entry point, not a retry path.
 * 3. `expires-at` on the Ticket PVC, set-if-absent, in this same pass — the
 *    retention clock belongs to the outcome (ADR-0011).
 *
 * The spec role's S3–S5 runs through the same effects module (outcome-effects.ts)
 * with its own label set and its own "done" (open the PR); only the `done` shape
 * below is ticket-specific.
 *
 * Replayability: labels are set-semantics, the close is a no-op once closed,
 * comments dedupe on their marker, and `expires-at` is set-if-absent. A second
 * pass over the same world writes nothing — by then the ticket no longer has
 * `agent:in-progress`, so nothing here runs at all.
 */

export interface OutcomeStepDeps {
  github: GitHubPort;
  k8s: K8sPort;
  /** Judged-at clock for `expires-at`; injected so tests can pin the date. */
  now: () => Date;
}

/** T4–T6e for every in-progress ticket in the world. */
export async function handleOutcomes(
  deps: OutcomeStepDeps,
  issues: GitHubIssue[],
  jobsByName: ReadonlyMap<string, K8sJob>,
  pods: K8sPod[],
): Promise<void> {
  for (const issue of issues) {
    if (!isInProgress(issue)) continue;
    const name = jobName(issue.ownerRepo, issue.number);
    const job = jobsByName.get(name) ?? null;
    const transition = judgeOutcome({ issue, job });
    if (transition.kind === "none") continue;
    await execute(deps, issue, job, pods, transition);
  }
}

/**
 * `agent:in-progress` on an **open** ticket is the whole entry condition for
 * this step. A closed ticket is out of the state machine (T4 closed it); a
 * stale label on one is not a run to judge.
 */
function isInProgress(issue: GitHubIssue): boolean {
  return issue.state === "open" && issue.labels.includes(LABEL_AGENT_IN_PROGRESS);
}

async function execute(
  deps: OutcomeStepDeps,
  issue: GitHubIssue,
  job: K8sJob | null,
  pods: K8sPod[],
  transition: Exclude<OutcomeTransition, { kind: "none" }>,
): Promise<void> {
  const { github } = deps;
  const name = jobName(issue.ownerRepo, issue.number);
  // One judged-at instant per ticket, so the date quoted in the evidence
  // comment and the value written to the PVC are the same one.
  const judgedAt = deps.now();

  if (transition.kind === "done") {
    // Sub-issues before the close: the reverse order would leave a window with
    // the ticket closed and its follow-ups not yet created (§4.3 T4).
    for (const ticket of transition.result.newTickets ?? []) {
      await createFollowUp(github, issue, ticket);
    }
    await postOnce(github, issue, "done", name, renderDoneComment({ jobName: name, result: transition.result }));
    await migrateLabels(github, issue, { add: transition.addLabels, remove: transition.removeLabels });
    await github.closeIssue(issue.ownerRepo, issue.number);
  } else {
    await migrateLabels(github, issue, { add: transition.addLabels, remove: transition.removeLabels });
    await postFailureComment(deps, issue, job, pods, asFailureOutcome(transition), judgedAt);
  }

  // `expires-at` is written in the same pass that judged the outcome, and only
  // when absent: an existing value is the retention clock already running.
  await setExpiresAtIfAbsent(deps, issue, transition.kind, judgedAt);
}

function asFailureOutcome(transition: Exclude<OutcomeTransition, { kind: "none" | "done" }>): FailureOutcome {
  if (transition.kind === "blocked") return { outcome: "blocked", result: transition.result };
  return { outcome: "error", reason: transition.reason, summary: transition.summary };
}

/**
 * A `newTickets` entry is born in the right half of the Gate by its label
 * (spec #33 §0). Linking it to the spec is the spec loop's S3N write, not this
 * one: a ticket's follow-ups are not automatically that spec's sub-issues.
 */
export async function createFollowUp(
  github: GitHubPort,
  issue: GitHubIssue,
  ticket: { title: string; body: string; readyForAgent: boolean },
): Promise<GitHubIssue> {
  return github.createIssue({
    ownerRepo: issue.ownerRepo,
    title: ticket.title,
    body: ticket.body,
    labels: [ticket.readyForAgent ? "ready-for-agent" : "ready-for-human"],
  });
}
