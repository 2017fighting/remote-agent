import type { AppConfig } from "./config.js";
import type { GitHubIssue, GitHubPort } from "./ports/GitHubPort.js";
import type { K8sJob, K8sPod, K8sPort, K8sPvc } from "./ports/K8sPort.js";
import type { PassCounters, Trigger } from "./scheduler.js";
import { jobName } from "@remote-agent/shared";
import { planFrontier, type FrontierOutcome } from "./planners/frontier.js";
import { claimGate } from "./planners/gate.js";
import { admitSlot, countSlotUsage, occupySlot } from "./planners/slots.js";
import { closeoutJobName, planSpecStep, type SpecStep } from "./planners/spec-loop.js";
import { renderWorkItem, serializeWorkItem } from "./renders/work-item.js";
import { claimTicket } from "./claim.js";
import { handleOutcomes } from "./outcome.js";
import { applySpecStep, startSpecCloseout, type SpecLoopDeps } from "./spec-loop.js";

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

/**
 * One reconcile pass (spec #33 §2): read world → plan → execute → counters.
 * Stateless across passes — every pass rebuilds its view from GitHub and k8s;
 * nothing is cached between passes.
 *
 * Steps implemented so far: (2) outcome handling for `agent:in-progress`
 * tickets, (3) Claim, (4) spec advance (start the closeout Job) and (5) the
 * closeout outcome (PR / sub-issues / spec failure). Outcome handling runs first
 * because Claim's gate depends on it: a judged ticket loses
 * `agent:in-progress`, which is what lets the next pass see it as re-enterable
 * instead of occupied. Reclamation arrives in #37.
 *
 * Replayability is a hard requirement: a second pass over an unchanged world
 * issues zero new external writes.
 */
export async function runReconcilePass(deps: ReconcileDeps, _trigger: Trigger): Promise<PassCounters> {
  const { github, k8s, config } = deps;
  const now = deps.now ?? (() => new Date());

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
  await handleOutcomes({ github, k8s, now }, issues, new Map(jobs.map((job) => [job.name, job])), pods);

  // 3. Slot occupancy from the pods the world already has (Terminating counts).
  let usage = countSlotUsage(jobs, pods);
  let deferred = 0;
  let waiting = 0;

  // Plan: every spec is read once. Its Frontier decides the S1 branch, and the
  // reads the spec loop needs (its own Gate, the closeout Job) are collected in
  // the same walk. Specs ascending by number, sub-issues in listed order — the
  // same world always yields the same plan (spec #33 §2). Planning ahead of
  // Claim is safe because Claim only writes tickets, which no spec branch here
  // reads.
  const jobsByName = new Map(world.jobs.map((job) => [job.name, job]));
  const candidates: Array<{ spec: GitHubIssue; ticket: GitHubIssue }> = [];
  const closeoutStarts: GitHubIssue[] = [];
  const specSteps: Array<{ spec: GitHubIssue; step: SpecStep }> = [];

  for (const spec of specsInOrder(world.issues)) {
    const plan = await planSpec(deps, spec, jobsByName);
    if (plan === null) continue;

    // `waiting` counts tickets that are inside the label gate but held by a
    // lingering Job object — the k8s half of the Claim-gate (ADR-0013). It is
    // the same shape as Defer: no write, only this counter.
    waiting += plan.waiting;

    const step = planSpecStep({
      spec,
      frontier: plan.frontier,
      openSpecBlockerCount: plan.openSpecBlockerCount,
      jobsByName,
    });

    if (step.kind === "advance") {
      candidates.push({ spec, ticket: step.ticket });
    } else if (step.kind === "start-closeout") {
      closeoutStarts.push(spec);
    } else if (step.kind !== "idle" && step.kind !== "closeout-running" && step.kind !== "out-of-gate") {
      // S3 / S3N / S4 / S5: an outcome to act on. Executed after Claim, so the
      // documented pass order (3 claim → 4 advance → 5 closeout) holds.
      specSteps.push({ spec, step });
    }
  }

  // 3. Claim serially until a Slot is refused or a claim fails.
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

  // 4. Spec advance: the S1 second branch starts the closeout Job. It is a Job
  //    like any other, so it is admitted against the same Slot caps.
  for (const spec of closeoutStarts) {
    const decision = admitSlot(usage, spec.ownerRepo, config);
    if (decision.kind === "defer") {
      deferred += 1;
      continue;
    }
    await startSpecCloseout(specLoopDeps(deps, now), spec);
    usage = occupySlot(usage, closeoutJobName(spec.ownerRepo, spec.number), spec.ownerRepo);
  }

  // 5. Closeout outcome → S3 (PR) / S3N (sub-issues) / S4 / S5.
  for (const { spec, step } of specSteps) {
    await applySpecStep(
      specLoopDeps(deps, now),
      spec,
      step,
      jobsByName.get(closeoutJobName(spec.ownerRepo, spec.number)) ?? null,
      pods,
    );
  }

  return {
    slotsUsed: usage.total,
    slotsMax: config.maxJobsGlobal,
    deferred,
    renewed: 0,
    waiting,
  };
}

function specLoopDeps(deps: ReconcileDeps, now: () => Date): SpecLoopDeps {
  return { github: deps.github, k8s: deps.k8s, config: deps.config, now };
}

/** Candidate order is spec number ascending (determinism, spec #33 §2). */
function specsInOrder(issues: GitHubIssue[]): GitHubIssue[] {
  return issues.filter((issue) => issue.state === "open").sort((a, b) => a.number - b.number);
}

/**
 * What one spec looks like this pass: its Frontier (the S1 branch) plus the
 * reads the spec loop needs to act on the branch it lands in.
 *
 * `waiting` is orthogonal to `frontier`: it counts this spec's tickets that are
 * inside the label gate but held back by a lingering Job object.
 */
interface SpecPlan {
  frontier: FrontierOutcome;
  openSpecBlockerCount: number;
  waiting: number;
}

/**
 * `null` means "not a spec": an issue with no sub-issues drives nothing (spec
 * #33 user story 32 — "having sub-issues is what makes an issue a spec", so no
 * label is needed to tell them apart, and no closeout Job is started for one).
 */
async function planSpec(
  deps: ReconcileDeps,
  spec: GitHubIssue,
  jobsByName: ReadonlyMap<string, K8sJob>,
): Promise<SpecPlan | null> {
  const subIssues = await deps.github.listSubIssues(spec.ownerRepo, spec.number);
  if (subIssues.length === 0) return null;

  const specBlockers = await deps.github.listBlockers(spec.ownerRepo, spec.number);
  const openSpecBlockerCount = specBlockers.filter((blocker) => blocker.state === "open").length;
  const openBlockerCounts = new Map<number, number>();
  for (const issue of subIssues) {
    const blockers = await deps.github.listBlockers(spec.ownerRepo, issue.number);
    openBlockerCounts.set(issue.number, blockers.filter((blocker) => blocker.state === "open").length);
  }

  const waiting = subIssues.filter((issue) => {
    const gateInput = {
      issue,
      openBlockerCount: openBlockerCounts.get(issue.number) ?? 0,
    };
    return (
      claimGate({ ...gateInput, existingJob: jobsByName.get(jobName(spec.ownerRepo, issue.number)) ?? null })
        .passed === false && claimGate({ ...gateInput, existingJob: null }).passed
    );
  }).length;

  const frontier = planFrontier({ ownerRepo: spec.ownerRepo, subIssues, openBlockerCounts, jobsByName });
  return { frontier, openSpecBlockerCount, waiting };
}
