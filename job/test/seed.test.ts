import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_EXIT, type SeedErrorV1, type SeedMarkerV1 } from "@remote-agent/shared";
import { seed, MIN_FREE_BYTES, exitCodeFor } from "../src/internal/seed.js";
import { jobPaths, type SeedEnv } from "../src/internal/env.js";

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
    },
  });
  return stdout.trim();
}

interface Fixture {
  root: string;
  /** Bare repo acting as `origin` — a real git remote, not a stub. */
  remote: string;
  paths: ReturnType<typeof jobPaths>;
  env: SeedEnv;
  tokenPath: string;
}

/**
 * A local bare remote plus the volume-shaped directory tree the seed expects.
 * `withSpecBranch` decides whether `agent/spec-<n>` already exists.
 */
async function fixture(options: { withSpecBranch: boolean } = { withSpecBranch: false }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "remote-agent-seed-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "origin.git");
  const seedWork = join(root, "seed-work");
  await mkdir(remote, { recursive: true });
  await mkdir(seedWork, { recursive: true });
  await git(["init", "--bare", "--initial-branch=main", remote], root);
  await git(["init", "--initial-branch=main", seedWork], root);
  await writeFile(join(seedWork, "README.md"), "hello\n");
  await git(["add", "-A"], seedWork);
  await git(["commit", "-m", "init"], seedWork);
  await git(["remote", "add", "origin", remote], seedWork);
  await git(["push", "origin", "main"], seedWork);
  if (options.withSpecBranch) {
    await git(["checkout", "-b", "agent/spec-33"], seedWork);
    await writeFile(join(seedWork, "work.txt"), "work\n");
    await git(["add", "-A"], seedWork);
    await git(["commit", "-m", "work"], seedWork);
    await git(["push", "origin", "agent/spec-33"], seedWork);
    await git(["checkout", "main"], seedWork);
  }
  const volume = join(root, "volume");
  await mkdir(join(volume, "state"), { recursive: true });
  await mkdir(join(volume, "home"), { recursive: true });
  const paths = jobPaths({
    repo: join(volume, "repo"),
    state: join(volume, "state"),
    home: join(volume, "home"),
    seedMarker: join(volume, "state", "seeded.json"),
    seedError: join(volume, "state", "seed-error.json"),
    sessionDatabase: join(volume, "state", "session.sqlite"),
    token: join(volume, "token"),
  });
  await writeFile(paths.token, "ghs_test_token\n");
  const env: SeedEnv = {
    repo: "2017fighting/remote-agent",
    specNumber: 33,
    branch: "agent/spec-33",
    remoteUrl: remote,
    commitEmail: "5390512+remote-agent[bot]@users.noreply.github.com",
  };
  return { root, remote, paths, env, tokenPath: paths.token };
}

function seedDeps(f: Fixture, overrides: { freeBytes?: number; log?: string[] } = {}) {
  const lines = overrides.log ?? [];
  return {
    env: f.env,
    paths: f.paths,
    freeBytes: async () => overrides.freeBytes ?? MIN_FREE_BYTES * 2,
    log: (line: string) => lines.push(line),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  };
}

describe("seed", () => {
  it("clones the spec branch and writes the marker last", async () => {
    const f = await fixture({ withSpecBranch: true });
    const log: string[] = [];
    const outcome = await seed(seedDeps(f, { log }));
    expect(outcome.exitCode).toBe(0);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], f.paths.repo)).toBe("agent/spec-33");
    // origin/main is fetched so the spec role's merge-base resolves locally.
    expect(await git(["rev-parse", "--verify", "origin/main"], f.paths.repo)).toMatch(/^[0-9a-f]{40}$/);
    const marker = JSON.parse(await readFile(f.paths.seedMarker, "utf8")) as SeedMarkerV1;
    expect(marker).toMatchObject({ v: 1, repo: f.env.repo, branch: f.env.branch });
    expect(marker.seedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(marker.seededAt).toBe("2026-01-02T03:04:05.000Z");
    expect(log.join("\n")).toContain("seeded repo=");
  });

  it("starts the spec branch from origin/main when it does not exist yet", async () => {
    const f = await fixture({ withSpecBranch: false });
    const outcome = await seed(seedDeps(f));
    expect(outcome.exitCode).toBe(0);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], f.paths.repo)).toBe("agent/spec-33");
    const mainSha = await git(["rev-parse", "main"], f.root + "/seed-work");
    expect(await git(["rev-parse", "HEAD"], f.paths.repo)).toBe(mainSha);
    // The branch was created locally, so the remote still has no such ref.
    await expect(git(["rev-parse", "--verify", "origin/agent/spec-33"], f.paths.repo)).rejects.toThrow();
  });

  it("does nothing on an already-seeded volume, preserving uncommitted work", async () => {
    const f = await fixture({ withSpecBranch: true });
    expect((await seed(seedDeps(f))).exitCode).toBe(0);
    const markerBefore = await readFile(f.paths.seedMarker, "utf8");

    // Dirt the worktree and the session storage, then reseed.
    await writeFile(join(f.paths.repo, "README.md"), "locally modified\n");
    await writeFile(join(f.paths.repo, "untracked.txt"), "keep me\n");
    await writeFile(f.paths.sessionDatabase, "session-bytes\n");
    // Advance the remote: a no-op seed must not fetch it.
    const advanced = await git(["rev-parse", "HEAD"], f.root + "/seed-work");
    const before = await git(["rev-parse", "HEAD"], f.paths.repo);

    const log: string[] = [];
    const outcome = await seed(seedDeps(f, { log }));
    expect(outcome.exitCode).toBe(0);
    expect(log.join("\n")).toContain("seed-skip");
    expect(log.join("\n")).not.toContain("fetch");
    expect(await readFile(f.paths.seedMarker, "utf8")).toBe(markerBefore);
    expect(await readFile(join(f.paths.repo, "README.md"), "utf8")).toBe("locally modified\n");
    expect(await readFile(join(f.paths.repo, "untracked.txt"), "utf8")).toBe("keep me\n");
    expect(await readFile(f.paths.sessionDatabase, "utf8")).toBe("session-bytes\n");
    expect(await git(["rev-parse", "HEAD"], f.paths.repo)).toBe(before);
    expect(await git(["rev-parse", "HEAD"], f.root + "/seed-work")).toBe(advanced);
  });

  it("fails terminally when the marker disagrees with the Job env and a session exists", async () => {
    const f = await fixture({ withSpecBranch: true });
    expect((await seed(seedDeps(f))).exitCode).toBe(0);
    await writeFile(f.paths.sessionDatabase, "session-bytes\n");
    const marker = JSON.parse(await readFile(f.paths.seedMarker, "utf8")) as SeedMarkerV1;
    await writeFile(f.paths.seedMarker, JSON.stringify({ ...marker, branch: "agent/spec-99" }));

    const log: string[] = [];
    const outcome = await seed(seedDeps(f, { log }));
    expect(outcome.exitCode).toBe(SEED_EXIT.fatal);
    expect(outcome.kind).toBe("unknown");
    expect(log.join("\n")).toContain("seed-failed kind=unknown detail=seed marker mismatch");
    // Nothing was reseeded: the marker, the session and the worktree are untouched.
    expect(JSON.parse(await readFile(f.paths.seedMarker, "utf8")).branch).toBe("agent/spec-99");
    expect(await readFile(f.paths.sessionDatabase, "utf8")).toBe("session-bytes\n");
  });

  it("fails terminally when a session exists without any marker", async () => {
    const f = await fixture({ withSpecBranch: true });
    await mkdir(f.paths.state, { recursive: true });
    await writeFile(f.paths.sessionDatabase, "session-bytes\n");
    const outcome = await seed(seedDeps(f));
    expect(outcome.exitCode).toBe(SEED_EXIT.fatal);
    expect(outcome.detail).toContain("session present without seed marker");
    expect(await readFile(f.paths.sessionDatabase, "utf8")).toBe("session-bytes\n");
  });

  it("reseeds a half-seeded volume: no marker and no session means nothing to lose", async () => {
    const f = await fixture({ withSpecBranch: true });
    await mkdir(f.paths.repo, { recursive: true });
    await writeFile(join(f.paths.repo, "junk.txt"), "half seeded\n");
    const outcome = await seed(seedDeps(f));
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(join(f.paths.repo, "junk.txt"))).toBe(false);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], f.paths.repo)).toBe("agent/spec-33");
  });

  it("checks free disk before the marker, so a resumed pod hits the same guard", async () => {
    const f = await fixture({ withSpecBranch: true });
    expect((await seed(seedDeps(f))).exitCode).toBe(0);
    const log: string[] = [];
    const outcome = await seed(seedDeps(f, { log, freeBytes: MIN_FREE_BYTES - 1 }));
    expect(outcome.exitCode).toBe(SEED_EXIT.fatal);
    expect(outcome.kind).toBe("disk");
    expect(log.join("\n")).not.toContain("seed-skip");
    const error = JSON.parse(await readFile(f.paths.seedError, "utf8")) as SeedErrorV1;
    expect(error.kind).toBe("disk");
  });

  it("writes state/seed-error.json and one seed-failed line for every fatal class", async () => {
    const f = await fixture({ withSpecBranch: true });
    const outcome = await seed(seedDeps(f, { freeBytes: 0 }));
    expect(outcome.exitCode).toBe(SEED_EXIT.fatal);
    expect(await stat(f.paths.seedError)).toBeTruthy();
    const error = JSON.parse(await readFile(f.paths.seedError, "utf8")) as SeedErrorV1;
    expect(error).toMatchObject({ v: 1, kind: "disk" });
    expect(error.failedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("maps the five failure classes onto the two exit codes", () => {
    expect(exitCodeFor("repo_unreachable")).toBe(SEED_EXIT.retryable);
    for (const kind of ["auth", "ref_missing", "disk", "unknown"] as const) {
      expect(exitCodeFor(kind)).toBe(SEED_EXIT.fatal);
    }
  });

  it("classifies a missing repository as fatal auth, not as a retryable network error", async () => {
    const f = await fixture({ withSpecBranch: true });
    const outcome = await seed(seedDeps({ ...f, env: { ...f.env, remoteUrl: join(f.root, "no-such-repo.git") } }));
    expect(outcome.exitCode).toBe(SEED_EXIT.fatal);
    expect(outcome.kind).toBe("auth");
  });

  it("classifies an unreachable remote as retryable", async () => {
    const f = await fixture({ withSpecBranch: true });
    // A host that cannot resolve fails in milliseconds and never touches the network.
    const outcome = await seed(
      seedDeps({ ...f, env: { ...f.env, remoteUrl: "https://nonexistent.invalid/owner/repo.git" } }),
    );
    expect(outcome.exitCode).toBe(SEED_EXIT.retryable);
    expect(outcome.kind).toBe("repo_unreachable");
  });

  it("does not leave a seed-error file behind for a retryable failure", async () => {
    const f = await fixture({ withSpecBranch: true });
    await seed(seedDeps({ ...f, env: { ...f.env, remoteUrl: "https://nonexistent.invalid/owner/repo.git" } }));
    await expect(stat(f.paths.seedError)).rejects.toThrow();
  });
});
