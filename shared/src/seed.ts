/**
 * Seed contract: the idempotence marker `state/seeded.json` and the five failure
 * classes. The exit codes those classes map onto live in `exit-codes.ts`, beside
 * the runner's, because the App spells both into the Job manifest.
 */
export interface SeedMarkerV1 {
  v: 1;
  /** Target repo as `owner/name`. */
  repo: string;
  /** `agent/spec-<n>` — the branch the worktree was cloned onto. */
  branch: string;
  /** The commit the seed ended on; evidence for a human, not a resume point. */
  seedSha: string;
  /** ISO-8601. */
  seededAt: string;
}

export function isSeedMarkerV1(value: unknown): value is SeedMarkerV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["v"] === 1 &&
    typeof v["repo"] === "string" &&
    typeof v["branch"] === "string" &&
    typeof v["seedSha"] === "string" &&
    typeof v["seededAt"] === "string"
  );
}

/** Why a seed failed. `auth`/`repo_unreachable`/`ref_missing`/`disk`/`unknown` (ADR-0009). */
export type SeedFailureKind = "auth" | "repo_unreachable" | "ref_missing" | "disk" | "unknown";

export const SEED_FAILURE_KINDS: readonly SeedFailureKind[] = [
  "auth",
  "repo_unreachable",
  "ref_missing",
  "disk",
  "unknown",
];

export interface SeedErrorV1 {
  v: 1;
  kind: SeedFailureKind;
  detail: string;
  failedAt: string;
}
