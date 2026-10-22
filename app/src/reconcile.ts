import type { AppConfig } from "./config.js";
import type { GitHubPort } from "./ports/GitHubPort.js";
import type { K8sJob, K8sPod, K8sPort, K8sPvc } from "./ports/K8sPort.js";
import { LABELS } from "@remote-agent/shared";
import type { Trigger } from "./scheduler.js";

/** Everything one pass reads; rebuilt from scratch every pass (ADR-0001). Secrets are read by deterministic name (RBAC has no secrets list). */
export interface WorldSnapshot {
  issues: Awaited<ReturnType<GitHubPort["listIssues"]>>;
  jobs: K8sJob[];
  pods: K8sPod[];
  pvcs: K8sPvc[];
}

export interface PassCounters {
  slotsUsed: number;
  slotsMax: number;
  deferred: number;
  renewed: number;
  waiting: number;
}

export interface ReconcileDeps {
  github: GitHubPort;
  k8s: K8sPort;
  config: AppConfig;
  /** Test observation hook: called once per pass with the freshly read world. */
  onWorldRead?: (world: WorldSnapshot) => void;
}

/**
 * One reconcile pass (spec #33 §2): read world → plan → execute → counters.
 * Stateless across passes — every pass rebuilds its view from GitHub and k8s;
 * nothing is cached between passes. In #34 the plan is always empty (planners
 * arrive in #35–#38), so the pass reads the world, holds its Slot accounting,
 * and executes no writes. Replayability therefore holds trivially now and
 * every later ticket must keep it: a second pass over an unchanged world must
 * produce zero new external writes.
 */
export async function runReconcilePass(deps: ReconcileDeps, _trigger: Trigger): Promise<PassCounters> {
  const { github, k8s, config } = deps;

  // 1. Read the world: issues, Jobs, pods, PVCs.
  const [issues, jobs, pods, pvcs] = await Promise.all([
    github.listIssues(),
    k8s.listJobs(),
    k8s.listPods(),
    k8s.listPvcs(),
  ]);
  const world: WorldSnapshot = { issues, jobs, pods, pvcs };
  deps.onWorldRead?.(world);

  // 2. Plan. This ticket has no planners yet; the plan is always empty.
  // 3. Execute. An empty plan performs no writes.
  // 4. Counters. Slots: a managed Job holds a Slot while it has any
  //    non-terminal pod (Terminating counts — spec #33 §1 `slots`).
  const slotsUsed = countUsedSlots(jobs, pods);
  const slotsMax = config.maxJobsGlobal;

  return {
    slotsUsed,
    slotsMax,
    deferred: 0,
    renewed: 0,
    waiting: 0,
  };
}

function countUsedSlots(jobs: K8sJob[], pods: K8sPod[]): number {
  const managedJobNames = new Set(
    jobs
      .filter((j) => j.labels[LABELS.managedBy] === LABELS.managedByValue)
      .map((j) => j.name),
  );
  const holders = new Set<string>();
  for (const pod of pods) {
    if (!pod.ownerJobName) continue;
    if (!managedJobNames.has(pod.ownerJobName)) continue;
    holders.add(pod.ownerJobName);
  }
  return holders.size;
}
