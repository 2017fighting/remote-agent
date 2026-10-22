import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../src/fakes/FakeGitHub.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import type { GitHubPort } from "../src/ports/GitHubPort.js";
import type { K8sPort } from "../src/ports/K8sPort.js";
import { jobManifest, pvcManifest } from "./helpers.js";

describe("fakes and production share port signatures", () => {
  it("FakeGitHub satisfies GitHubPort", async () => {
    const gh: GitHubPort = new FakeGitHub({
      issues: [{ ownerRepo: "o/r", number: 1, state: "open", title: "t", body: "b", labels: [] }],
    });
    const issue = await gh.getIssue("o/r", 1);
    expect(issue?.number).toBe(1);
  });

  it("FakeK8s satisfies K8sPort", async () => {
    const k8s: K8sPort = new FakeK8s();
    const job = await k8s.createJob(jobManifest("agent-o-r-1"));
    expect(job.name).toBe("agent-o-r-1");
  });
});

describe("FakeK8s create-if-absent (409 = success)", () => {
  it("rejects a duplicate create with 409 and leaves the world untouched", async () => {
    const k8s = new FakeK8s();
    await k8s.createJob(jobManifest("agent-o-r-1"));
    await expect(k8s.createJob(jobManifest("agent-o-r-1"))).rejects.toMatchObject({ status: 409 });
    expect(k8s.jobs).toHaveLength(1);
    expect(k8s.writeLog).toEqual(["createJob agent-o-r-1"]);

    await k8s.createPvc(pvcManifest("agent-o-r-1"));
    await expect(k8s.createPvc(pvcManifest("agent-o-r-1"))).rejects.toMatchObject({ status: 409 });
    expect(k8s.writeLog.filter((w) => w.startsWith("createPvc"))).toHaveLength(1);
  });

  it("records patch writes only when annotations actually change", async () => {
    const k8s = new FakeK8s({
      secrets: [{ name: "s", namespace: "remote-agent", annotations: { "a": "1" }, data: {} }],
    });
    await k8s.patchSecretAnnotations("s", { "a": "1" });
    expect(k8s.writeLog).toHaveLength(0);
    await k8s.patchSecretAnnotations("s", { "a": "2" });
    expect(k8s.writeLog).toEqual(["patchSecretAnnotations s"]);
  });
});

describe("FakeGitHub label edit and idempotence", () => {
  it("editLabels is set semantics and only records actual changes", async () => {
    const gh = new FakeGitHub({
      issues: [
        { ownerRepo: "o/r", number: 1, state: "open", title: "t", body: "b", labels: ["ready-for-agent"] },
      ],
    });
    await gh.editLabels("o/r", 1, ["agent:implement"], []);
    expect(gh.writeLog).toEqual(["editLabels o/r#1 +[agent:implement] -[]"]);
    await gh.editLabels("o/r", 1, ["agent:implement"], []);
    expect(gh.writeLog).toHaveLength(1);
    const issue = await gh.getIssue("o/r", 1);
    expect(issue?.labels).toEqual(["ready-for-agent", "agent:implement"]);
  });

  it("listSubIssues keeps the listed order and listComments is oldest first", async () => {
    const gh = new FakeGitHub({
      issues: [
        { ownerRepo: "o/r", number: 33, state: "open", title: "spec", body: "", labels: [] },
        { ownerRepo: "o/r", number: 34, state: "open", title: "a", body: "", labels: [] },
        { ownerRepo: "o/r", number: 35, state: "open", title: "b", body: "", labels: [] },
      ],
      comments: [
        { id: 2, ownerRepo: "o/r", issueNumber: 34, body: "second", createdAt: "2025-01-02T00:00:00Z" },
        { id: 1, ownerRepo: "o/r", issueNumber: 34, body: "first", createdAt: "2025-01-01T00:00:00Z" },
      ],
      subIssues: [{ ownerRepo: "o/r", specNumber: 33, issueNumbers: [35, 34] }],
    });
    const subs = await gh.listSubIssues("o/r", 33);
    expect(subs.map((s) => s.number)).toEqual([35, 34]);
    const comments = await gh.listComments("o/r", 34);
    expect(comments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("createPullRequest returns the open PR for the same branch (branch-unique)", async () => {
    const gh = new FakeGitHub();
    await gh.createPullRequest({
      ownerRepo: "o/r",
      title: "t",
      body: "b",
      headBranch: "agent/spec-33",
      baseBranch: "main",
    });
    const existing = await gh.findPullRequestByBranch("o/r", "agent/spec-33");
    expect(existing).not.toBeNull();
    await gh.createPullRequest({
      ownerRepo: "o/r",
      title: "again",
      body: "b",
      headBranch: "agent/spec-33",
      baseBranch: "main",
    });
    expect(gh.pullRequests).toHaveLength(1);
  });
});
