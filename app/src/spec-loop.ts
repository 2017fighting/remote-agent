import { specBranch } from "@remote-agent/shared";
import type { NewTicket } from "@remote-agent/shared";
import type { GitHubIssue, GitHubPort } from "./ports/GitHubPort.js";
import type { K8sJob, K8sPod, K8sPort } from "./ports/K8sPort.js";
import type { AppConfig } from "./config.js";
import { startCloseoutJob } from "./claim.js";
import { renderWorkItem, serializeWorkItem, type WorkItemTicketInput } from "./renders/work-item.js";
import { CLOSEOUT_PR_BASE_BRANCH, renderCloseoutPrBody, renderCloseoutPrTitle } from "./renders/pull-request.js";
import {
  LABEL_CLOSEOUT_CONSUMED,
  SPEC_BLOCKED_LABELS,
  SPEC_DONE_LABELS,
  SPEC_ERROR_LABELS,
  isCloseoutConsumed,
  type SpecStep,
} from "./planners/spec-loop.js";
import { createFollowUp } from "./outcome.js";
import {
  migrateLabels,
  postFailureComment,
  setExpiresAtIfAbsent,
  type LabelMigration,
} from "./outcome-effects.js";

/**
 * The spec loop's write side (spec #33 §2 steps 4 and 5, docs/architecture.md
 * §4.5): start the closeout Job at S1, and turn its outcome into S3 / S3N /
 * S4 / S5.
 *
 * Every branch is replayable, and each one has its own carrier for "already
 * done" — none of them is control-plane state (ADR-0001):
 *
 * - **S1 → S2** the closeout Job object is the marker. It is create-if-absent
 *   under a deterministic name, and while it exists (running, finished, or in
 *   its retention window) no second one starts — the k8s half of the
 *   Claim-gate, unchanged (ADR-0013). Starting one also reclaims the previous
 *   round's volume and Secret: the closeout role's conversation is terminal once
 *   it reported, so the next round has to seed from nothing (ADR-0016, #60).
 * - **S2 → S3** the PR is idempotent by head branch, and the label migration is
 *   what takes the spec out of the gate, so the next pass has nothing to do.
 *   PR first, labels second: the reverse crash window would leave the spec
 *   outside the gate with no PR, and nothing would ever retry it.
 * - **S2 → S3N** two carriers, because one of them dies. The created tickets are
 *   linked as sub-issues, and while any of them is open the spec is on the
 *   "open sub-issue" branch (S1), so no second pass repeats the creation. Their
 *   labels decide what happens next: `ready-for-agent` ones become the Frontier
 *   right away — the spec's authorization is inherited (ticket #46) — and are
 *   claimed on the next pass with no human checkpoint in between (ticket #48).
 *   That is also the cost: the loop has no round limit, only the human escape
 *   hatch of removing `agent:implement` from the spec (docs/architecture.md §3).
 *   `ready-for-human` ones wait for a human.
 *
 *   Once they have *all* closed the spec is back on "no open sub-issue" while the
 *   closeout Job object is still inside its retention window, so the outcome
 *   needs a carrier that does not die with the tickets: `closeout-consumed` on
 *   the spec (ticket #49). It is written here, before the first create, and
 *   cleared when the next closeout Job starts; the k8s half of the Claim-gate
 *   keeps the old object from being re-judged in the meantime.
 * - **S2 → S4 / S5** the comment dedupes on its marker, and it is posted *before*
 *   the label migration (ticket #61): the human's entry point has to be durable
 *   before the spec leaves the gate. A crash in between re-judges and dedupes on
 *   the marker instead of leaving an exit label with no comment to explain it.
 * - **Every consumed outcome marks the spec** with `closeout-consumed` (ticket
 *   #61). The exit migration alone was the carrier for S3–S5, and a human
 *   re-entry is precisely the action that undoes it: the next pass then judged the
 *   same terminal Job again, reached the same verdict, and put the exit labels
 *   back — silently, because the comment dedupes on its marker. The marker is what
 *   survives the relabel. For S3–S5 it rides the same label edit as the exit
 *   migration, so the two cannot be half-applied; S3N stays the one branch that
 *   writes it on its own, first.
 *
 * Two windows have no carrier, and the marker changes what they cost rather than
 * closing them:
 *
 * - **Between creating a follow-up and linking it.** The issue exists, the spec
 *   does not list it yet. With the marker already written, the next pass will
 *   not repeat the batch — so the loss is the rest of the batch plus one orphan
 *   issue nobody links (it shows up in the repo, just not as this spec's
 *   sub-issue). Before the marker existed the same crash repeated the batch
 *   instead, which is strictly worse.
 * - **Between the marker and the first create.** The whole batch is lost; the
 *   TTL brings a fresh closeout that re-reports it.
 *
 * Closing either properly needs an idempotency key the run result does not carry
 * (title matching is a guess, and a wrong one silently drops a real follow-up),
 * so they stay known windows rather than silent rules.
 *
 * A spec never gets `agent:in-progress` on any of these paths (§4.5).
 */

export interface SpecLoopDeps {
  github: GitHubPort;
  k8s: K8sPort;
  config: AppConfig;
  /** Judged-at clock for the closeout volume's `expires-at`. */
  now: () => Date;
}

/**
 * S1 → S2. The closeout Job is a Job like any other: same deterministic name
 * rule (on the spec's own number), same Ticket PVC and Secret, same
 * create-if-absent. Only the label write is missing — a spec has no
 * `agent:in-progress` to set.
 *
 * Its work item carries the **ticket map** (user story 26): the spec role reads
 * every sub-issue's title, body and comments without calling GitHub, which is
 * what `prompts/implement-spec` renders as "the ticket map … above".
 *
 * Two things about the **previous** round are cleaned up here, because this is
 * the one branch that requires *no* object under the deterministic name — so
 * whatever it finds is the previous round's leftover:
 *
 * 1. the `closeout-consumed` marker goes (ticket #49), and
 * 2. the previous round's volume and Secret are reclaimed (ADR-0016, ticket #60).
 *
 * Order is marker → reclaim → create, and a crash between any two steps leaves
 * "no marker, no object", which the next pass replays:
 *
 * - crash after the clear, before the create → next pass sees no marker and no
 *   object, so it clears nothing and starts the closeout. Nothing is lost.
 * - the reverse marker order would leave a fresh, unjudged run carrying the old
 *   marker, so its outcome would read as "already consumed" until the TTL
 *   deleted the object and a whole closeout run was wasted.
 *
 * The reclaim is why the next round's seed finds no marker and no session: the
 * closeout role's conversation is terminal once it reported, so a second round
 * on that volume could only no-op (ADR-0016).
 */
export async function startSpecCloseout(deps: SpecLoopDeps, spec: GitHubIssue): Promise<void> {
  // A new closeout Job means a new run: the previous outcome's marker would
  // otherwise make this run's result look consumed before it is judged.
  if (isCloseoutConsumed(spec)) {
    await migrateLabels(deps.github, spec, { add: [], remove: [LABEL_CLOSEOUT_CONSUMED] });
  }
  const workItemJson = serializeWorkItem(
    renderWorkItem({
      issue: spec,
      specNumber: spec.number,
      comments: await deps.github.listComments(spec.ownerRepo, spec.number),
      tickets: await readTicketMap(deps.github, spec),
    }),
  );
  const result = await startCloseoutJob({
    config: deps.config,
    github: deps.github,
    k8s: deps.k8s,
    targetRepo: spec.ownerRepo,
    specNumber: spec.number,
    workItemJson,
  });
  // `quota-exceeded` and `already-claimed` are both "nothing more this pass";
  // only a real failure stops the pass, exactly as it does for a ticket.
  if (result.kind === "failed") throw result.error;
}

/**
 * The spec's sub-issues in listed order, each with its own comments oldest
 * first. Two reads per ticket; a spec with no sub-issues yields an empty map.
 */
async function readTicketMap(github: GitHubPort, spec: GitHubIssue): Promise<WorkItemTicketInput[]> {
  const subIssues = await github.listSubIssues(spec.ownerRepo, spec.number);
  return Promise.all(
    subIssues.map(async (subIssue) => ({
      issue: subIssue,
      comments: await github.listComments(subIssue.ownerRepo, subIssue.number),
    })),
  );
}

/**
 * S2 → S3 / S3N / S4 / S5. Runs after Claim, so a spec whose closeout finished
 * in this same world is closed out in the same pass that advanced it.
 */
export async function applySpecStep(
  deps: SpecLoopDeps,
  spec: GitHubIssue,
  step: SpecStep,
  job: K8sJob | null,
  pods: K8sPod[],
): Promise<void> {
  // One judged-at instant per spec, so the date quoted in the evidence comment
  // and the value written to the volume are the same one.
  const judgedAt = deps.now();

  switch (step.kind) {
    case "open-pull-request":
      await openCloseoutPullRequest(deps, spec, step.prBody, judgedAt);
      return;
    case "create-sub-issues":
      await createFollowUpTickets(deps, spec, step.newTickets);
      return;
    case "closeout-blocked":
      // Comment first, then the state change (ticket #61): the human's entry point
      // is durable before the spec leaves the gate.
      await postFailureComment(deps, spec, job, pods, { outcome: "blocked", result: step.result }, judgedAt);
      await setExpiresAtIfAbsent(deps, spec, "blocked", judgedAt);
      await migrateLabels(deps.github, spec, consumed(SPEC_BLOCKED_LABELS));
      return;
    case "closeout-error":
      await postFailureComment(
        deps,
        spec,
        job,
        pods,
        { outcome: "error", reason: step.reason, summary: step.summary },
        judgedAt,
      );
      // The volume clock goes on before the spec leaves the gate: a crash between
      // the two would otherwise leave a volume nothing ever reclaims.
      await setExpiresAtIfAbsent(deps, spec, "error", judgedAt);
      await migrateLabels(deps.github, spec, consumed(SPEC_ERROR_LABELS));
      return;
    case "advance":
    case "idle":
    case "start-closeout":
    case "closeout-running":
    case "closeout-consumed":
    case "out-of-gate":
      // S1 branches, the still-running closeout, and a consumed outcome waiting
      // for its Job object's `DELETED` all write nothing here.
      return;
  }
}

/** S3: a ready PR to `main` from `agent/spec-<n>`, then the exit from the gate. */
async function openCloseoutPullRequest(
  deps: SpecLoopDeps,
  spec: GitHubIssue,
  prBody: string,
  judgedAt: Date,
): Promise<void> {
  const headBranch = specBranch(spec.number);
  const existing = await deps.github.findPullRequestByBranch(spec.ownerRepo, headBranch);
  if (existing === null) {
    await deps.github.createPullRequest({
      ownerRepo: spec.ownerRepo,
      title: renderCloseoutPrTitle(spec),
      body: renderCloseoutPrBody(prBody, spec.number),
      headBranch,
      baseBranch: CLOSEOUT_PR_BASE_BRANCH,
    });
  }
  // The label migration is what takes the spec out of the gate (§4.2), and it
  // carries the consumed marker with it (ticket #61).
  await setExpiresAtIfAbsent(deps, spec, "done", judgedAt);
  await migrateLabels(deps.github, spec, consumed(SPEC_DONE_LABELS));
}

/**
 * An exit migration that also carries the consumed marker, in one label edit
 * (ticket #61).
 *
 * The two are one state transition — "this outcome was acted on, and the spec
 * left the gate" — so writing them together is what makes the marker unlosable:
 * no crash can leave the exit labels without it. S3N is the one branch that needs
 * the marker *without* an exit migration, and writes it on its own, first.
 */
function consumed(migration: LabelMigration): LabelMigration {
  return { add: [...migration.add, LABEL_CLOSEOUT_CONSUMED], remove: migration.remove };
}

/**
 * S3N: create the follow-ups and link them, open no PR, and leave the spec's
 * gate labels alone — "there is still work left" must not look like "the spec is
 * complete".
 *
 * The created tickets are what stops a second run of this branch *while any of
 * them is open*: linked and open, they take the spec back to S1 (an open
 * sub-issue means the closeout is not its turn). That carrier dies when they all
 * close, so the outcome is marked consumed first (ticket #49) — before the first
 * create, because the marker is what has to survive a crash in the middle of the
 * batch, not the tickets. A `ready-for-agent` follow-up is then the Frontier on
 * the very next pass — authorization is inherited from the spec (ticket #46) —
 * and is claimed without a human in the loop (ticket #48); a `ready-for-human`
 * one waits for a human.
 */
async function createFollowUpTickets(
  deps: SpecLoopDeps,
  spec: GitHubIssue,
  newTickets: NewTicket[],
): Promise<void> {
  // Mark first: a crash after this point parks the spec on "consumed" until the
  // Job object is gone, instead of repeating the batch (ticket #49).
  await migrateLabels(deps.github, spec, { add: [LABEL_CLOSEOUT_CONSUMED], remove: [] });
  for (const ticket of newTickets) {
    const created = await createFollowUp(deps.github, spec, ticket);
    await deps.github.addSubIssue(spec.ownerRepo, spec.number, created.number);
  }
}
