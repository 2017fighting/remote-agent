/** Volume layout inside a Ticket PVC — image and Job template share these constants. */
export const VOLUME_PATHS = {
  mountRoot: "/mnt/agent",
  repo: "/mnt/agent/repo",
  state: "/mnt/agent/state",
  home: "/mnt/agent/home",
  seedMarker: "/mnt/agent/state/seeded.json",
  seedError: "/mnt/agent/state/seed-error.json",
  /** durable's SQLite storage: WAL + `-wal`/`-shm` siblings, never inside the git worktree. */
  sessionDatabase: "/mnt/agent/state/session.sqlite",
} as const;

/** Mounts that are not part of the Ticket PVC. */
export const JOB_MOUNT_PATHS = {
  /** The prompt ConfigMap `remote-agent-prompts`, one file per key (ADR-0004). */
  prompts: "/mnt/prompts",
  /** The per-Job installation token, mounted as a file (ADR-0009): never in env, never in a URL. */
  token: "/mnt/credentials/token",
} as const;

/** Marker inside App-posted GitHub comments: `<!-- remote-agent:<kind>:<job-name> -->`. */
export const COMMENT_MARKER_PREFIX = "remote-agent:";

export function commentMarker(kind: "done" | "blocked" | "error" | "evidence", jobName: string): string {
  return `<!-- ${COMMENT_MARKER_PREFIX}${kind}:${jobName} -->`;
}

/** PR head branch for a spec closeout: `agent/spec-<n>`, unique per spec. */
export function specBranch(specNumber: number): string {
  return `agent/spec-${specNumber}`;
}
