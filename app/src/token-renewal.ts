import { ANNOTATIONS, LABELS, tokenSecretName } from "@remote-agent/shared";
import { TOKEN_SECRET_KEY } from "./renders/job-template.js";
import { tokenRenewalDecision } from "./planners/token-steward.js";
import type { GitHubPort } from "./ports/GitHubPort.js";
import type { K8sJob, K8sPort } from "./ports/K8sPort.js";

/**
 * Token renewal step (ADR-0009 / ADR-0014, spec #33 §2 step 6 half). Runs once
 * per pass, over the Jobs that are still running: for each, read the per-Job
 * Secret's `remote-agent/token-expires-at` and re-mint only when less than 30
 * minutes remain, patching the Secret in place.
 *
 * Two properties are structural:
 *
 * - **The decision reads the annotation only** (see `planners/token-steward.ts`).
 *   `creationTimestamp` is never consulted: a patch does not move it, so it
 *   would degrade into re-minting every pass.
 * - **At most one mint per Secret per pass.** Jobs are unique by name, so the
 *   `renewedSecrets` guard is what makes the invariant explicit rather than
 *   incidental.
 *
 * The mounted file lags a renewal by 1–1.5 minutes (kubelet sync), which is why
 * the threshold is 30 minutes and not something close to the 60-minute lifetime.
 * A finished Job needs no token: nothing reads it any more.
 */

export interface TokenRenewalDeps {
  github: GitHubPort;
  k8s: K8sPort;
  /** One instant for the whole pass, shared with reclamation. */
  now: Date;
}

/** How many Secrets were re-minted and patched in this pass (the `renewed` counter). */
export async function renewTokens(deps: TokenRenewalDeps, jobs: K8sJob[]): Promise<number> {
  const renewedSecrets = new Set<string>();
  let renewed = 0;

  for (const job of jobs) {
    if (job.finished) continue;
    if (job.labels[LABELS.managedBy] !== LABELS.managedByValue) continue;

    const name = tokenSecretName(job.name);
    if (renewedSecrets.has(name)) continue;
    const secret = await deps.k8s.getSecret(name);
    // No Secret = no credential to renew. Creating one here would widen the
    // App's write surface for a shape Claim owns.
    if (secret === null) continue;

    const decision = tokenRenewalDecision({
      tokenExpiresAt: secret.annotations[ANNOTATIONS.tokenExpiresAt],
      now: deps.now,
    });
    if (decision.kind === "keep") continue;

    const ownerRepo = job.annotations[ANNOTATIONS.repo];
    // Without the target repo there is nothing to scope a token to; the Job is
    // then not one the App can renew.
    if (ownerRepo === undefined) continue;

    const minted = await deps.github.mintInstallationToken(ownerRepo);
    await deps.k8s.patchSecret(name, {
      data: { [TOKEN_SECRET_KEY]: minted.token },
      annotations: { [ANNOTATIONS.tokenExpiresAt]: minted.expiresAt },
    });
    renewedSecrets.add(name);
    renewed += 1;
  }

  return renewed;
}
