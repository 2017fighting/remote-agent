import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_EXIT, SEED_EXIT } from "@remote-agent/shared";
import {
  FatalPushError,
  classifyPushFailure,
  pushExitCodeFor,
  pushToSpecBranch,
} from "../src/internal/runner.js";
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

  /**
   * `git rebase` fails before it begins when the worktree has unstaged changes —
   * the common one is work the agent never committed. That is not a conflict
   * between two tickets, so it must not borrow the fatal class or the message: a
   * one-attempt FailJob on a dirty volume would be a new failure mode, not a fix.
   */
  it("treats a rebase that never started as retryable, not as a conflict", async () => {
    fixture = await runnerFixture();
    const other = await otherTicket(fixture);
    await commit(other, "theirs.txt", "theirs\n");
    await git(["push", "origin", "HEAD:refs/heads/agent/spec-33"], other);
    await commit(fixture.worktree, "ours.txt", "ours\n");
    // An unstaged change to a *tracked* file: what `git rebase` refuses to start
    // over. (An untracked file would not stop it — rebase does not care about those.)
    await writeFile(join(fixture.worktree, "ours.txt"), "edited after the commit\n");

    const error = await pushToSpecBranch({ env: fixture.env, paths: fixture.paths, log: () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(FatalPushError);
    expect(pushExitCodeFor(error)).toBe(RUNNER_EXIT.retryable);
    // The message says what happened, not "conflicted".
    expect((error as Error).message).toMatch(/did not start/);
  });

  /**
   * A fetch failure is classified the way the seed classifies its own git calls:
   * a credential or repo the runner cannot read is fatal and human-fixable
   * (ADR-0009: GitHub answers 404 to a repo the credential cannot see), while a
   * network failure is worth another pod. The `couldn't find remote ref` path is
   * the only one that means "no branch yet".
   */
  it("classifies an unreadable remote as fatal and a network failure as retryable", () => {
    const auth = classifyPushFailure(
      "remote: Repository not found.\nfatal: repository 'https://github.com/other/private.git/' not found",
      128,
      ["fetch", "origin", "agent/spec-33"],
    );
    expect(auth).toBeInstanceOf(FatalPushError);
    expect(pushExitCodeFor(auth)).toBe(RUNNER_EXIT.fatal);

    for (const stderr of [
      "fatal: unable to access 'https://github.com/2017fighting/pi-web.git/': Could not resolve host: github.com",
      "fatal: unable to access '…': The requested URL returned error: 503",
      "fatal: unable to access '…': Operation timed out",
    ]) {
      const transient = classifyPushFailure(stderr, 128, ["fetch", "origin", "agent/spec-33"]);
      expect(transient).not.toBeInstanceOf(FatalPushError);
      expect(pushExitCodeFor(transient)).toBe(RUNNER_EXIT.retryable);
    }
  });
});
