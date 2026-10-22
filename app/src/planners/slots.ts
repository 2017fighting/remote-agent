import { ANNOTATIONS, LABELS } from "@remote-agent/shared";
import type { K8sJob, K8sPod } from "../ports/K8sPort.js";

/**
 * Slot accounting (docs/architecture.md §5, spec #33 §1 `slots`). Pure.
 *
 * A Job holds one Slot while any pod it owns is non-terminal — **Terminating
 * counts** (a pod being deleted still occupies its Slot until it is gone).
 * Terminal pods release the Slot; so does a Job with no pods at all (a Job in
 * its retention window holds nothing).
 *
 * Occupancy is counted per Job (pods grouped by ownerReferences), so a Job
 * restarting its pod never double-counts, and a Job is counted per target repo
 * by its `remote-agent/repo` annotation (`owner/name` is not a legal label
 * value, ADR-0011).
 */

export interface SlotUsage {
  /** Jobs currently holding a Slot, by name. */
  holdingJobNames: string[];
  /** Used Slots per target repo (`owner/name`). */
  perRepo: Map<string, number>;
  total: number;
}

export function countSlotUsage(jobs: K8sJob[], pods: K8sPod[]): SlotUsage {
  const managedJobs = new Map(
    jobs
      .filter((job) => job.labels[LABELS.managedBy] === LABELS.managedByValue)
      .map((job) => [job.name, job]),
  );

  const holdingJobNames = new Set<string>();
  for (const pod of pods) {
    if (!pod.ownerJobName) continue;
    if (!managedJobs.has(pod.ownerJobName)) continue;
    if (pod.phase === "Succeeded" || pod.phase === "Failed") continue;
    holdingJobNames.add(pod.ownerJobName);
  }

  const perRepo = new Map<string, number>();
  for (const name of holdingJobNames) {
    const repo = managedJobs.get(name)?.annotations[ANNOTATIONS.repo];
    if (!repo) continue;
    perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
  }

  return { holdingJobNames: [...holdingJobNames].sort(), perRepo, total: holdingJobNames.size };
}

export interface SlotLimits {
  maxJobsGlobal: number;
  maxJobsPerRepo: number;
}

export type SlotDecision =
  | { kind: "admit" }
  | { kind: "defer"; reason: "global-limit" | "repo-limit" };

/**
 * Can one more Job for `targetRepo` start? Lowering a limit never kills a
 * running Job — it only stops new ones, which is why this is a pure read of the
 * current occupancy plus the configured caps.
 */
export function admitSlot(usage: SlotUsage, targetRepo: string, limits: SlotLimits): SlotDecision {
  if (usage.total >= limits.maxJobsGlobal) return { kind: "defer", reason: "global-limit" };
  if ((usage.perRepo.get(targetRepo) ?? 0) >= limits.maxJobsPerRepo) {
    return { kind: "defer", reason: "repo-limit" };
  }
  return { kind: "admit" };
}

/** Record an admitted Job so later candidates in the same pass see it (the pass admits serially). */
export function occupySlot(usage: SlotUsage, jobName: string, targetRepo: string): SlotUsage {
  const perRepo = new Map(usage.perRepo);
  perRepo.set(targetRepo, (perRepo.get(targetRepo) ?? 0) + 1);
  return {
    holdingJobNames: [...usage.holdingJobNames, jobName].sort(),
    perRepo,
    total: usage.total + 1,
  };
}
