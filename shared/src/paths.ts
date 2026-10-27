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
  /**
   * The optional prompt override ConfigMap `remote-agent-prompts-override`
   * (ADR-0020), one file per key. The Job template mounts it with
   * `optional: true` and points `PROMPTS_DIR` at it; when the ConfigMap does not
   * exist the directory is empty and the runner falls back to the image's
   * templates, so the hatch adds no required object.
   */
  promptsOverride: "/mnt/prompts-override",
  /** The per-Job installation token, mounted as a file (ADR-0009): never in env, never in a URL. */
  token: "/mnt/credentials/token",
} as const;

/**
 * The canonical prompt directory baked into the Job image (ADR-0020).
 *
 * `job/Dockerfile` copies the repo's `prompts/` here, and the runner reads it
 * when no override directory (`PROMPTS_DIR`) carries the key. The Dockerfile
 * spells the path out; `job/test/result-tools.test.ts` asserts the COPY stays.
 */
export const IMAGE_PROMPTS_DIR = "/opt/remote-agent/prompts";

/** Marker inside App-posted GitHub comments: `<!-- remote-agent:<kind>:<job-name> -->`. */
export const COMMENT_MARKER_PREFIX = "remote-agent:";

export function commentMarker(kind: "done" | "blocked" | "error" | "evidence", jobName: string): string {
  return `<!-- ${COMMENT_MARKER_PREFIX}${kind}:${jobName} -->`;
}

/** PR head branch for a spec closeout: `agent/spec-<n>`, unique per spec. */
export function specBranch(specNumber: number): string {
  return `agent/spec-${specNumber}`;
}
