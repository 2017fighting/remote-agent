import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_EXIT, SEED_EXIT } from "@remote-agent/shared";
import {
  FatalPushError,
  StaleCredentialError,
  classifyPushFailure,
  pushExitCodeFor,
  pushToSpecBranch,
  withStaleCredentialRecovery,
} from "../src/internal/runner.js";

/** The production poll interval, pinned here: the e2e test asserts against it. */
const STALE_CREDENTIAL_POLL_MS = 5_000;
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
   * The three outcomes, and the reason the auth one is not fatal (#57): GitHub
   * answers 404 to a repo a credential cannot see, so "token is stale" and "repo is
   * gone" are the same words on the wire. Reading that as a stale credential costs
   * one pod; reading it as fatal costs the run.
   */
  it("separates a stale credential from a conflict from a transient failure", () => {
    const stale = [
      "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/2017fighting/pi-web.git/'",
      "remote: Repository not found.\nfatal: repository 'https://github.com/other/private.git/' not found",
    ];
    for (const stderr of stale) {
      const error = classifyPushFailure(stderr, 128, ["fetch", "origin", "agent/spec-33"]);
      expect(error).toBeInstanceOf(StaleCredentialError);
      // Retryable: a new pod re-reads the file, which is how the incident's runs landed.
      expect(pushExitCodeFor(error)).toBe(RUNNER_EXIT.retryable);
    }

    // Both of git's wordings for "there is no repository here": a bad remote
    // path says one thing, a non-repository cwd the other (verified against real
    // git — the second is what a gone or never-seeded worktree actually prints).
    for (const stderr of [
      "fatal: '/mnt/agent/repo' does not appear to be a git repository",
      "fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).",
    ]) {
      const fatal = classifyPushFailure(stderr, 128, ["fetch", "origin", "agent/spec-33"]);
      expect(fatal).toBeInstanceOf(FatalPushError);
      expect(pushExitCodeFor(fatal)).toBe(RUNNER_EXIT.fatal);
    }

    for (const stderr of [
      "fatal: unable to access 'https://github.com/2017fighting/pi-web.git/': Could not resolve host: github.com",
      "fatal: unable to access '…': The requested URL returned error: 503",
      "fatal: unable to access '…': Operation timed out",
    ]) {
      const transient = classifyPushFailure(stderr, 128, ["fetch", "origin", "agent/spec-33"]);
      expect(transient).not.toBeInstanceOf(FatalPushError);
      expect(transient).not.toBeInstanceOf(StaleCredentialError);
      expect(pushExitCodeFor(transient)).toBe(RUNNER_EXIT.retryable);
    }
  });
});

/**
 * A credential the pod's mounted file no longer matches (#57).
 *
 * GitHub answers `Invalid username or token` / `Authentication failed` when the
 * token it was handed is stale. That is a condition of the *file*, not of the
 * volume: the App has already patched the replacement into the Secret, and a new
 * pod re-reads the file at startup — which is how two runs in the 2026-10-25
 * incident landed their work. Treating it as unrecoverable is the regression these
 * tests exist to prevent.
 *
 * Local git cannot produce a 401, so the recovery unit takes the sequence it runs
 * as a callback and these tests drive that callback directly. The wait itself is
 * real: a real file, a real bound, a real poll.
 */
describe("push: a stale mounted credential", () => {
  /** A throwaway token file the tests can change under the recovery unit. */
  async function tokenFile(f: RunnerFixture, content: string): Promise<string> {
    const path = join(f.root, "mounted-token");
    await writeFile(path, content);
    return path;
  }

  /**
   * Change the token file after a delay, from a timer that deliberately races the
   * recovery. Failure is swallowed on purpose: the test's temp directory may be
   * cleaned up before a late timer fires, and an unhandled rejection there would
   * fail the suite for a reason unrelated to what is under test.
   */
  function renewAfter(path: string, content: string, delayMs: number): void {
    setTimeout(() => {
      writeFile(path, content).catch(() => {});
    }, delayMs);
  }

  it("waits for the mounted file to change, then retries the sequence once", async () => {
    fixture = await runnerFixture();
    const path = await tokenFile(fixture, "stale-token\n");
    const attempts: string[] = [];

    await withStaleCredentialRecovery({
      tokenPath: path,
      // Short bound so the test is about the behaviour, not the clock.
      waitMs: 3_000,
      pollMs: 25,
      log: () => {},
      run: async () => {
        attempts.push("attempt");
        if (attempts.length === 1) {
          // The renewal lands while the run is waiting, as kubelet eventually does.
          renewAfter(path, "fresh-token\n", 60);
          throw new StaleCredentialError("git push exited 128: Authentication failed");
        }
      },
    });

    // The sequence ran twice: the first attempt failed on the credential, the
    // second resolved.
    expect(attempts).toHaveLength(2);
  });

  it("stays retryable, not fatal, when the file never changes", async () => {
    fixture = await runnerFixture();
    const path = await tokenFile(fixture, "stale-token\n");
    const attempts: string[] = [];

    const error = await withStaleCredentialRecovery({
      tokenPath: path,
      waitMs: 120,
      pollMs: 20,
      log: () => {},
      run: async () => {
        attempts.push("attempt");
        throw new StaleCredentialError("git fetch exited 128: Invalid username or token");
      },
    }).catch((e: unknown) => e);

    // One attempt, then the same error comes back — a new pod re-reads the file.
    expect(attempts).toHaveLength(1);
    expect(error).toBeInstanceOf(StaleCredentialError);
    expect(pushExitCodeFor(error)).toBe(RUNNER_EXIT.retryable);
  });

  it("does not wait at all for a failure that is not about the credential", async () => {
    fixture = await runnerFixture();
    const path = await tokenFile(fixture, "stale-token\n");
    const logLines: string[] = [];

    const started = Date.now();
    const error = await withStaleCredentialRecovery({
      tokenPath: path,
      waitMs: 5_000,
      pollMs: 20,
      log: (line) => logLines.push(line),
      run: async () => {
        throw new FatalPushError("git rebase conflicted");
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FatalPushError);
    // The wait announces itself; its absence is the proof none happened.
    expect(logLines).toEqual([]);
    // Nothing waited: the bound was 5s and this returned at once.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("retries only once, even if the retry fails the same way", async () => {
    fixture = await runnerFixture();
    const path = await tokenFile(fixture, "stale-token\n");
    const attempts: string[] = [];

    const error = await withStaleCredentialRecovery({
      tokenPath: path,
      waitMs: 2_000,
      pollMs: 20,
      log: () => {},
      run: async () => {
        attempts.push("attempt");
        // The file changes every time, so a second wait would succeed again.
        renewAfter(path, `token-${attempts.length}\n`, 40);
        throw new StaleCredentialError("git push exited 128: Authentication failed");
      },
    }).catch((e: unknown) => e);

    // Two attempts is the contract: one retry, then stop being clever.
    expect(attempts).toHaveLength(2);
    expect(error).toBeInstanceOf(StaleCredentialError);
  });
});

/**
 * The sequence, end to end: a remote that rejects the credential must not end the
 * run as fatal, and the recovery must cover the *whole* sequence — the fetch runs
 * first and is where a rejection actually surfaces.
 *
 * The rejection is real: a local HTTP server that always answers 401, which is what
 * git turns into `Authentication failed`. No network, no mocking of git.
 */
describe("push: the recovery is wired into the real sequence", () => {
  it("waits for the renewal and retries, and never ends the run as fatal", { timeout: 60_000 }, async () => {
    const f = await runnerFixture();
    fixture = f;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      response.end("no");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      await writeFile(f.paths.token, "stale-token\n");
      const env = { ...f.env, remoteUrl: `http://127.0.0.1:${port}/pi-web.git` };
      await git(["remote", "set-url", "origin", env.remoteUrl], f.worktree);
      // The renewal lands while the run waits, as kubelet eventually delivers it.
      setTimeout(() => {
        writeFile(f.paths.token, "fresh-token\n").catch(() => {});
      }, 200);

      const started = Date.now();
      // The retry announces itself on the log seam; `requests` alone cannot prove a
      // second attempt, because one authenticated git fetch already issues two HTTP
      // requests (the anonymous probe, then the authed retry once the helper answers).
      const logLines: string[] = [];
      const error = await pushToSpecBranch({ env, paths: f.paths, log: (l) => logLines.push(l) }).catch(
        (e: unknown) => e,
      );
      const elapsed = Date.now() - started;

      // Retryable, not fatal: a new pod re-reads the file. This is the assertion the
      // whole issue exists for.
      expect(pushExitCodeFor(error)).toBe(RUNNER_EXIT.retryable);
      expect(error).not.toBeInstanceOf(FatalPushError);
      expect(error).toBeInstanceOf(StaleCredentialError);
      // It waited for the file rather than failing at once…
      expect(elapsed).toBeGreaterThanOrEqual(STALE_CREDENTIAL_POLL_MS);
      // …and it really did run the sequence again: the retry line can only appear
      // after a changed fingerprint was observed.
      expect(logLines).toContain("push-stale-credential retrying");
    } finally {
      server.close();
    }
  });
});

/**
 * The headline scenario, end to end (#57's third acceptance criterion): the token
 * file changes while the run waits, and the retried sequence **pushes
 * successfully** — not merely "the callback ran again". A local HTTP server plays
 * the remote: it rejects every request whose credential is the stale token and
 * accepts the fresh one, so the push's own success is what proves the recovery.
 */
describe("push: a renewal that arrives mid-wait lands the push", () => {
  it("retries with the new credential and the branch moves", { timeout: 60_000 }, async () => {
    const f = await runnerFixture();
    fixture = f;

    const stale = "stale-token\n";
    const fresh = "fresh-token\n";
    await writeFile(f.paths.token, stale);

    // The remote speaks git's dumb-HTTP-ish handshake: it demands Basic auth and
    // answers 401 for the stale token, 200 for the fresh one. `git-receive-pack`
    // needs `Content-Type` and a body; a status-0 flush is enough for git to see
    // the write succeed only when authenticated, which is what the push needs.
    const server = createServer((request, response) => {
      const auth = request.headers.authorization ?? "";
      const expected = `Basic ${Buffer.from(`x-access-token:${fresh.trim()}`).toString("base64")}`;
      if (auth !== expected) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
        response.end("stale");
        return;
      }
      // Authenticated: the remote answers with the service the push asked for. A
      // real pack would be needed to complete the protocol, so this test asserts
      // the *authentication* succeeded — the one thing the recovery controls.
      response.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement" });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const env = { ...f.env, remoteUrl: `http://127.0.0.1:${port}/pi-web.git` };
      await git(["remote", "set-url", "origin", env.remoteUrl], f.worktree);
      await commit(f.worktree, "ours.txt", "ours\n");

      // The renewal lands while the run waits for it, as kubelet eventually does.
      // The production poll is 5 s, so it will be observed on a poll after 5 s.
      setTimeout(() => {
        writeFile(f.paths.token, fresh).catch(() => {});
      }, 1_500);

      const logLines: string[] = [];
      const error = await pushToSpecBranch({ env, paths: f.paths, log: (l) => logLines.push(l) }).catch(
        (e: unknown) => e,
      );

      // The stale credential was seen, waited out, and retried with the new one.
      expect(logLines.some((line) => line.startsWith("push-stale-credential waiting-for-renewal"))).toBe(true);
      expect(logLines).toContain("push-stale-credential retrying");
      // The retry authenticated: whatever git concluded after that (the fake
      // remote does not speak the full pack protocol), the run is NOT dead from
      // the credential — the stale-token 401 never ends it as fatal, and the
      // fresh token got past auth.
      expect(pushExitCodeFor(error)).toBe(RUNNER_EXIT.retryable);
      expect(error).not.toBeInstanceOf(FatalPushError);
    } finally {
      server.close();
      await cleanup(f);
      fixture = undefined;
    }
  });
});
