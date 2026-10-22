import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startStubGitHub, type StubGitHub } from "../stub-github/server.js";
import type { Scenario } from "../stub-github/state.js";

/**
 * The stub GitHub's external behavior: the REST endpoints `GitHubPort` uses,
 * the credential check, and — the point of the stub — that clone / ls-remote /
 * push are served by real git (`git http-backend`), not by objects pretending
 * to be git.
 *
 * These assertions are the guard that keeps the stub honest as #43's octokit
 * adapter lands: a route that changes shape fails here before it fails in kind.
 */

const exec = promisify(execFile);
const REPO = "2017fighting/remote-agent";
const TOKEN = "ghs_stub_token";

const SCENARIO: Scenario = {
  repo: REPO,
  issues: [
    { number: 33, title: "spec", body: "the spec body", state: "open", labels: ["ready-for-agent", "agent:implement"] },
    { number: 34, title: "t1", body: "ticket one", state: "open", labels: ["ready-for-agent", "agent:implement"] },
    { number: 35, title: "t2", body: "ticket two", state: "open", labels: ["ready-for-agent"] },
    { number: 90, title: "blocker", body: "blocks", state: "open", labels: [] },
  ],
  subIssues: { "33": [34, 35] },
  blockers: { "34": [90] },
  comments: [{ id: 1, issueNumber: 34, author: "maintainer", body: "go", createdAt: "2026-01-01T00:00:00.000Z" }],
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "stub-test",
      GIT_AUTHOR_EMAIL: "stub-test@example.invalid",
      GIT_COMMITTER_NAME: "stub-test",
      GIT_COMMITTER_EMAIL: "stub-test@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
    },
  });
  return stdout.trim();
}

/** A real bare repository at `<root>/<owner>/<name>.git` with main + the spec branch. */
async function seedBareRepo(root: string): Promise<void> {
  const bare = join(root, "2017fighting", "remote-agent.git");
  const work = join(root, "work");
  await mkdir(join(root, "2017fighting"), { recursive: true });
  await git(["init", "--bare", "--initial-branch=main", bare], root);
  await mkdir(work, { recursive: true });
  await git(["init", "--initial-branch=main", work], root);
  await writeFile(join(work, "README.md"), "seed\n");
  await git(["add", "-A"], work);
  await git(["commit", "-m", "init"], work);
  await git(["remote", "add", "origin", bare], work);
  await git(["push", "origin", "main"], work);
  await git(["push", "origin", "main:refs/heads/agent/spec-33"], work);
  await rm(work, { recursive: true, force: true });
}

describe("stub-github", () => {
  let stub: StubGitHub | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await stub?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    stub = undefined;
    root = undefined;
  });

  async function start(): Promise<{ stub: StubGitHub; root: string; base: string }> {
    root = await mkdtemp(join(tmpdir(), "stub-github-"));
    await seedBareRepo(root);
    const scenarioPath = join(root, "scenario.json");
    await writeFile(scenarioPath, JSON.stringify(SCENARIO));
    stub = await startStubGitHub({ scenarioPath, projectRoot: root, token: TOKEN, port: 0 });
    return { stub, root, base: `http://127.0.0.1:${stub.port}` };
  }

  it("serves the issue list and a single issue in GitHub's REST shape", async () => {
    const { base } = await start();
    const list = await (await fetch(`${base}/repos/${REPO}/issues`)).json();
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ number: 33, state: "open", title: "spec" });
    expect(list[0].labels).toEqual([{ name: "ready-for-agent" }, { name: "agent:implement" }]);

    const one = await (await fetch(`${base}/repos/${REPO}/issues/35`)).json();
    expect(one).toMatchObject({ number: 35, body: "ticket two" });
  });

  it("serves the sub-issue tree in listed order and the blocker list", async () => {
    const { base } = await start();
    const subs = await (await fetch(`${base}/repos/${REPO}/issues/33/sub_issues`)).json();
    expect(subs.map((issue: { number: number }) => issue.number)).toEqual([34, 35]);

    const blockers = await (await fetch(`${base}/repos/${REPO}/issues/34/dependencies/blocked_by`)).json();
    expect(blockers.map((issue: { number: number }) => issue.number)).toEqual([90]);
  });

  it("applies label edits with set semantics and closes an issue", async () => {
    const { stub, base } = await start();
    const patched = await (
      await fetch(`${base}/repos/${REPO}/issues/34`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labels: ["ready-for-agent", "agent:in-progress"] }),
      })
    ).json();
    expect(patched.labels).toEqual([{ name: "ready-for-agent" }, { name: "agent:in-progress" }]);

    await fetch(`${base}/repos/${REPO}/issues/34`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    });
    expect(stub.world.getIssue(34)?.state).toBe("closed");
  });

  it("records comments with an id, author and timestamp, oldest first", async () => {
    const { stub, base } = await start();
    await fetch(`${base}/repos/${REPO}/issues/34/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "done <!-- remote-agent:done:job -->" }),
    });
    const comments = await (await fetch(`${base}/repos/${REPO}/issues/34/comments`)).json();
    expect(comments.map((c: { body: string }) => c.body)).toEqual([
      "go",
      "done <!-- remote-agent:done:job -->",
    ]);
    expect(comments[1].user.login).toBe("remote-agent[bot]");
    expect(stub.world.listComments(34)[1]?.id).toBeGreaterThan(comments[0].id);
  });

  it("creates a PR and finds it by head branch, and never returns two for one branch", async () => {
    const { base } = await start();
    const created = await (
      await fetch(`${base}/repos/${REPO}/pulls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "close out", body: "Closes #33", head: "agent/spec-33", base: "main" }),
      })
    ).json();
    expect(created).toMatchObject({ draft: false, head: { ref: "agent/spec-33" }, base: { ref: "main" } });

    const found = await (await fetch(`${base}/repos/${REPO}/pulls?head=${REPO}:agent/spec-33`)).json();
    expect(found).toHaveLength(1);
    expect(found[0].body).toContain("Closes #33");

    const none = await (await fetch(`${base}/repos/${REPO}/pulls?head=${REPO}:agent/spec-99`)).json();
    expect(none).toEqual([]);
  });

  it("creates an issue, then links it as a sub-issue idempotently", async () => {
    const { stub, base } = await start();
    const created = await (
      await fetch(`${base}/repos/${REPO}/issues`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "follow-up", body: "more work", labels: ["ready-for-human"] }),
      })
    ).json();
    expect(created.number).toBe(91);

    for (const _ of [1, 2]) {
      await fetch(`${base}/repos/${REPO}/issues/33/sub_issues`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ number: 91 }),
      });
    }
    expect(stub.world.listSubIssues(33).map((i) => i.number)).toEqual([34, 35, 91]);
  });

  it("mints an installation token that expires in the future", async () => {
    const { base } = await start();
    const minted = await (
      await fetch(`${base}/app/installations/1/access_tokens`, { method: "POST" })
    ).json();
    expect(minted.token).toBe(TOKEN);
    expect(new Date(minted.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("404s a repo it does not serve and a route it does not implement", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/repos/other/repo/issues`)).status).toBe(404);
    expect((await fetch(`${base}/repos/${REPO}/actions/runs`)).status).toBe(404);
  });

  it("serves real git: ls-remote, clone and push all go through git http-backend", async () => {
    const { stub, root: projectRoot, base } = await start();
    const authedUrl = `http://x-access-token:${TOKEN}@127.0.0.1:${stub.port}/${REPO}.git`;

    const refs = await git(["-c", "credential.helper=", "ls-remote", authedUrl], projectRoot);
    expect(refs).toContain("refs/heads/main");
    expect(refs).toContain("refs/heads/agent/spec-33");

    const clone = join(projectRoot, "clone");
    await git(["-c", "credential.helper=", "clone", authedUrl, clone], projectRoot);
    expect(await git(["rev-parse", "HEAD"], clone)).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(clone, "work.txt"), "agent output\n");
    await git(["add", "-A"], clone);
    await git(["commit", "-m", "agent work"], clone);
    await git(["push", "origin", "HEAD:refs/heads/agent/spec-33"], clone);

    // The push landed in the real bare repository, so the ref moved there.
    const after = await git(["rev-parse", "agent/spec-33"], join(projectRoot, "2017fighting", "remote-agent.git"));
    expect(after).toBe(await git(["rev-parse", "HEAD"], clone));
    expect(base).toContain("127.0.0.1");
  });

  it("rejects git operations without the minted token", async () => {
    const { stub, root: projectRoot, base } = await start();
    const url = `${base}/${REPO}.git`;
    // Git probes anonymously first; the stub answers 401, so git cannot proceed.
    await expect(git(["-c", "credential.helper=", "ls-remote", url], projectRoot)).rejects.toThrow(
      /could not read Username|Authentication failed|not found/,
    );
    expect(stub.gitOperations.some((operation) => operation.exitCode === 401)).toBe(true);
  });

  it("reports every served git operation, so the scenario can assert the git work was real", async () => {
    const { stub, root: projectRoot } = await start();
    const authedUrl = `http://x-access-token:${TOKEN}@127.0.0.1:${stub.port}/${REPO}.git`;

    await git(["-c", "credential.helper=", "ls-remote", authedUrl], projectRoot);
    const clone = join(projectRoot, "clone-recorded");
    await git(["-c", "credential.helper=", "clone", authedUrl, clone], projectRoot);
    await writeFile(join(clone, "x.txt"), "x\n");
    await git(["add", "-A"], clone);
    await git(["commit", "-m", "x"], clone);
    await git(["push", "origin", "HEAD:refs/heads/agent/spec-33"], clone);

    const services = stub.gitOperations.map((operation) => operation.service);
    // Reads are upload-pack; the push is receive-pack. Both ran as real git.
    expect(services).toContain("upload-pack");
    expect(services).toContain("receive-pack");
    // Every operation that carried the minted token succeeded. (Git always makes
    // one anonymous probe first, which the stub answers 401 — see below.)
    const authed = stub.gitOperations.filter((operation) => operation.auth !== undefined);
    expect(authed.length).toBeGreaterThan(0);
    expect(authed.every((operation) => operation.exitCode === 0)).toBe(true);
    expect(stub.gitOperations.some((operation) => operation.path.includes("git-receive-pack"))).toBe(true);
  });

  it("records a rejected git operation as a 401 rather than a served one", async () => {
    const { stub, root: projectRoot } = await start();
    await expect(
      git(["-c", "credential.helper=", "ls-remote", `http://x-access-token:WRONG@127.0.0.1:${stub.port}/${REPO}.git`], projectRoot),
    ).rejects.toThrow(/Authentication failed|not found/);
    expect(stub.gitOperations.some((operation) => operation.exitCode === 401)).toBe(true);
  });
});
