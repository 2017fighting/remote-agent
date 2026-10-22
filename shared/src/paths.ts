/** Volume layout inside a Ticket PVC — image and Job template share these constants. */
export const VOLUME_PATHS = {
  mountRoot: "/mnt/agent",
  repo: "/mnt/agent/repo",
  state: "/mnt/agent/state",
  home: "/mnt/agent/home",
  seedMarker: "/mnt/agent/state/seeded.json",
  seedError: "/mnt/agent/state/seed-error.json",
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
