import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isSeedMarkerV1,
  SEED_EXIT,
  type SeedErrorV1,
  type SeedFailureKind,
  type SeedMarkerV1,
} from "@remote-agent/shared";
import { runGit, type GitOptions } from "./git.js";
import type { JobPaths, SeedEnv } from "./env.js";

/** ADR-0010: below 3GiB free the same phase would re-hit ENOSPC until backoff or deadline. */
export const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024;

/** What the seed needs from the host, so the entry seam can drive it without a real pod. */
export interface SeedDeps {
  env: SeedEnv;
  paths: JobPaths;
  /** Bytes free on the volume holding `paths.state`. */
  freeBytes(path: string): Promise<number>;
  log(line: string): void;
  now?(): Date;
}

export interface SeedOutcome {
  exitCode: 0 | typeof SEED_EXIT.retryable | typeof SEED_EXIT.fatal;
  kind?: SeedFailureKind;
  detail?: string;
}

/** A classified seed failure: the only way out of `seed()` other than success. */
class SeedFailure extends Error {
  constructor(
    readonly kind: SeedFailureKind,
    detail: string,
  ) {
    super(detail);
  }
}

/**
 * Seed the Ticket PVC's worktree (ADR-0009), idempotently:
 *
 * 1. `df` pre-check — before the marker, so a resumed pod hits the same guard;
 * 2. marker present and matching env → nothing (no fetch, worktree untouched);
 * 3. marker absent: a session means the volume is mid-run → terminal failure;
 *    otherwise the volume is half-seeded → wipe `repo/` and reseed;
 * 4. `git ls-remote` decides whether the spec branch exists;
 * 5. full clone (`--single-branch --branch`) or clone from `origin/main` + `-b`;
 * 6. `git fetch origin main` (the spec role's merge-base needs it);
 * 7. marker written last, atomically.
 *
 * Git only: no dependency install, so the seed stays seconds-long and its
 * failure classes stay git's.
 */
export async function seed(deps: SeedDeps): Promise<SeedOutcome> {
  try {
    await checkDisk(deps);
    const existing = await readMarker(deps.paths.seedMarker);
    if (existing) {
      assertMarkerMatches(existing, deps.env);
      deps.log(`seed-skip repo=${deps.env.repo} branch=${deps.env.branch} reason=marker-present`);
      return { exitCode: 0 };
    }
    await assertNoSession(deps);
    await reseed(deps);
    return { exitCode: 0 };
  } catch (error) {
    const failure = error instanceof SeedFailure ? error : new SeedFailure("unknown", String(error));
    await recordFailure(deps, failure);
    return { exitCode: exitCodeFor(failure.kind), kind: failure.kind, detail: failure.message };
  }
}

/** Fatal classes FailJob at once (podFailurePolicy); the retryable ones take `backoffLimit`.
 * ADR-0009: only network/5xx/429 retry; a wrong repo name or a dead token must be terminal
 * within seconds, so `auth` covers "the credential or the name is wrong". */
export function exitCodeFor(kind: SeedFailureKind): typeof SEED_EXIT.retryable | typeof SEED_EXIT.fatal {
  return kind === "repo_unreachable" ? SEED_EXIT.retryable : SEED_EXIT.fatal;
}

async function checkDisk(deps: SeedDeps): Promise<void> {
  // On a virgin volume `state/` does not exist yet, so the pre-check runs on the
  // mount root the volume actually provides; the three directories come after.
  let free: number;
  try {
    await mkdir(deps.paths.state, { recursive: true });
    free = await deps.freeBytes(deps.paths.state);
  } catch (error) {
    throw new SeedFailure("unknown", `df failed: ${(error as Error).message}`);
  }
  if (free < MIN_FREE_BYTES) {
    throw new SeedFailure("disk", `free=${free} below minimum=${MIN_FREE_BYTES}`);
  }
}

async function readMarker(path: string): Promise<SeedMarkerV1 | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SeedFailure("unknown", `cannot read seed marker: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SeedFailure("unknown", `seed marker at ${path} is not valid JSON`);
  }
  if (!isSeedMarkerV1(parsed)) throw new SeedFailure("unknown", `seed marker at ${path} does not match v1`);
  return parsed;
}

/** A marker from another repo/branch means the volume was claimed by someone else: a human decides. */
function assertMarkerMatches(marker: SeedMarkerV1, env: SeedEnv): void {
  if (marker.repo !== env.repo || marker.branch !== env.branch) {
    throw new SeedFailure(
      "unknown",
      `seed marker mismatch: marker=${marker.repo}@${marker.branch} env=${env.repo}@${env.branch}`,
    );
  }
}

/** A session file on an unmarked volume means work happened there: never reseed over it. */
async function assertNoSession(deps: SeedDeps): Promise<void> {
  const entries = await listState(deps.paths.state);
  const session = entries.filter((name) => name.startsWith("session.sqlite"));
  if (session.length > 0) {
    throw new SeedFailure("unknown", `session present without seed marker: ${session.join(", ")}`);
  }
}

async function listState(stateDir: string): Promise<string[]> {
  try {
    return await readdir(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SeedFailure("unknown", `cannot list ${stateDir}: ${(error as Error).message}`);
  }
}

async function reseed(deps: SeedDeps): Promise<void> {
  await mkdir(deps.paths.repo, { recursive: true });
  await mkdir(deps.paths.state, { recursive: true });
  await mkdir(deps.paths.home, { recursive: true });
  // Half-seeded volume: no marker, no session — the worktree is the only thing to drop.
  await rm(deps.paths.repo, { recursive: true, force: true });
  await mkdir(deps.paths.repo, { recursive: true });

  const gitOptions: GitOptions = {
    cwd: deps.paths.repo,
    tokenPath: deps.paths.token,
    identity: { name: "remote-agent[bot]", email: deps.env.commitEmail },
  };

  const branchExists = await remoteBranchExists(deps, gitOptions);
  const cloneArgs = branchExists
    ? ["clone", "--single-branch", "--branch", deps.env.branch, deps.env.remoteUrl, "."]
    : ["clone", "--single-branch", "--branch", "main", deps.env.remoteUrl, "."];
  const clone = await runGit(cloneArgs, gitOptions);
  if (clone.exitCode !== 0) throw classifyGitFailure(clone.stderr, clone.exitCode, cloneArgs);
  if (!branchExists) {
    const create = await runGit(["checkout", "-b", deps.env.branch], gitOptions);
    if (create.exitCode !== 0) throw classifyGitFailure(create.stderr, create.exitCode, ["checkout", "-b"]);
  }
  // Explicit destination: a `--single-branch` clone has no refspec for main, so a
  // bare `fetch origin main` would only write FETCH_HEAD and leave `origin/main`
  // unresolvable — and the spec role's fixed point is `git merge-base origin/main HEAD`.
  const fetch = await runGit(["fetch", "origin", "main:refs/remotes/origin/main"], gitOptions);
  if (fetch.exitCode !== 0) {
    throw classifyGitFailure(fetch.stderr, fetch.exitCode, ["fetch", "origin", "main"]);
  }

  const head = await runGit(["rev-parse", "HEAD"], gitOptions);
  if (head.exitCode !== 0) throw classifyGitFailure(head.stderr, head.exitCode, ["rev-parse", "HEAD"]);

  const marker: SeedMarkerV1 = {
    v: 1,
    repo: deps.env.repo,
    branch: deps.env.branch,
    seedSha: head.stdout.trim(),
    seededAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await writeMarker(deps.paths.seedMarker, marker);
  deps.log(`seeded repo=${marker.repo} branch=${marker.branch} sha=${marker.seedSha}`);
}

async function remoteBranchExists(deps: SeedDeps, gitOptions: GitOptions): Promise<boolean> {
  // `--exit-code` separates "absent" (2) from auth/network failures, which is why
  // the branch question is asked of git instead of the GitHub API (ADR-0009). No
  // repository exists yet at this point, so the remote URL stands in for `origin`.
  const result = await runGit(
    ["ls-remote", "--exit-code", "--heads", deps.env.remoteUrl, `refs/heads/${deps.env.branch}`],
    gitOptions,
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 2) return false;
  throw classifyGitFailure(result.stderr, result.exitCode, ["ls-remote"]);
}

/** Map git's own words onto the five classes: auth, repo_unreachable, ref_missing, disk, else unknown. */
export function classifyGitFailure(stderr: string, exitCode: number, args: readonly string[]): SeedFailure {
  const text = stderr.toLowerCase();
  const detail = `git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`;
  if (text.includes("remote branch") && text.includes("not found")) {
    return new SeedFailure("ref_missing", detail);
  }
  if (
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("terminal prompts disabled") ||
    text.includes("permission denied") ||
    text.includes("invalid username or password") ||
    // GitHub answers 404 to a repo the credential cannot see, so this is the same
    // fatal, human-fixable case as a mistyped repo name (ADR-0009).
    text.includes("repository not found") ||
    text.includes("not found") ||
    text.includes("does not appear to be a git repository")
  ) {
    return new SeedFailure("auth", detail);
  }
  if (
    text.includes("429") ||
    text.includes("too many requests") ||
    text.includes(" 500") ||
    text.includes(" 502") ||
    text.includes(" 503") ||
    text.includes("could not resolve host") ||
    text.includes("connection") ||
    text.includes("timed out")
  ) {
    return new SeedFailure("repo_unreachable", detail);
  }
  if (text.includes("no space left on device") || text.includes("disk quota")) {
    return new SeedFailure("disk", detail);
  }
  return new SeedFailure("unknown", detail);
}

async function writeMarker(path: string, marker: SeedMarkerV1): Promise<void> {
  // Atomic last step: a marker never describes a half-written worktree.
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function recordFailure(deps: SeedDeps, failure: SeedFailure): Promise<void> {
  deps.log(`seed-failed kind=${failure.kind} detail=${failure.message}`);
  if (exitCodeFor(failure.kind) !== SEED_EXIT.fatal) return;
  const payload: SeedErrorV1 = {
    v: 1,
    kind: failure.kind,
    detail: failure.message,
    failedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  try {
    await mkdir(deps.paths.state, { recursive: true });
    await writeFile(deps.paths.seedError, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (error) {
    deps.log(`seed-error-write-failed detail=${(error as Error).message}`);
  }
}
