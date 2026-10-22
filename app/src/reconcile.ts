import type { AppConfig } from "./config.js";
import type { GitHubIssue, GitHubPort } from "./ports/GitHubPort.js";
import type { K8sJob, K8sPod, K8sPort, K8sPvc } from "./ports/K8sPort.js";
import type { PassCounters, Trigger } from "./scheduler.js";
import { jobName } from "@remote-agent/shared";
import { planFrontier } from "./planners/frontier.js";
import { claimGate, labelGate } from "./planners/gate.js";
import { admitSlot, countSlotUsage, occupySlot } from "./planners/slots.js";
import type { VolumeStats } from "./planners/pvc-steward.js";
import { renderWorkItem, serializeWorkItem } from "./renders/work-item.js";
import { claimTicket } from "./claim.js";
import { handleOutcomes } from "./outcome.js";
import { reclaimVolumes } from "./reclamation.js";
import { renewTokens } from "./token-renewal.js";

export type { PassCounters };

/** Everything one pass reads; rebuilt from scratch every pass (ADR-0001). */
export interface WorldSnapshot {
  issues: Awaited<ReturnType<GitHubPort["listIssues"]>>;
  jobs: K8sJob[];
  pods: K8sPod[];
  pvcs: K8sPvc[];
}

export interface ReconcileDeps {
  github: GitHubPort;
  k8s: K8sPort;
  config: AppConfig;
  /** Test observation hook: called once per pass with the freshly read world. */
  onWorldRead?: (world: WorldSnapshot) => void;
  /** Judged-at clock for outcome retention (`expires-at`); defaults to wall clock. */
  now?: () => Date;
}

/** Pass counters plus the volume stats the pass-log's second line reports (ADR-0011). */
export interface ReconcileResult extends PassCounters {
  volumeStats: VolumeStats;
}

/**
 * One reconcile pass (spec #33 §2): read world → plan → execute → counters.
 * Stateless across passes — every pass rebuilds its view from GitHub and k8s;
 * nothing is cached between passes.
 *
 * Steps in execution order, which is load-bearing:
 *
 * 1. Read the world (issues, Jobs, pods, PVCs).
 * 2. Outcome handling for `agent:in-progress` tickets. This runs before Claim
 *    because Claim's gate depends on it: a judged ticket loses
 *    `agent:in-progress`, which is what lets the next pass see it as
 *    re-enterable instead of occupied.
 * 3–5. Slot occupancy, candidates, and Claim serially until a Slot is refused.
 * 6. Token renewal for the Jobs still running (ADR-0009 / ADR-0014).
 * 7. Reclamation of expired volumes and orphan fallbacks (ADR-0011).
 *
 * Steps 2–5 run **before** 6–7 on purpose: labels, `expires-at` and Claim's
 * clear of `expires-at` are already at their end-of-pass values when anything
 * is deleted, so a volume claimed this pass is never mistaken for expired, and
 * a volume judged this pass carries its fresh retention clock before the
 * delete decision is taken.
 *
 * The App never deletes or patches a Job: `ttlSecondsAfterFinished` is the only
 * Job deleter (ADR-0012).
 *
 * Replayability is a hard requirement: a second pass over an unchanged world
 * issues zero new external writes.
 */
export async function runReconcilePass(deps: ReconcileDeps, _trigger: Trigger): Promise<ReconcileResult> {
  const { github, k8s, config } = deps;
  const now = deps.now?.() ?? new Date();

  // 1. Read the world: issues, Jobs, pods, PVCs.
  const [issues, jobs, pods, pvcs] = await Promise.all([
    github.listIssues(),
    k8s.listJobs(),
    k8s.listPods(),
    k8s.listPvcs(),
  ]);
  const world: WorldSnapshot = { issues, jobs, pods, pvcs };
  deps.onWorldRead?.(world);

  // 2. Outcome handling: every ticket carrying `agent:in-progress` is judged
  //    against its deterministic-name Job. This is the one place the run-result
  //    annotation is read (ADR-0007 / ADR-0013), and it only runs for tickets
  //    that are still in T3 — so a replay over the post-judge world cannot read
  //    it a second time.
  await handleOutcomes(
    { github, k8s, now: () => now },
    issues,
    new Map(jobs.map((job) => [job.name, job])),
    pods,
  );

  // 3. Slot occupancy from the pods the world already has (Terminating counts).
  let usage = countSlotUsage(jobs, pods);
  let deferred = 0;
  let waiting = 0;

  // 4. Candidates: specs ascending by number, each contributing its Frontier.
  const jobsByName = new Map(world.jobs.map((job) => [job.name, job]));
  const candidates: Array<{ spec: GitHubIssue; ticket: GitHubIssue }> = [];
  for (const spec of specsInOrder(world.issues)) {
    const plan = await planSpec(deps, spec, jobsByName);
    // `waiting` counts tickets that are inside the label gate but held by a
    // lingering Job object — the k8s half of the Claim-gate (ADR-0013). It is
    // the same shape as Defer: no write, only this counter.
    waiting += plan.waiting;
    if (plan.kind === "claimable") candidates.push({ spec, ticket: plan.ticket });
  }

  // 5. Execute claims serially until a Slot is refused or a claim fails.
  for (const candidate of candidates) {
    const { spec, ticket } = candidate;
    const decision = admitSlot(usage, ticket.ownerRepo, config);
    if (decision.kind === "defer") {
      // Defer (docs/architecture.md §5): no Job, no label change, no comment —
      // only the `deferred` counter. The next wake retries naturally.
      deferred += 1;
      continue;
    }

    const workItemJson = serializeWorkItem(
      renderWorkItem({
        issue: ticket,
        specNumber: spec.number,
        comments: await github.listComments(ticket.ownerRepo, ticket.number),
      }),
    );

    const result = await claimTicket({
      config,
      github,
      k8s,
      targetRepo: ticket.ownerRepo,
      issueNumber: ticket.number,
      specNumber: spec.number,
      role: "implement-ticket",
      workItemJson,
    });

    if (result.kind === "failed") {
      // Stop the pass at this ticket; the next pass recomputes from world state.
      throw result.error;
    }
    if (result.kind === "quota-exceeded") {
      // Normal branch: no Job, no label, no comment, no `agent:error`. The next
      // pass recomputes; a quota that is still full simply says no again.
      continue;
    }
    // The Job now exists, so it holds a Slot for the rest of this pass even
    // before its pod shows up: admitting serially must not overshoot the cap.
    usage = occupySlot(usage, result.jobName, ticket.ownerRepo);
  }

  // 6. Token renewal: only the Jobs still running can have a token in use.
  const renewed = await renewTokens({ github, k8s, now }, jobs);

  // 7. Reclamation: expired volumes + their Secrets, then the orphan fallback.
  //    Runs last and re-reads the volumes/Jobs it judges, so the writes above
  //    are already in the world it sees.
  const { stats } = await reclaimVolumes({ k8s, now });

  return {
    slotsUsed: usage.total,
    slotsMax: config.maxJobsGlobal,
    deferred,
    renewed,
    waiting,
    volumeStats: stats,
  };
}

/** Candidate order is spec number ascending (determinism, spec #33 §2). */
function specsInOrder(issues: GitHubIssue[]): GitHubIssue[] {
  return issues.filter((issue) => issue.state === "open").sort((a, b) => a.number - b.number);
}

/**
 * What one spec wants this pass. `closeout-ready` and `out-of-gate` are already
 * computed here (they are the S1 branches) but only Claim acts on them today:
 * spec advance / closeout is #38.
 *
 * `waiting` is orthogonal to `kind`: it counts this spec's tickets that are
 * inside the label gate but held back by a lingering Job object.
 */
type SpecPlan =
  | { kind: "claimable"; ticket: GitHubIssue; waiting: number }
  /** Open sub-issues exist but none passes the Claim-gate: log only. */
  | { kind: "idle"; waiting: number }
  /** Every sub-issue is closed — the closeout Job's turn (#38). */
  | { kind: "closeout-ready"; waiting: number }
  /** Not a spec, or its own label gate is closed: nothing to do. */
  | { kind: "out-of-gate"; waiting: number };

/** A spec only drives work while it is itself in the label gate (S1). */
async function planSpec(
  deps: ReconcileDeps,
  spec: GitHubIssue,
  jobsByName: ReadonlyMap<string, K8sJob>,
): Promise<SpecPlan> {
  const subIssues = await deps.github.listSubIssues(spec.ownerRepo, spec.number);
  if (subIssues.length === 0) return { kind: "out-of-gate", waiting: 0 };

  const specBlockers = await deps.github.listBlockers(spec.ownerRepo, spec.number);
  const openSpecBlockers = specBlockers.filter((blocker) => blocker.state === "open").length;
  if (!labelGate(spec, openSpecBlockers).passed) return { kind: "out-of-gate", waiting: 0 };

  const openBlockerCounts = new Map<number, number>();
  for (const issue of subIssues) {
    const blockers = await deps.github.listBlockers(spec.ownerRepo, issue.number);
    openBlockerCounts.set(issue.number, blockers.filter((blocker) => blocker.state === "open").length);
  }

  const waiting = subIssues.filter(
    (issue) =>
      claimGate({
        issue,
        openBlockerCount: openBlockerCounts.get(issue.number) ?? 0,
        existingJob: jobsByName.get(jobName(spec.ownerRepo, issue.number)) ?? null,
      }).passed === false &&
      claimGate({
        issue,
        openBlockerCount: openBlockerCounts.get(issue.number) ?? 0,
        existingJob: null,
      }).passed,
  ).length;

  const frontier = planFrontier({ ownerRepo: spec.ownerRepo, subIssues, openBlockerCounts, jobsByName });
  if (frontier.kind === "has-frontier") return { kind: "claimable", ticket: frontier.ticket, waiting };
  if (frontier.kind === "no-frontier-open-sub-issues") return { kind: "idle", waiting };
  return { kind: "closeout-ready", waiting };
}
