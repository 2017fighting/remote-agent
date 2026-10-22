/**
 * Annotation keys used by both the App (writer for expiry/token/identity) and the
 * Job (writer for run result).
 *
 * Provenance identity lives here, not in labels: `owner/name` and `owner/name#n`
 * contain `/` and `#`, which a label value may not. An annotation value is free
 * text, so the machine-readable triple stays exact instead of being slugified
 * back into something a reader has to guess at (ADR-0011).
 */
export const ANNOTATIONS = {
  runResult: "remote-agent/run-result",
  expiresAt: "remote-agent/expires-at",
  tokenExpiresAt: "remote-agent/token-expires-at",
  /** `owner/name` the ticket belongs to — what token renewal mints against. */
  repo: "remote-agent/repo",
  /** `owner/name#<issue>` — the ticket identity, provenance for a human/audit. */
  ticket: "remote-agent/ticket",
} as const;

/**
 * Provenance labels on Jobs / Ticket PVCs / per-Job Secrets created by the App.
 *
 * Only values that are legal label values: `managed-by: remote-agent`, a numeric
 * spec number, a role name. `managedBy` is the identity a `pvc-audit` rule can
 * key on; the exact repo/ticket triple is in `ANNOTATIONS`.
 */
export const LABELS = {
  managedBy: "app.kubernetes.io/managed-by",
  managedByValue: "remote-agent",
  spec: "remote-agent/spec",
  role: "remote-agent/role",
} as const;
