/** Annotation keys used by both the App (writer for expiry/token) and the Job (writer for run result). */
export const ANNOTATIONS = {
  runResult: "remote-agent/run-result",
  expiresAt: "remote-agent/expires-at",
  tokenExpiresAt: "remote-agent/token-expires-at",
} as const;

/** Provenance labels on Jobs / Ticket PVCs created by the App. */
export const LABELS = {
  managedBy: "app.kubernetes.io/managed-by",
  managedByValue: "remote-agent",
  ticket: "remote-agent/ticket",
  spec: "remote-agent/spec",
  repo: "remote-agent/repo",
  role: "remote-agent/role",
} as const;
