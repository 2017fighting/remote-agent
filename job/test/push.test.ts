import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_EXIT } from "@remote-agent/shared";
import { FatalPushError, RUNNER_EXIT, pushExitCodeFor, pushToSpecBranch } from "../src/internal/runner.js";
import { cleanup, git, runnerFixture, type RunnerFixture } from "./support/runner-fixture.js";

/**
 * The push's own decision surface. The branch is named per **spec**, not per
 * ticket, so two tickets of one spec write the same ref and whoever pushes second
 * meets a moved branch (#55). These tests drive `pushToSpecBranch()` against a
 * real bare remote, because the thing under test is git's behaviour on a
 * non-fast-forward, not a mock's.
 */

let fixture: RunnerFixture | undefined;
afterEach(async () => {
  await cleanup(fixture);
  fixture = undefined;
});

/** A second clone of the bare remote, standing in for the ticket that pushed first. */
async function otherTicket(f: RunnerFixture): Promise<string> {
  const other = join(f.root, "other");
  await git(["clone", f.remote, other], f.root);
  await git(["checkout", "-B", "agent/spec-33", "origin/agent/spec-33"], other);
  return other;
}

/** Commit one file in a worktree and return the new HEAD. */
async function commit(worktree: string, name: string, body: string): Promise<string> {
  await writeFile(join(worktree, name), body);
  await git(["add", "-A"], worktree);
  await git(["commit", "-m", `work ${name}`], worktree);
  return git(["rev-parse", "HEAD"], worktree);
}

describe("push: a branch that another ticket already moved", () => {
  it("rebases our work onto the branch tip instead of being rejected", async () => {
    fixture = await runnerFixture();
    const other = await otherTicket(fixture);
    await commit(other, "theirs.txt", "theirs\n");
    await git(["push", "origin", "HEAD:refs/heads/agent/spec-33"], other);
    const theirs = await git(["rev-parse", "HEAD"], other);

    // Our own work, committed against the older tip.
    const ours = await commit(fixture.worktree, "ours.txt", "ours\n");

    await pushToSpecBranch({ env: fixture.env, paths: fixture.paths, log: () => {} });

    const pushed = await git(["rev-parse", "agent/spec-33"], fixture.remote);
    // Both landed, theirs first.
    const subjects = (await git(["log", "--format=%s", "agent/spec-33"], fixture.remote)).split("\n");
    expect(subjects.slice(0, 2)).toEqual(["work ours.txt", "work theirs.txt"]);
    // Our commit was replayed onto their tip, so the pushed tip is a new commit…
    expect(pushed).not.toBe(ours);
    // …that carries both files, and still contains their commit.
    expect(await git(["ls-tree", "--name-only", pushed], fixture.remote)).toBe("README.md\nours.txt\ntheirs.txt");
    expect(await git(["merge-base", "--is-ancestor", theirs, pushed], fixture.remote)).toBe("");
  });

  it("pushes straight through when nothing moved", async () => {
    fixture = await runnerFixture();
    const head = await commit(fixture.worktree, "ours.txt", "ours\n");
    await pushToSpecBranch({ env: fixture.env, paths: fixture.paths, log: () => {} });
    // An untouched branch means no rewrite: the commit is pushed as it was made.
    expect(await git(["rev-parse", "agent/spec-33"], fixture.remote)).toBe(head);
  });

  it("pushes the first commit to a branch that does not exist yet", async () => {
    fixture = await runnerFixture();
    await git(["push", "origin", "--delete", "agent/spec-33"], fixture.remote).catch(() => "");
    const head = await commit(fixture.worktree, "ours.txt", "ours\n");
    await pushToSpecBranch({ env: fixture.env, paths: fixture.paths, log: () => {} });
    expect(await git(["rev-parse", "agent/spec-33"], fixture.remote)).toBe(head);
  });
});

/**
 * The exit code is what makes a fatal push one attempt instead of five: the Job's
 * `podFailurePolicy` reads the container's exit code and Fails the Job at once,
 * the way it already does for the seed's exit 78 (ADR-0009). Anything the next pod
 * could plausibly fix must stay retryable, so only the conflict is fatal.
 */
describe("push: the exit code a failed push ends the pod with", () => {
  it("makes a conflict fatal and everything else retryable", () => {
    expect(pushExitCodeFor(new FatalPushError("rebase conflicted"))).toBe(RUNNER_EXIT.fatal);
    for (const retryable of [
      new Error("git push failed (1): non-fast-forward"),
      new Error("git fetch failed (128): could not resolve host"),
      new Error("remote unreachable"),
      "not even an Error",
    ]) {
      expect(pushExitCodeFor(retryable)).toBe(RUNNER_EXIT.retryable);
    }
  });

  it("does not reuse the seed's fatal code by accident", () => {
    // Same value is fine (the policy matches per container) but it must be a
    // decision, not a coincidence: the runner's code is its own constant.
    expect(RUNNER_EXIT.fatal).toBe(SEED_EXIT.fatal);
    expect(RUNNER_EXIT.retryable).not.toBe(RUNNER_EXIT.fatal);
  });
});

describe("push: a conflict no later pod can fix", () => {
  it("fails fatally, leaves no half-applied rebase, and keeps the commits", async () => {
    fixture = await runnerFixture();
    const other = await otherTicket(fixture);
    await commit(other, "contested.txt", "theirs\n");
    await git(["push", "origin", "HEAD:refs/heads/agent/spec-33"], other);
    const theirs = await git(["rev-parse", "HEAD"], other);

    // The same file, different content: git cannot pick a winner.
    const ours = await commit(fixture.worktree, "contested.txt", "ours\n");

    await expect(pushToSpecBranch({ env: fixture.env, paths: fixture.paths, log: () => {} })).rejects.toThrow(
      FatalPushError,
    );

    // Nothing was pushed…
    expect(await git(["rev-parse", "agent/spec-33"], fixture.remote)).toBe(theirs);
    // …the worktree is back where the run left it (no rebase in progress, our commit intact)…
    expect(await git(["status", "--porcelain"], fixture.worktree)).toBe("");
    expect(await git(["rev-parse", "HEAD"], fixture.worktree)).toBe(ours);
    // …and no conflict markers were left in the file the model wrote.
    expect(await readFile(join(fixture.worktree, "contested.txt"), "utf8")).toBe("ours\n");
  });
});
