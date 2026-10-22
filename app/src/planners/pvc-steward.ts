import { ANNOTATIONS, LABELS } from "@remote-agent/shared";
import type { K8sPvc } from "../ports/K8sPort.js";

/**
 * PVC steward, reclamation half (ADR-0011). Pure: the volume as the world
 * reports it, the pass clock and the set of Jobs that are not terminal yet go
 * in, one decision comes out.
 *
 * The table this encodes (ADR-0011 "回收表"):
 *
 * ```
 * expires-at set and passed                → delete   (expired)
 * expires-at set and still in the future   → keep
 * expires-at absent ∧ a non-terminal Job   → keep     (claimed, in flight)
 * expires-at absent ∧ no such Job ∧ age>30d → delete   (orphan)
 * expires-at absent ∧ no such Job ∧ age≤30d → keep
 * ```
 *
 * `expires-at` absent means "not deletable" — it is cleared at Claim time and
 * written only when an outcome was judged, so its absence is the T3 / T3L
 * shape. The orphan fallback covers the two shapes that never reach an outcome
 * (issue deleted or transferred away, or the App never read the result before
 * the Job was garbage-collected by its TTL); the 30-day floor is also the
 * safety pad for the window between Claim and Job creation.
 *
 * Only the orphan fallback looks at `creationTimestamp`, and only as an age
 * floor. A volume with a live Job is never orphan-deleted.
 */

/** Orphan floor (ADR-0011): no `expires-at`, no live Job, older than this. */
export const ORPHAN_MIN_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type VolumeReclaimDecision =
  | { kind: "delete"; reason: "expired" | "orphan" }
  | {
      kind: "keep";
      reason: "unexpired" | "live-job" | "young-orphan" | "unknown-age" | "unreadable-expiry";
    };

export interface VolumeReclaimInput {
  pvc: K8sPvc;
  /** The pass clock — the same instant the outcome step judged with. */
  now: Date;
  /** Names of Jobs that are not terminal; the Ticket PVC shares its Job's name. */
  liveJobNames: ReadonlySet<string>;
}

export function volumeReclaimDecision(input: VolumeReclaimInput): VolumeReclaimDecision {
  const { pvc, now, liveJobNames } = input;
  const rawExpiry = pvc.annotations[ANNOTATIONS.expiresAt];

  if (rawExpiry !== undefined) {
    const expiresAtMs = Date.parse(rawExpiry);
    // A value the App wrote but cannot read is not a licence to delete: keep it
    // and let the volume-stats line surface it.
    if (Number.isNaN(expiresAtMs)) return { kind: "keep", reason: "unreadable-expiry" };
    if (expiresAtMs <= now.getTime()) return { kind: "delete", reason: "expired" };
    return { kind: "keep", reason: "unexpired" };
  }

  if (liveJobNames.has(pvc.name)) return { kind: "keep", reason: "live-job" };

  const createdAtMs = pvc.creationTimestamp === undefined ? Number.NaN : Date.parse(pvc.creationTimestamp);
  if (Number.isNaN(createdAtMs)) return { kind: "keep", reason: "unknown-age" };

  const ageMs = now.getTime() - createdAtMs;
  if (ageMs > ORPHAN_MIN_AGE_DAYS * DAY_MS) return { kind: "delete", reason: "orphan" };
  return { kind: "keep", reason: "young-orphan" };
}

/** True for the objects the App itself created (ADR-0011 provenance labels). */
export function isAppManaged(object: { labels: Record<string, string> }): boolean {
  return object.labels[LABELS.managedBy] === LABELS.managedByValue;
}

/**
 * The one line per pass that makes leaks visible (ADR-0011): Delete-policy
 * volumes disappear from `pv-audit`, and provenance labels take them out of
 * `pvc-audit`, so the App has to report its own volume usage.
 */
export interface VolumeStats {
  /** Volumes the App still owns after this pass's reclamation. */
  live: number;
  /** Earliest `expires-at` among them, RFC3339; null when none carries one. */
  oldestExpiry: string | null;
  /** Live volume count per `remote-agent/spec` label, spec number ascending. */
  perSpec: Array<{ spec: string; count: number }>;
}

export function volumeStats(pvcs: K8sPvc[]): VolumeStats {
  const live = pvcs.filter(isAppManaged);

  let oldestExpiryMs: number | null = null;
  const perSpecCounts = new Map<string, number>();
  for (const pvc of live) {
    const rawExpiry = pvc.annotations[ANNOTATIONS.expiresAt];
    if (rawExpiry !== undefined) {
      const expiresAtMs = Date.parse(rawExpiry);
      if (!Number.isNaN(expiresAtMs) && (oldestExpiryMs === null || expiresAtMs < oldestExpiryMs)) {
        oldestExpiryMs = expiresAtMs;
      }
    }
    const spec = pvc.labels[LABELS.spec];
    if (spec !== undefined) perSpecCounts.set(spec, (perSpecCounts.get(spec) ?? 0) + 1);
  }

  return {
    live: live.length,
    oldestExpiry: oldestExpiryMs === null ? null : new Date(oldestExpiryMs).toISOString(),
    perSpec: [...perSpecCounts.entries()]
      .map(([spec, count]) => ({ spec, count }))
      .sort((a, b) => Number(a.spec) - Number(b.spec)),
  };
}
