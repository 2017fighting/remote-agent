import { tokenSecretName } from "@remote-agent/shared";
import {
  isAppManaged,
  volumeReclaimDecision,
  type VolumeStats,
  volumeStats,
} from "./planners/pvc-steward.js";
import { isNotFound } from "./ports/errors.js";
import type { K8sJob, K8sPort, K8sPvc } from "./ports/K8sPort.js";

/**
 * Reclamation step (ADR-0011, spec #33 §2 step 6). Runs **after** Claim and
 * outcome handling in the same pass, so the labels and the `expires-at` clock
 * are already at their end-of-pass values before anything is deleted: a volume
 * claimed this pass has had its expiry cleared, and a volume whose outcome was
 * judged this pass has had its expiry written.
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
  /** Ticket PVCs deleted in this pass. */
  deleted: number;
  /** Volume stats for the pass log line, computed on the post-reclamation world. */
  stats: VolumeStats;
}

export async function reclaimVolumes(deps: ReclaimDeps, pvcs: K8sPvc[], jobs: K8sJob[]): Promise<ReclaimReport> {
  // The Job is terminal-or-not is the only Job fact reclamation reads; Jobs are
  // never written here.
  const liveJobNames = new Set(jobs.filter((job) => !job.finished).map((job) => job.name));

  const remaining: K8sPvc[] = [];
  let deleted = 0;

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
    deleted += 1;
  }

  return { deleted, stats: volumeStats(remaining) };
}

async function deleteIfPresent(remove: () => Promise<void>): Promise<void> {
  try {
    await remove();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}
