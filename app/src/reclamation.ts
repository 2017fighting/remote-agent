import { tokenSecretName } from "@remote-agent/shared";
import {
  isAppManaged,
  volumeReclaimDecision,
  type VolumeStats,
  volumeStats,
} from "./planners/pvc-steward.js";
import { isNotFound } from "./ports/errors.js";
import type { K8sPort, K8sPvc } from "./ports/K8sPort.js";

/**
 * Reclamation step (ADR-0011, spec #33 §2 step 6). Runs **after** Claim and
 * outcome handling in the same pass, and re-reads the volumes and Jobs it
 * judges: the labels, the Job objects and the `expires-at` clock are then at
 * their end-of-pass values before anything is deleted. A volume claimed this
 * pass has had its expiry cleared and has a live Job under its own name; a
 * volume whose outcome was judged this pass carries a fresh retention clock.
 * Judging the pass-start snapshot instead would let the same pass claim a
 * volume and delete it, or delete a volume whose outcome just moved its clock.
 *
 * Two objects per reclaimed ticket, and nothing else: the Ticket PVC and its
 * same-named per-Job Secret (`agent-<repo-slug>-<issue#>-token`). The Job is
 * **not** touched — `ttlSecondsAfterFinished` is the only Job deleter
 * (ADR-0012), and the App has no Job delete/patch on its RBAC.
 *
 * Only volumes carrying the App's provenance label are considered, so a foreign
 * PVC that happens to sit in the namespace can never be deleted by this step.
 * A 404 on delete is success: the object being gone is the intent.
 */

export interface ReclaimDeps {
  k8s: K8sPort;
  /** One instant for the whole pass, shared with token renewal. */
  now: Date;
}

export interface ReclaimReport {
  /** Volume stats for the pass log line, computed on the post-reclamation world. */
  stats: VolumeStats;
}

export async function reclaimVolumes(deps: ReclaimDeps): Promise<ReclaimReport> {
  // Read here rather than reusing the pass-start snapshot: Claim may have
  // created a Job and cleared an expiry since. Whether a Job is terminal is the
  // only Job fact this step reads, and Jobs are never written here.
  const [pvcs, jobs] = await Promise.all([deps.k8s.listPvcs(), deps.k8s.listJobs()]);
  const liveJobNames = new Set(jobs.filter((job) => !job.finished).map((job) => job.name));

  const remaining: K8sPvc[] = [];

  for (const pvc of pvcs) {
    if (!isAppManaged(pvc)) {
      remaining.push(pvc);
      continue;
    }
    const decision = volumeReclaimDecision({ pvc, now: deps.now, liveJobNames });
    if (decision.kind === "keep") {
      remaining.push(pvc);
      continue;
    }
    await deleteIfPresent(() => deps.k8s.deletePvc(pvc.name));
    // The credential dies with the volume it belongs to (ADR-0011).
    await deleteIfPresent(() => deps.k8s.deleteSecret(tokenSecretName(pvc.name)));
  }

  return { stats: volumeStats(remaining) };
}

async function deleteIfPresent(remove: () => Promise<void>): Promise<void> {
  try {
    await remove();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}
