import { describe, expect, it } from "vitest";
import { ANNOTATIONS, isWorkItemV1, jobName, secretName, specBranch, type NewTicket, type WorkItemV1 } from "@remote-agent/shared";
import { runReconcilePass, type ReconcileDeps } from "../src/reconcile.js";
import { FakeGitHub } from "../src/fakes/FakeGitHub.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import { testConfig } from "./helpers.js";
import { GATE_LABELS, REPO, closeoutJob, closedOutSpecWorld, issue, managedJob, specWorld } from "./world.js";
import { LABEL_CLOSEOUT_CONSUMED } from "../src/planners/spec-loop.js";

/**
 * The spec loop on the App seam (spec #33 §2 steps 4–5, docs/architecture.md
 * §4.5): S1's three-way branch, and what the closeout Job's outcome turns into
 * (S3 / S3N / S4 / S5). One `reconcile()` pass per "trigger", asserted on the
 * final world and on the write calls it issued.
 *
 * The one invariant that runs through every scenario: **a spec never gets
 * `agent:in-progress`** — its "running" is being inside the label gate with an
 * empty or non-empty Frontier.
 */

const SPEC = 33;
const config = testConfig();
const NOW = new Date("2025-03-01T12:00:00.000Z");

function run(deps: Pick<ReconcileDeps, "github" | "k8s">) {
  return runReconcilePass({ ...deps, config, now: () => NOW }, "tick");
}

/** Same set semantics for any issue, for the S3N follow-ups (ticket #48). */
async function labelsOf(github: FakeGitHub, issueNumber: number): Promise<string[]> {
  return [...((await github.getIssue(REPO, issueNumber))?.labels ?? [])].sort();
}

/** `labelsOf`, pinned to the spec's own number. */
function specLabels(github: FakeGitHub): Promise<string[]> {
  return labelsOf(github, SPEC);
}

/**
 * The world of a finished closeout run that reported `newTickets` (S3N): the
 * spec in the gate, its sub-issues closed, the closeout Job terminal with a
 * done annotation. What the follow-ups are is the one thing that varies.
 */
function newTicketsWorld(newTickets: NewTicket[]) {
  const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34, 35] });
  const k8s = new FakeK8s({
    jobs: [
      closeoutJob(REPO, SPEC, {
        finished: true,
        annotation: runResult({
          v: 1,
          outcome: "done",
          summary: "s",
          prBody: "## Summary\n\nnot yet",
          newTickets,
        }),
      }),
    ],
  });
  return { github, k8s };
}

const CLOSEOUT = jobName(REPO, SPEC);

function runResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe("S1 → S2: frontier empty and no open sub-issue starts the closeout Job", () => {
  it("creates exactly one implement-spec Job, named by the same rule as a ticket Job", async () => {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34, 35] });
    const k8s = new FakeK8s();

    await run({ github, k8s });

    expect(k8s.jobs.map((job) => job.name)).toEqual([CLOSEOUT]);
    expect(k8s.jobManifests[0]!.labels["remote-agent/role"]).toBe("implement-spec");
    expect(k8s.jobManifests[0]!.podTemplate.containers[0]!.env).toContainEqual({
      name: "AGENT_ROLE",
      value: "implement-spec",
    });
    // The closeout Job's volume and token follow the same deterministic naming.
    expect(k8s.pvcs.map((pvc) => pvc.name)).toEqual([CLOSEOUT]);
    expect(k8s.secrets.map((secret) => secret.name)).toEqual([secretName(REPO, SPEC)]);
  });

  it("does not collide with any ticket Job name", async () => {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34, 35, 36, 37, 38, 39] });
    const k8s = new FakeK8s();
    await run({ github, k8s });

    const closeout = k8s.jobs[0]!.name;
    const ticketNames = [34, 35, 36, 37, 38, 39].map((n) => jobName(REPO, n));
    expect(ticketNames).not.toContain(closeout);
    // Same rule, same prefix, different (globally unique) issue number.
    expect(closeout).toBe(`agent-2017fighting-remote-agent-${SPEC}`);
  });

  it("clears a stale consumed marker when the fresh closeout Job starts", async () => {
    // The marker says "the last closeout's outcome is consumed". A new closeout
    // Job under the same name starts a new run, so the marker has to go — one
    // label write, and it is the only one on this path.
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    (await github.getIssue(REPO, SPEC))!.labels = [...GATE_LABELS, LABEL_CLOSEOUT_CONSUMED];
    const k8s = new FakeK8s();

    await run({ github, k8s });

    expect(k8s.jobs.map((job) => job.name)).toEqual([CLOSEOUT]);
    expect(await specLabels(github)).toEqual([...GATE_LABELS].sort());
    expect(github.writeLog.filter((write) => write.startsWith("editLabels"))).toEqual([
      `editLabels ${REPO}#${SPEC} +[] -[${LABEL_CLOSEOUT_CONSUMED}]`,
    ]);
  });

  it("a spec that never consumed a closeout gets no label write when one starts", async () => {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    const k8s = new FakeK8s();

    await run({ github, k8s });

    expect(github.writeLog.filter((write) => write.startsWith("editLabels"))).toEqual([]);
  });

  it("starts no second closeout Job while the old one is still there (ADR-0013, k8s half)", async () => {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    const k8s = new FakeK8s({ jobs: [closeoutJob(REPO, SPEC)] });

    await run({ github, k8s });

    expect(k8s.writeLog).toEqual([]);
    expect(github.writeLog).toEqual([]);
  });

  it("a finished-but-unjudged closeout Job is judged, not duplicated", async () => {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    const k8s = new FakeK8s({
      jobs: [
        closeoutJob(REPO, SPEC, {
          finished: true,
          annotation: runResult({ v: 1, outcome: "done", summary: "s", prBody: "## Summary\n\ndone" }),
        }),
      ],
    });

    await run({ github, k8s });

    expect(k8s.writeLog).toEqual([]);
    expect(github.pullRequests).toHaveLength(1);
  });

  it("hands the closeout Job the ticket map: every sub-issue with its title, body and comments", async () => {
    // User story 26: the spec role must read its whole acceptance surface from
    // AGENT_WORK_ITEM. `prompts/implement-spec` is verbatim and refers to the map
    // as "rendered above", so the App is the one that has to put it there.
    const github = new FakeGitHub({
      issues: [
        issue(SPEC, GATE_LABELS, { title: "Spec 33", body: "the spec body" }),
        issue(34, GATE_LABELS, { state: "closed", title: "Ticket 34", body: "body of 34" }),
        issue(35, GATE_LABELS, { state: "closed", title: "Ticket 35", body: "body of 35" }),
      ],
      subIssues: [{ ownerRepo: REPO, specNumber: SPEC, issueNumbers: [34, 35] }],
      comments: [
        { id: 1, ownerRepo: REPO, issueNumber: 34, author: "alice", body: "later on 34", createdAt: "2025-02-02T00:00:00Z" },
        { id: 2, ownerRepo: REPO, issueNumber: 34, author: "bob", body: "earlier on 34", createdAt: "2025-02-01T00:00:00Z" },
        { id: 3, ownerRepo: REPO, issueNumber: 35, author: "carol", body: "only on 35", createdAt: "2025-02-03T00:00:00Z" },
        { id: 4, ownerRepo: REPO, issueNumber: SPEC, author: "human", body: "spec note", createdAt: "2025-01-30T00:00:00Z" },
      ],
    });
    const k8s = new FakeK8s();

    await run({ github, k8s });

    const workItem = JSON.parse(
      k8s.jobManifests[0]!.podTemplate.containers[0]!.env!.find((e) => e.name === "AGENT_WORK_ITEM")!.value!,
    ) as WorkItemV1;
    expect(workItem.tickets?.map((t) => t.number)).toEqual([34, 35]);
    expect(workItem.tickets?.map((t) => t.title)).toEqual(["Ticket 34", "Ticket 35"]);
    expect(workItem.tickets?.map((t) => t.body)).toEqual(["body of 34", "body of 35"]);
    // Chronological, not list order: the fake stores them out of order on purpose.
    expect(workItem.tickets?.[0]?.comments.map((c) => c.body)).toEqual(["earlier on 34", "later on 34"]);
    expect(workItem.tickets?.[1]?.comments.map((c) => c.body)).toEqual(["only on 35"]);
    // The spec's own comments stay on the spec, not mixed into a ticket.
    expect(workItem.comments.map((c) => c.body)).toEqual(["spec note"]);
    expect(isWorkItemV1(workItem)).toBe(true);
  });

  it("never starts a closeout for an issue with no sub-issues (that is not a spec)", async () => {
    // "Having sub-issues is what makes an issue a spec" (user story 32), so this
    // shape must start no Job at all — not a closeout with an empty ticket map.
    // The empty-map path is unreachable through reconcile and is covered directly
    // at the render seam (app/test/work-item.test.ts).
    const github = new FakeGitHub({
      issues: [issue(SPEC, GATE_LABELS, { title: "Spec 33", body: "the spec body" })],
      subIssues: [{ ownerRepo: REPO, specNumber: SPEC, issueNumbers: [] }],
    });
    const k8s = new FakeK8s();

    await run({ github, k8s });

    expect(k8s.jobManifests).toHaveLength(0);
  });

  it("a ticket's work item carries no ticket map", async () => {
    const github = specWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    const k8s = new FakeK8s();

    await run({ github, k8s });

    const workItem = JSON.parse(
      k8s.jobManifests[0]!.podTemplate.containers[0]!.env!.find((e) => e.name === "AGENT_WORK_ITEM")!.value!,
    ) as WorkItemV1;
    expect(workItem.number).toBe(34);
    expect(Object.keys(workItem)).not.toContain("tickets");
  });

  it("a replayed pass over the world it just produced writes nothing", async () => {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    const k8s = new FakeK8s();

    await run({ github, k8s });
    const githubWrites = github.writeLog.length;
    const k8sWrites = k8s.writeLog.length;
    expect(k8sWrites).toBeGreaterThan(0);

    await run({ github, k8s });

    expect(github.writeLog.length).toBe(githubWrites);
    expect(k8s.writeLog.length).toBe(k8sWrites);
    expect(k8s.jobs).toHaveLength(1);
  });

  it("is admitted against the same Slot caps as a ticket Job", async () => {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    const k8s = new FakeK8s();
    // Three other Jobs already hold every global Slot.
    for (const n of [40, 41, 42]) {
      const job = managedJob("other/repo", n, { repoLabel: "other/repo" });
      k8s.jobs.push(job);
      k8s.pods.push({ name: `${job.name}-p`, namespace: "remote-agent", ownerJobName: job.name, phase: "Running", deleting: false });
    }

    const result = await run({ github, k8s });

    expect(result.deferred).toBe(1);
    expect(k8s.jobs.map((job) => job.name).sort()).toEqual([
      jobName("other/repo", 40),
      jobName("other/repo", 41),
      jobName("other/repo", 42),
    ]);
    expect(github.writeLog).toEqual([]);
  });

  it("never writes agent:in-progress on the spec", async () => {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    const k8s = new FakeK8s();

    await run({ github, k8s });

    expect(await specLabels(github)).toEqual(["agent:implement", "ready-for-agent"]);
    for (const write of github.writeLog) expect(write).not.toContain("agent:in-progress");
  });
});

describe("S1 idle: open sub-issues but an empty Frontier", () => {
  it("makes zero external writes and does not comment or relabel", async () => {
    const github = specWorld({
      specNumber: SPEC,
      subIssueNumbers: [34, 35],
      subIssueLabels: {
        34: ["ready-for-human", "agent:implement", "agent:blocked"],
        35: ["ready-for-human", "agent:implement", "agent:error"],
      },
    });
    const k8s = new FakeK8s();

    const result = await run({ github, k8s });

    expect(github.writeLog).toEqual([]);
    expect(k8s.writeLog).toEqual([]);
    expect(github.comments).toEqual([]);
    expect(result.slotsUsed).toBe(0);
    expect(await specLabels(github)).toEqual(["agent:implement", "ready-for-agent"]);
  });

  it("is counted as idle=1 with the reason that says what to do next (ticket #47)", async () => {
    // The shape that used to be entirely silent: the spec is in the gate, open
    // sub-issues remain, the Frontier is empty because both tickets carry an
    // exit marker. `idle` makes it a number; the reason says "a human must
    // re-enter these", not "the webhook never arrived".
    const github = specWorld({
      specNumber: SPEC,
      subIssueNumbers: [34, 35],
      subIssueLabels: {
        34: ["ready-for-human", "agent:implement", "agent:blocked"],
        35: ["ready-for-human", "agent:implement", "agent:error"],
      },
    });

    const result = await run({ github, k8s: new FakeK8s() });

    expect(result.idle).toBe(1);
    expect(result.idleReasons).toEqual([{ spec: SPEC, openSubIssues: 2, reasons: { "exit-marker": 2 } }]);
  });

  it("idle=0 when the Frontier is non-empty and a ticket is claimed", async () => {
    const github = specWorld({ specNumber: SPEC, subIssueNumbers: [34, 35] });
    const k8s = new FakeK8s();

    const result = await run({ github, k8s });

    expect(result.idle).toBe(0);
    expect(result.idleReasons).toEqual([]);
    expect(k8s.jobs.map((job) => job.name)).toEqual([jobName(REPO, 34)]);
  });

  it("tries again next pass: a human re-entry puts the ticket back in the Frontier", async () => {
    const github = specWorld({
      specNumber: SPEC,
      subIssueNumbers: [34],
      subIssueLabels: { 34: ["ready-for-human", "agent:implement", "agent:blocked"] },
    });
    const k8s = new FakeK8s();

    await run({ github, k8s });
    expect(github.writeLog).toEqual([]);

    // S6: the human drops the exit label and switches the triage label back.
    const ticket = github.issues.find((i) => i.number === 34)!;
    ticket.labels = [...GATE_LABELS];

    await run({ github, k8s });

    expect(k8s.jobs.map((job) => job.name)).toEqual([jobName(REPO, 34)]);
    expect(await specLabels(github)).toEqual(["agent:implement", "ready-for-agent"]);
  });
});

describe("S2 → S3: closeout done without newTickets opens the PR", () => {
  function doneWorld(prBody = "## Summary\n\nThe spec, delivered.") {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34, 35] });
    const k8s = new FakeK8s({
      jobs: [closeoutJob(REPO, SPEC, { finished: true, annotation: runResult({ v: 1, outcome: "done", summary: "s", prBody }) })],
    });
    return { github, k8s };
  }

  it("opens one ready PR to main from agent/spec-<n> with the prBody and one Closes line", async () => {
    const { github, k8s } = doneWorld();

    await run({ github, k8s });

    expect(github.pullRequests).toHaveLength(1);
    const pr = github.pullRequests[0]!;
    expect(pr.headBranch).toBe(specBranch(SPEC));
    expect(pr.headBranch).toBe("agent/spec-33");
    expect(pr.baseBranch).toBe("main");
    expect(pr.draft).toBe(false);
    expect(pr.body).toContain("## Summary");
    expect(pr.body).toContain("The spec, delivered.");
    expect(pr.body.match(/^Closes #33$/gm)).toHaveLength(1);
  });

  it("moves the spec to ready-for-human and drops ready-for-agent", async () => {
    const { github, k8s } = doneWorld();

    await run({ github, k8s });

    const labels = await specLabels(github);
    expect(labels).toEqual(["agent:implement", "ready-for-human"]);
    expect(labels).not.toContain("ready-for-agent");
    expect(labels).not.toContain("agent:in-progress");
  });

  it("does not duplicate the Closes line when the agent's prBody already carries it", async () => {
    const { github, k8s } = doneWorld("## Summary\n\nDone.\n\nCloses #33");

    await run({ github, k8s });

    expect(github.pullRequests[0]!.body.match(/^Closes #33$/gm)).toHaveLength(1);
  });

  it("replays to zero writes: the branch already has a PR and the spec left the gate", async () => {
    const { github, k8s } = doneWorld();

    await run({ github, k8s });
    const githubWrites = github.writeLog.length;
    const k8sWrites = k8s.writeLog.length;

    await run({ github, k8s });

    expect(github.pullRequests).toHaveLength(1);
    expect(github.writeLog.length).toBe(githubWrites);
    expect(k8s.writeLog.length).toBe(k8sWrites);
  });

  it("an existing PR for the same head branch is a skip, not a second PR", async () => {
    const { github, k8s } = doneWorld();
    await github.createPullRequest({
      ownerRepo: REPO,
      title: "already open",
      body: "Closes #33",
      headBranch: specBranch(SPEC),
      baseBranch: "main",
    });
    github.writeLog.length = 0;

    await run({ github, k8s });

    expect(github.pullRequests).toHaveLength(1);
    expect(github.writeLog).not.toContain(`createPullRequest ${REPO} ${specBranch(SPEC)}`);
    // The label migration still happens: it is the spec's "consumed" marker.
    expect(await specLabels(github)).toEqual(["agent:implement", "ready-for-human"]);
  });

  it("the same branch triggered twice still yields one PR and one Closes line", async () => {
    const { github, k8s } = doneWorld();

    await run({ github, k8s });
    // The world as a crash after the PR but before the label edit would leave
    // it: the spec is still inside the gate, so the next pass takes S3 again.
    (await github.getIssue(REPO, SPEC))!.labels = [...GATE_LABELS];

    await run({ github, k8s });

    expect(github.pullRequests).toHaveLength(1);
    expect(github.pullRequests[0]!.body.match(/^Closes #33$/gm)).toHaveLength(1);
    expect(await specLabels(github)).toEqual(["agent:implement", "ready-for-human"]);
  });

  /**
   * `expires-at` is the retention clock of a *judged* outcome (ADR-0011): the
   * closeout Job produces a real outcome, so its volume gets the same clock as a
   * ticket's — same helper, same set-if-absent rule, same per-outcome duration.
   * #37's steward then reclaims it by the normal rule rather than the orphan one.
   */
  it("writes the closeout volume's expires-at 7 days out on done", async () => {
    const { github, k8s } = doneWorld();
    k8s.pvcs.push({ name: CLOSEOUT, namespace: "remote-agent", annotations: {}, labels: {} });

    await run({ github, k8s });

    expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBe("2025-03-08T12:00:00.000Z");
    expect(k8s.writeLog.filter((write) => write === `patchPvcAnnotations ${CLOSEOUT}`)).toHaveLength(1);
  });

  it("does not rewrite the expires-at on a replay of the same judging pass", async () => {
    const { github, k8s } = doneWorld();
    k8s.pvcs.push({ name: CLOSEOUT, namespace: "remote-agent", annotations: {}, labels: {} });
    await run({ github, k8s });

    // The world as a crash after the PVC patch but before the label edit.
    (await github.getIssue(REPO, SPEC))!.labels = [...GATE_LABELS];
    k8s.writeLog.length = 0;

    await run({ github, k8s });

    expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBe("2025-03-08T12:00:00.000Z");
    expect(k8s.writeLog.filter((write) => write.startsWith("patchPvcAnnotations"))).toEqual([]);
  });
});

describe("S2 → S3N: closeout done with newTickets creates sub-issues and opens no PR", () => {
  function followUpWorld() {
    return newTicketsWorld([
      { title: "follow-up a", body: "body a", readyForAgent: true },
      { title: "follow-up b", body: "body b", readyForAgent: false },
    ]);
  }

  it("creates both sub-issues, labelled by readyForAgent", async () => {
    const { github, k8s } = followUpWorld();

    await run({ github, k8s });

    const created = github.issues.filter((i) => i.title.startsWith("follow-up"));
    expect(created.map((i) => i.title)).toEqual(["follow-up a", "follow-up b"]);
    expect(created[0]!.labels).toEqual(["ready-for-agent"]);
    expect(created[1]!.labels).toEqual(["ready-for-human"]);
  });

  it("opens no PR and leaves the spec in the gate — plus the consumed marker", async () => {
    const { github, k8s } = followUpWorld();

    await run({ github, k8s });

    expect(github.pullRequests).toEqual([]);
    // "There is still work left" must not look like "the spec is complete": the
    // gate labels stay. The one addition is the consumed marker (ticket #49).
    expect(await specLabels(github)).toEqual(["agent:implement", LABEL_CLOSEOUT_CONSUMED, "ready-for-agent"]);
    expect(github.writeLog.some((write) => write.startsWith("createPullRequest"))).toBe(false);
    // The only label write is the consumed marker; no gate label moves (ticket #49).
    expect(github.writeLog.filter((write) => write.startsWith("editLabels"))).toEqual([
      `editLabels ${REPO}#${SPEC} +[${LABEL_CLOSEOUT_CONSUMED}] -[]`,
    ]);
  });

  it("writes the consumed marker before the first createIssue", async () => {
    // The order is the crash-window choice (ticket #49): mark first, create
    // second. A crash in between loses this batch once (the TTL brings a fresh
    // closeout that reports what is still missing); the reverse order would
    // create the batch twice, which is the bug.
    const { github, k8s } = followUpWorld();

    await run({ github, k8s });

    const writes = github.writeLog;
    const marker = writes.findIndex((write) => write.includes(LABEL_CLOSEOUT_CONSUMED));
    const firstCreate = writes.findIndex((write) => write.startsWith("createIssue"));
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(firstCreate).toBeGreaterThan(marker);
  });

  it("links them to the spec, so the next pass sees them as their sub-issues", async () => {
    const { github, k8s } = followUpWorld();

    await run({ github, k8s });

    const subIssues = await github.listSubIssues(REPO, SPEC);
    expect(subIssues.map((i) => i.title)).toEqual(["Issue 34", "Issue 35", "follow-up a", "follow-up b"]);
  });

  it("a ready-for-agent follow-up is the Frontier on the next pass — the spec's authorization is inherited", async () => {
    const { github, k8s } = followUpWorld();
    await run({ github, k8s });

    // Ticket #46: the spec was authorized by a human once, so its
    // `ready-for-agent` follow-up is claimable without a second authorization.
    // The `ready-for-human` one stays out — triage is never inherited.
    await run({ github, k8s });

    const followUps = github.issues.filter((i) => i.title.startsWith("follow-up"));
    const readyForAgent = followUps.find((i) => i.title === "follow-up a")!;
    const readyForHuman = followUps.find((i) => i.title === "follow-up b")!;
    expect(k8s.jobs.map((job) => job.name)).toContain(jobName(REPO, readyForAgent.number));
    expect(k8s.jobs.map((job) => job.name)).not.toContain(jobName(REPO, readyForHuman.number));
    expect(await specLabels(github)).toEqual(["agent:implement", LABEL_CLOSEOUT_CONSUMED, "ready-for-agent"]);
  });

  it("a replayed pass creates nothing twice", async () => {
    const { github, k8s } = followUpWorld();

    await run({ github, k8s });
    const createWrites = github.writeLog.filter((write) => write.startsWith("createIssue"));
    expect(createWrites).toHaveLength(2);

    // The world as a crash after the linking write: the next pass must not
    // create the follow-ups a second time. It claims the ready-for-agent one
    // instead (ticket #46), which is a different write than a creation.
    await run({ github, k8s });

    expect(github.issues.filter((i) => i.title.startsWith("follow-up"))).toHaveLength(2);
    expect(github.writeLog.filter((write) => write.startsWith("createIssue"))).toHaveLength(2);
    expect(github.writeLog.some((write) => write.startsWith("createPullRequest"))).toBe(false);
  });

  /**
   * Issue #49: the created tickets were the only carrier of "this outcome was
   * consumed", and that carrier dies the moment every one of them closes. The
   * closeout Job object outlives them (its TTL window is 30 minutes, theirs is
   * as long as a human takes), so the same `newTickets` came back a second time.
   * These are the tests that keep the outcome consumed exactly once.
   */
  function closeEveryFollowUp(github: FakeGitHub) {
    for (const created of github.issues.filter((i) => i.title.startsWith("follow-up"))) created.state = "closed";
  }

  it("creates nothing a second time once every follow-up has closed and the Job object is still there", async () => {
    const { github, k8s } = followUpWorld();
    await run({ github, k8s }); // S3N: create, link, mark consumed.
    closeEveryFollowUp(github);
    const before = github.writeLog.filter((write) => write.startsWith("createIssue")).length;
    expect(before).toBe(2);

    const second = await run({ github, k8s }); // S1: no open sub-issue, Job still in its TTL window.

    expect(github.writeLog.filter((write) => write.startsWith("createIssue"))).toHaveLength(2);
    expect(github.issues.filter((i) => i.title.startsWith("follow-up"))).toHaveLength(2);
    // And no second closeout Job either: the object is the S2 state (ADR-0013).
    expect(k8s.writeLog).toEqual([]);
    expect(second.closeoutConsumed).toBe(1);
  });

  it("counts the wait as closeoutConsumed, so a consumed closeout is never silent", async () => {
    const { github, k8s } = followUpWorld();
    await run({ github, k8s });
    closeEveryFollowUp(github);

    const second = await run({ github, k8s });
    expect(second.closeoutConsumed).toBe(1);
    expect(second.idle).toBe(0);
    expect(second.deferred).toBe(0);

    // The wait ends by itself: the Job's TTL deletes the object, and the very
    // next pass starts a fresh closeout (S2) that re-reports whatever is left.
    k8s.deleteJob(CLOSEOUT);
    github.writeLog.length = 0;
    await run({ github, k8s });

    expect(k8s.jobs.map((job) => job.name)).toEqual([CLOSEOUT]);
    expect(github.writeLog.filter((write) => write.startsWith("createIssue"))).toHaveLength(0);
    // The fresh closeout starts unmarked: the marker belonged to the consumed run.
    expect(await specLabels(github)).toEqual(["agent:implement", "ready-for-agent"]);
    expect(github.writeLog.filter((write) => write.startsWith(`editLabels ${REPO}#${SPEC}`))).toEqual([
      `editLabels ${REPO}#${SPEC} +[] -[${LABEL_CLOSEOUT_CONSUMED}]`,
    ]);
  });

  it("a crash right after the marker leaves the spec parked, not repeating the batch", async () => {
    // The chosen crash window (ticket #49): mark, then create. Simulate the pass
    // dying after the marker write — no follow-up exists yet, but the marker is
    // on the spec, so the next pass treats the outcome as consumed instead of
    // creating the batch from scratch a second time.
    const { github, k8s } = followUpWorld();
    await github.editLabels(REPO, SPEC, [LABEL_CLOSEOUT_CONSUMED], []);
    github.writeLog.length = 0;

    const second = await run({ github, k8s });

    expect(github.writeLog.filter((write) => write.startsWith("createIssue"))).toEqual([]);
    expect(second.closeoutConsumed).toBe(1);
    // Recovery is the TTL, not a retry: the object goes, a fresh closeout starts,
    // and the spec role re-reports whatever is still missing.
    k8s.deleteJob(CLOSEOUT);
    await run({ github, k8s });
    expect(k8s.jobs.map((job) => job.name)).toEqual([CLOSEOUT]);
  });

  it("a spec whose closeout never reported newTickets carries no marker, so a replay stays write-free", async () => {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    const k8s = new FakeK8s({
      jobs: [
        closeoutJob(REPO, SPEC, {
          finished: true,
          annotation: runResult({ v: 1, outcome: "done", summary: "s", prBody: "p" }),
        }),
      ],
    });
    await run({ github, k8s });

    expect(github.writeLog.filter((write) => write.includes(LABEL_CLOSEOUT_CONSUMED))).toEqual([]);
    github.writeLog.length = 0;
    await run({ github, k8s });
    expect(github.writeLog).toEqual([]);
  });
});

describe("S3N → the next pass: a created follow-up runs with no human in the loop (ticket #48)", () => {
  /**
   * The S3N semantics closure. Before ticket #46 the closeout's follow-ups sat
   * on the idle branch until a human wrote `agent:implement` on each one; the
   * docs said so outright, and the `idle` counter was the shape of that wait.
   * Authorization now inherits, so the loop runs to the PR on its own — and the
   * tests below are what keeps that sentence from drifting back.
   *
   * Pinned at the App seam on purpose: the same chain is already proven end to
   * end by the kind e2e (spec #33), so repeating it there would buy the wiring,
   * not the rule.
   */
  function followUpWorld() {
    return newTicketsWorld([{ title: "follow-up a", body: "body a", readyForAgent: true }]);
  }

  it("claims the new ticket on the next pass, with no agent:implement written anywhere", async () => {
    const { github, k8s } = followUpWorld();
    await run({ github, k8s }); // S3N: create and link the follow-up.
    const created = github.issues.find((i) => i.title === "follow-up a")!;
    expect(created.labels).toEqual(["ready-for-agent"]);

    const second = await run({ github, k8s }); // S1: the follow-up is the Frontier.

    // Claimed: the same PVC → Secret → Job write order a human-authorized ticket
    // gets, because the inherited path is the same path.
    expect(k8s.writeLog.filter((write) => write.endsWith(String(created.number)))).toEqual([
      `createPvc agent-2017fighting-remote-agent-${created.number}`,
      `createJob agent-2017fighting-remote-agent-${created.number}`,
    ]);
    expect(k8s.jobs.map((job) => job.name)).toContain(jobName(REPO, created.number));
    // The label chain is a plain ticket's: `ready-for-agent` (written by the App
    // at creation) → inherited authorization → `agent:in-progress`. Inheritance
    // is a judgement, never a write, so `agent:implement` never appears.
    expect(await labelsOf(github, created.number)).toEqual(["agent:in-progress", "ready-for-agent"]);
    for (const write of github.writeLog) expect(write).not.toContain("agent:implement");
    // And it is not idle: the "open sub-issue but empty Frontier" branch that
    // the old docs described is exactly what does not happen any more.
    expect(second.idle).toBe(0);
    expect(second.idleReasons).toEqual([]);
  });

  it("the settled world is write-free on a replay — the loop needs no human checkpoint to converge", async () => {
    const { github, k8s } = followUpWorld();
    await run({ github, k8s }); // S3N: create and link.
    await run({ github, k8s }); // S1: claim the follow-up.

    // The world after the claim: the new ticket's Job is live, so the spec has a
    // Frontier that is in-flight. A replay over it must write nothing at all.
    k8s.writeLog.length = 0;
    github.writeLog.length = 0;
    const third = await run({ github, k8s });

    expect(k8s.writeLog, "no k8s writes on replay").toEqual([]);
    expect(github.writeLog, "no GitHub writes on replay").toEqual([]);
    expect(github.comments, "no comments on replay").toEqual([]);
    expect(github.issues.filter((i) => i.title === "follow-up a")).toHaveLength(1);
    // The in-flight ticket is why the Frontier is empty this pass — a reason the
    // log can name, and one no human has to act on.
    expect(third.idleReasons).toEqual([{ spec: SPEC, openSubIssues: 1, reasons: { "in-flight": 1 } }]);
  });

  it("a ready-for-human follow-up stays out: triage is never inherited", async () => {
    const { github, k8s } = newTicketsWorld([{ title: "needs a decision", body: "b", readyForAgent: false }]);
    await run({ github, k8s });
    const created = github.issues.find((i) => i.title === "needs a decision")!;
    expect(created.labels).toEqual(["ready-for-human"]);

    k8s.writeLog.length = 0;
    github.writeLog.length = 0;
    const second = await run({ github, k8s });

    // Inherited authorization does not resurrect a ticket nobody triaged in: the
    // loop stops here, and the `idle` line says the human is the next actor.
    expect(k8s.writeLog).toEqual([]);
    expect(github.writeLog).toEqual([]);
    expect(second.idleReasons).toEqual([{ spec: SPEC, openSubIssues: 1, reasons: { "not-ready": 1 } }]);
  });
});

describe("S2 → S4 / S5: a failed closeout migrates the spec's labels and comments once", () => {
  const cases: Array<{ name: string; job: () => ReturnType<typeof closeoutJob>; label: string; marker: string; reason?: string }> = [
    {
      name: "blocked (Complete + blocked annotation)",
      job: () =>
        closeoutJob(REPO, SPEC, {
          finished: true,
          annotation: runResult({
            v: 1,
            outcome: "blocked",
            summary: "cannot close out",
            commentBody: "The migration needs a decision from a human.",
          }),
        }),
      label: "agent:blocked",
      marker: "blocked",
    },
    {
      name: "backoffLimitExceeded",
      job: () => closeoutJob(REPO, SPEC, { finished: true, failedReason: "BackoffLimitExceeded" }),
      label: "agent:error",
      marker: "evidence",
      reason: "backoff-exhausted",
    },
    {
      name: "DeadlineExceeded",
      job: () => closeoutJob(REPO, SPEC, { finished: true, failedReason: "DeadlineExceeded" }),
      label: "agent:error",
      marker: "evidence",
      reason: "deadline-exceeded",
    },
    {
      name: "Complete with no annotation",
      job: () => closeoutJob(REPO, SPEC, { finished: true }),
      label: "agent:error",
      marker: "evidence",
      reason: "no-result",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: ready-for-human + ${c.label}, one marker-deduped comment, no PR`, async () => {
      const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
      const k8s = new FakeK8s({
        jobs: [c.job()],
        pvcs: [{ name: CLOSEOUT, namespace: "remote-agent", annotations: {}, labels: {} }],
      });

      await run({ github, k8s });

      expect(await specLabels(github)).toEqual([c.label, "agent:implement", "ready-for-human"].sort());
      expect(github.pullRequests).toEqual([]);
      expect(github.comments).toHaveLength(1);
      expect(github.comments[0]!.body).toContain(`<!-- remote-agent:${c.marker}:${CLOSEOUT} -->`);
      if (c.reason !== undefined) expect(github.comments[0]!.body).toContain(c.reason);
      // Same retention rule as a ticket: `blocked` / `error` keep the volume 30 days.
      expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBe("2025-03-31T12:00:00.000Z");

      // Replay: the spec left the gate, so nothing runs at all.
      await run({ github, k8s });
      expect(github.comments).toHaveLength(1);
    });

    it(`${c.name}: a crash before the label edit does not double-post`, async () => {
      const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
      const k8s = new FakeK8s({ jobs: [c.job()] });

      await run({ github, k8s });
      // The world as a crashed pass would leave it: comment posted, label not moved.
      (await github.getIssue(REPO, SPEC))!.labels = [...GATE_LABELS];

      await run({ github, k8s });

      expect(github.comments).toHaveLength(1);
    });
  }

  it("never writes agent:in-progress on any of these paths", async () => {
    for (const c of cases) {
      const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
      const k8s = new FakeK8s({ jobs: [c.job()] });
      await run({ github, k8s });
      expect(await specLabels(github)).not.toContain("agent:in-progress");
      for (const write of github.writeLog) expect(write, c.name).not.toContain("agent:in-progress");
    }
  });
});

describe("a spec outside its label gate drives nothing", () => {
  it("does not start a closeout Job for a spec that lost ready-for-agent", async () => {
    const github = closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    github.issues[0]!.labels = ["ready-for-human", "agent:implement"];
    const k8s = new FakeK8s();

    await run({ github, k8s });

    expect(k8s.writeLog).toEqual([]);
    expect(github.writeLog).toEqual([]);
  });

  it("does not treat an issue without sub-issues as a spec", async () => {
    const github = new FakeGitHub({ issues: [issue(34, GATE_LABELS)] });
    const k8s = new FakeK8s();

    await run({ github, k8s });

    expect(k8s.writeLog).toEqual([]);
    expect(github.writeLog).toEqual([]);
  });

  it("does not start a closeout Job while an open sub-issue is still in the Frontier", async () => {
    const github = specWorld({ specNumber: SPEC, subIssueNumbers: [34] });
    const k8s = new FakeK8s();

    await run({ github, k8s });

    expect(k8s.jobs.map((job) => job.name)).toEqual([jobName(REPO, 34)]);
  });
});

describe("the spec label set across every pass outcome", () => {
  /**
   * One row per S-state this ticket can produce, driven through the same pass.
   * `agent:in-progress` is the assertion that matters: it means "a Job occupies
   * this issue", and a spec's loop is never one Job (§4.5).
   */
  const scenarios: Array<{ name: string; world: () => { github: FakeGitHub; k8s: FakeK8s } }> = [
    {
      name: "S1 with a claimable Frontier",
      world: () => ({ github: specWorld({ specNumber: SPEC, subIssueNumbers: [34] }), k8s: new FakeK8s() }),
    },
    {
      name: "S1 idle (open sub-issues, empty Frontier)",
      world: () => ({
        github: specWorld({
          specNumber: SPEC,
          subIssueNumbers: [34],
          subIssueLabels: { 34: ["ready-for-human", "agent:implement", "agent:blocked"] },
        }),
        k8s: new FakeK8s(),
      }),
    },
    {
      name: "S1 → S2 starting the closeout Job",
      world: () => ({ github: closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] }), k8s: new FakeK8s() }),
    },
    {
      name: "S2 with the closeout Job still running",
      world: () => ({
        github: closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] }),
        k8s: new FakeK8s({ jobs: [closeoutJob(REPO, SPEC)] }),
      }),
    },
    {
      name: "S3 done without newTickets",
      world: () => ({
        github: closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] }),
        k8s: new FakeK8s({
          jobs: [
            closeoutJob(REPO, SPEC, {
              finished: true,
              annotation: runResult({ v: 1, outcome: "done", summary: "s", prBody: "p" }),
            }),
          ],
        }),
      }),
    },
    {
      name: "S3N done with newTickets",
      world: () => ({
        github: closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] }),
        k8s: new FakeK8s({
          jobs: [
            closeoutJob(REPO, SPEC, {
              finished: true,
              annotation: runResult({
                v: 1,
                outcome: "done",
                summary: "s",
                prBody: "p",
                newTickets: [{ title: "more work", body: "b", readyForAgent: true }],
              }),
            }),
          ],
        }),
      }),
    },
    {
      name: "S4 blocked",
      world: () => ({
        github: closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] }),
        k8s: new FakeK8s({
          jobs: [
            closeoutJob(REPO, SPEC, {
              finished: true,
              annotation: runResult({ v: 1, outcome: "blocked", summary: "s", commentBody: "c" }),
            }),
          ],
        }),
      }),
    },
    {
      name: "S5 error",
      world: () => ({
        github: closedOutSpecWorld({ specNumber: SPEC, subIssueNumbers: [34] }),
        k8s: new FakeK8s({ jobs: [closeoutJob(REPO, SPEC, { finished: true, failedReason: "DeadlineExceeded" })] }),
      }),
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.name}: the spec never carries agent:in-progress`, async () => {
      const { github, k8s } = scenario.world();

      await run({ github, k8s });
      // Two passes: the first one's writes must not put the spec in a state the
      // second one reads as "a Job occupies this spec".
      await run({ github, k8s });

      expect(await specLabels(github)).not.toContain("agent:in-progress");
      // Scoped to the spec's own label edits: the *ticket* Claim does write
      // `agent:in-progress`, and that is exactly the label's one meaning.
      const specLabelWrites = github.writeLog.filter((write) => write.startsWith(`editLabels ${REPO}#${SPEC} `));
      for (const write of specLabelWrites) expect(write).not.toContain("agent:in-progress");
    });
  }
});
