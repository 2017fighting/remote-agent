/**
 * Token steward, renewal half (ADR-0009 / ADR-0014). Pure: the Secret's
 * `remote-agent/token-expires-at` value and the pass clock go in, one decision
 * comes out.
 *
 * The judgement reads **only** that annotation. It never looks at the Secret's
 * `metadata.creationTimestamp`: patching `data` does not move it, so after one
 * renewal the age would stay old forever and the judgement would degrade into
 * "re-mint every pass" — the exact shape ADR-0014 rules out (a pod's mounted
 * file lags 1–1.5 minutes, which is enough to read an already-replaced token).
 *
 * A Secret without a readable expiry is renewed once rather than trusted: the
 * App writes that annotation at mint time, so a missing one means the token's
 * remaining life is unknown, and the next pass reads the value this renewal
 * wrote. That self-heals without ever minting twice for the same Secret in one
 * pass (the step dedupes by Secret name).
 */

/** Renew when less than 30 minutes of life remain (spec #33 budgets, ADR-0014). */
export const TOKEN_RENEWAL_THRESHOLD_SECONDS = 1800;

export type TokenRenewalDecision =
  | { kind: "renew"; reason: "expiring" | "no-expiry" }
  | { kind: "keep"; remainingSeconds: number };

export interface TokenRenewalInput {
  /** `remote-agent/token-expires-at`, RFC3339 as GitHub returned it; undefined when absent. */
  tokenExpiresAt: string | undefined;
  now: Date;
}

export function tokenRenewalDecision(input: TokenRenewalInput): TokenRenewalDecision {
  const expiresAtMs = input.tokenExpiresAt === undefined ? Number.NaN : Date.parse(input.tokenExpiresAt);
  if (Number.isNaN(expiresAtMs)) return { kind: "renew", reason: "no-expiry" };

  const remainingSeconds = Math.floor((expiresAtMs - input.now.getTime()) / 1000);
  // An already-expired token renews for the same reason an expiring one does.
  if (remainingSeconds < TOKEN_RENEWAL_THRESHOLD_SECONDS) return { kind: "renew", reason: "expiring" };
  return { kind: "keep", remainingSeconds };
}
