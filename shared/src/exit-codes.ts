/**
 * The two exit codes a Job's `podFailurePolicy` keys on (ADR-0009 / ADR-0010).
 *
 * They live here, not in either workspace, because both sides need the same
 * numbers: the Job image exits with them (`job/src/runner.ts`, `job/src/seed.ts`)
 * and the App spells them into the Job manifest's `podFailurePolicy`
 * (`app/src/renders/job-template.ts`). Neither workspace may import the other, so
 * a literal on both sides would be two independent truths about one contract —
 * exactly the drift this module exists to prevent.
 *
 * The values are not arbitrary. `retryable` is the ordinary "k8s starts another
 * pod and it resumes" failure, which takes `backoffLimit`. `fatal` is the class a
 * later pod cannot fix, which the Job's `podFailurePolicy` turns into `FailJob` on
 * the first attempt: the seed's `auth` / `ref_missing` / `disk` failures, and the
 * runner's unreconcilable push. Both phases share one number for that class, since
 * the policy matches per container and one number is easier to keep straight than
 * two.
 */

/** Seed exit codes. Retryable failures take `backoffLimit`; fatal ones FailJob immediately. */
export const SEED_EXIT = {
  retryable: 75,
  fatal: 78,
} as const;

/** Runner exit codes; see the module comment for why `fatal` matches the seed's. */
export const RUNNER_EXIT = {
  retryable: 1,
  fatal: SEED_EXIT.fatal,
} as const;
