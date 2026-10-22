import { describe, expect, it } from "vitest";
import { ANNOTATIONS, jobName, pvcName } from "@remote-agent/shared";
import { runReconcilePass, type ReconcileDeps } from "../src/reconcile.js";
import { FakeGitHub } from "../src/fakes/FakeGitHub.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import type { K8sJob, K8sPod, K8sPvc } from "../src/ports/K8sPort.js";
import { testConfig } from "./helpers.js";
import { GATE_LABELS, REPO, issue, managedJob, specWorld } from "./world.js";

/**
 * Outcome handling on the App seam (spec #33 §2 step 2): one `reconcile()` pass
 * over a fake world that holds a ticket in T3. Asserts external behaviour only —
 * the final label set, the issue state, the comments posted, the PVC annotation
 * and the write order.
 *
 * The pure transition table lives in outcome-judge.test.ts; this file is about
 * what the pass *does* with each transition.
 */

const TICKET = 36;
const IN_PROGRESS = [...GATE_LABELS, "agent:in-progress"];
const NOW = new Date("2025-03-01T12:00:00.000Z");
const config = testConfig();

/** The world as the Claim left it: ticket in-progress, deterministic Job, Ticket PVC. */
function claimedWorld(options: { job?: K8sJob | null; pods?: K8sPod[]; pvc?: K8sPvc | null } = {}) {
  const github = specWorld({
    specNumber: 33,
    subIssueNumbers: [TICKET],
    subIssueLabels: { [TICKET]: IN_PROGRESS },
  });
  const name = jobName(REPO, TICKET);
  const job = options.job === undefined ? managedJob(REPO, TICKET) : options.job;
  const pvc = options.pvc === undefined ? { name, namespace: "remote-agent", annotations: {}, labels: {} } : options.pvc;
  const k8s = new FakeK8s({
    jobs: job === null ? [] : [job],
    pods: options.pods ?? [],
    pvcs: pvc === null ? [] : [pvc],
  });
  return { github, k8s, name };
}

function completedJob(annotation?: string): K8sJob {
  const job = managedJob(REPO, TICKET, { finished: true });
  job.conditions = [{ type: "Complete", status: "True" }];
  if (annotation !== undefined) job.annotations[ANNOTATIONS.runResult] = annotation;
  return job;
}

function failedJob(reason: string): K8sJob {
  const job = managedJob(REPO, TICKET, { finished: true });
  job.conditions = [{ type: "Failed", status: "True", reason }];
  return job;
}

function run(deps: Pick<ReconcileDeps, "github" | "k8s">) {
  return runReconcilePass({ ...deps, config, now: () => NOW }, "job-watch");
}

/** Labels as a set: `editLabels` preserves insertion order, the state table does not care. */
async function labelsOf(github: FakeGitHub, number = TICKET): Promise<string[]> {
  const issue = await github.getIssue(REPO, number);
  return [...(issue?.labels ?? [])].sort();
}

describe("outcome: T4 done", () => {
  it("closes the ticket, drops agent:in-progress, keeps agent:implement and posts the summary", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(JSON.stringify({ v: 1, outcome: "done", summary: "implemented the widget" })),
    });

    await run({ github, k8s });

    expect(await labelsOf(github)).toEqual(["agent:implement", "ready-for-agent"]);
    expect((await github.getIssue(REPO, TICKET))?.state).toBe("closed");
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body).toContain("implemented the widget");
    expect(github.comments[0]!.body).toContain(`<!-- remote-agent:done:${jobName(REPO, TICKET)} -->`);
  });

  it("uses commentBody when the agent gave one", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(
        JSON.stringify({
          v: 1,
          outcome: "done",
          summary: "the short summary",
          commentBody: "## What changed\n\nA much longer body.",
        }),
      ),
    });

    await run({ github, k8s });

    expect(github.comments[0]!.body).toContain("## What changed");
    expect(github.comments[0]!.body).not.toContain("the short summary");
  });

  it("appends warnings[] at the end of the done comment", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(
        JSON.stringify({
          v: 1,
          outcome: "done",
          summary: "done",
          commentBody: "Body text.",
          warnings: ["flaky test in packages/x", "left a TODO in y.ts"],
        }),
      ),
    });

    await run({ github, k8s });

    const body = github.comments[0]!.body;
    expect(body.indexOf("Body text.")).toBeLessThan(body.indexOf("flaky test in packages/x"));
    expect(body.indexOf("flaky test in packages/x")).toBeLessThan(body.indexOf("left a TODO in y.ts"));
    expect(body.trimEnd().endsWith("left a TODO in y.ts")).toBe(true);
  });

  it("creates sub-issues before closing the ticket, labelling each by readyForAgent", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(
        JSON.stringify({
          v: 1,
          outcome: "done",
          summary: "done",
          newTickets: [
            { title: "follow-up a", body: "body a", readyForAgent: true },
            { title: "follow-up b", body: "body b", readyForAgent: false },
          ],
        }),
      ),
    });

    await run({ github, k8s });

    const created = github.issues.filter((i) => i.number !== TICKET && i.number !== 33);
    expect(created.map((i) => i.title)).toEqual(["follow-up a", "follow-up b"]);
    expect(created[0]!.labels).toEqual(["ready-for-agent"]);
    expect(created[1]!.labels).toEqual(["ready-for-human"]);

    // Order is the contract: the reverse would leave a window where the ticket
    // is closed and its follow-ups do not exist yet.
    const createdIndex = github.writeLog.findIndex((w) => w.startsWith("createIssue"));
    const closeIndex = github.writeLog.findIndex((w) => w.startsWith(`closeIssue ${REPO}#${TICKET}`));
    expect(createdIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(createdIndex);
  });

  it("writes expires-at on the Ticket PVC 7 days out, in the judging pass", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(JSON.stringify({ v: 1, outcome: "done", summary: "done" })),
    });

    await run({ github, k8s });

    expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBe("2025-03-08T12:00:00.000Z");
    expect(k8s.writeLog.filter((w) => w.startsWith("patchPvcAnnotations"))).toHaveLength(1);
  });

  it("does not overwrite an expires-at that is already running", async () => {
    const { github, k8s, name } = claimedWorld({
      job: completedJob(JSON.stringify({ v: 1, outcome: "done", summary: "done" })),
      pvc: {
        name: jobName(REPO, TICKET),
        namespace: "remote-agent",
        annotations: { [ANNOTATIONS.expiresAt]: "2025-02-01T00:00:00.000Z" },
        labels: {},
      },
    });

    await run({ github, k8s });

    expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBe("2025-02-01T00:00:00.000Z");
    expect(k8s.writeLog).not.toContain(`patchPvcAnnotations ${name}`);
  });
});

describe("outcome: T5 blocked", () => {
  it("swaps ready-for-agent for ready-for-human + agent:blocked and keeps the ticket open", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(
        JSON.stringify({
          v: 1,
          outcome: "blocked",
          summary: "cannot proceed",
          commentBody: "The migration needs a schema decision from a human.",
        }),
      ),
    });

    await run({ github, k8s });

    expect(await labelsOf(github)).toEqual(["agent:blocked", "agent:implement", "ready-for-human"]);
    expect((await github.getIssue(REPO, TICKET))?.state).toBe("open");
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body).toContain("The migration needs a schema decision from a human.");
    expect(github.comments[0]!.body).toContain(`<!-- remote-agent:blocked:${jobName(REPO, TICKET)} -->`);
  });

  it("writes expires-at 30 days out", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(JSON.stringify({ v: 1, outcome: "blocked", summary: "s", commentBody: "c" })),
    });

    await run({ github, k8s });

    expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBe("2025-03-31T12:00:00.000Z");
  });
});

describe("outcome: T6a–e all land on the same error label set", () => {
  const cases: Array<{ name: string; reason: string; world: () => ReturnType<typeof claimedWorld> }> = [
    {
      name: "T6a self-reported error",
      reason: "app-judged",
      world: () =>
        claimedWorld({
          job: completedJob(JSON.stringify({ v: 1, outcome: "error", summary: "contract-allowed shape" })),
        }),
    },
    {
      name: "T6b backoff exhausted",
      reason: "backoff-exhausted",
      world: () => claimedWorld({ job: failedJob("BackoffLimitExceeded") }),
    },
    {
      name: "T6c deadline exceeded",
      reason: "deadline-exceeded",
      world: () => claimedWorld({ job: failedJob("DeadlineExceeded") }),
    },
    {
      name: "T6d no annotation on a Complete Job",
      reason: "no-result",
      world: () => claimedWorld({ job: completedJob() }),
    },
    {
      name: "T6d unparseable annotation",
      reason: "no-result",
      world: () => claimedWorld({ job: completedJob("{ this is not json") }),
    },
    {
      name: "T6e in-progress with no Job",
      reason: "no-job",
      world: () => claimedWorld({ job: null }),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: ready-for-human + agent:error, ticket open, one comment`, async () => {
      const { github, k8s } = c.world();
      await run({ github, k8s });

      expect(await labelsOf(github)).toEqual(["agent:error", "agent:implement", "ready-for-human"]);
      expect((await github.getIssue(REPO, TICKET))?.state).toBe("open");
      expect(github.comments).toHaveLength(1);
      expect(github.comments[0]!.body).toContain("outcome=error");
      expect(github.comments[0]!.body).toContain(c.reason);
      // `error` is the human's entry point: no automatic retry writes anything.
      expect(k8s.writeLog.filter((w) => w.startsWith("createJob"))).toEqual([]);
      expect(github.writeLog.filter((w) => w.startsWith("createIssue"))).toEqual([]);
    });
  }

  it("never removes agent:implement (the App never revokes authorization)", async () => {
    const { github, k8s } = claimedWorld({ job: failedJob("DeadlineExceeded") });
    await run({ github, k8s });
    for (const write of github.writeLog) expect(write).not.toContain("- [ready-for-agent,agent:implement");
  });
});

describe("outcome: evidence comment contents (docs/architecture.md §4.6)", () => {
  function evidenceWorld(reason: "backoff" | "deadline" | "no-result" | "no-job") {
    const job =
      reason === "no-result"
        ? completedJob()
        : reason === "no-job"
          ? null
          : failedJob(reason === "backoff" ? "BackoffLimitExceeded" : "DeadlineExceeded");
    const pod: K8sPod = {
      name: `${jobName(REPO, TICKET)}-abcde`,
      namespace: "remote-agent",
      ownerJobName: jobName(REPO, TICKET),
      phase: "Failed",
      deleting: false,
      containerStatuses: [{ name: "runner", reason: "OOMKilled", exitCode: 137 }],
    };
    const world = claimedWorld({ job, pods: job === null ? [] : [pod] });
    world.k8s.podLogs.set(pod.name, "line one\nline two\nthe last line before dying\n");
    return { ...world, pod };
  }

  for (const reason of ["backoff", "deadline", "no-result", "no-job"] as const) {
    it(`${reason}: reason, Job/pod names, pod evidence, log tail, PVC name + retention, re-entry and unpushed warning`, async () => {
      const { github, k8s, pod } = evidenceWorld(reason);
      await run({ github, k8s });

      const body = github.comments[0]!.body;
      const expectedReason =
        reason === "backoff" ? "backoff-exhausted" : reason === "deadline" ? "deadline-exceeded" : reason === "no-result" ? "no-result" : "no-job";

      expect(body).toContain("outcome=error");
      expect(body).toContain(expectedReason);
      expect(body).toContain(jobName(REPO, TICKET));
      expect(body).toContain(pvcName(REPO, TICKET));
      expect(body).toContain("kubectl delete job");
      expect(body).toContain("2025-03-31T12:00:00.000Z"); // retention date (30 days, ADR-0011)
      expect(body).toContain("never pushed"); // the volume may hold unpushed commits
      expect(body).toContain(`<!-- remote-agent:evidence:${jobName(REPO, TICKET)} -->`);

      if (reason === "no-job") {
        expect(body).toContain("no pod of this Job is left");
      } else {
        expect(body).toContain(pod.name);
        expect(body).toContain("OOMKilled");
        expect(body).toContain("exitCode");
        expect(body).toContain("the last line before dying");
      }
    });
  }

  it("T6a posts the error template, not the evidence template (a payload exists)", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(JSON.stringify({ v: 1, outcome: "error", summary: "contract-allowed shape" })),
    });
    await run({ github, k8s });
    expect(github.comments[0]!.body).toContain(`<!-- remote-agent:error:${jobName(REPO, TICKET)} -->`);
    expect(github.comments[0]!.body).toContain("contract-allowed shape");
  });
});

describe("outcome: replayability and dedupe", () => {
  it("a second pass over the judged world writes nothing", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(JSON.stringify({ v: 1, outcome: "done", summary: "done" })),
    });
    await run({ github, k8s });
    const githubWrites = github.writeLog.length;
    const k8sWrites = k8s.writeLog.length;

    await run({ github, k8s });

    expect(github.writeLog.length).toBe(githubWrites);
    expect(k8s.writeLog.length).toBe(k8sWrites);
    expect(github.comments).toHaveLength(1);
  });

  it("a crash between the comment and the label edit does not double-post (marker dedupe)", async () => {
    const { github, k8s } = claimedWorld({ job: failedJob("DeadlineExceeded") });
    await run({ github, k8s });
    expect(github.comments).toHaveLength(1);

    // Simulate the pass dying after the comment but before the label edit: the
    // ticket is back in T3 with the same Job and the same evidence.
    const ticket = github.issues.find((i) => i.number === TICKET)!;
    ticket.labels = [...IN_PROGRESS];

    await run({ github, k8s });

    expect(github.comments).toHaveLength(1);
  });

  it("reads the run-result annotation exactly once across two passes", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(JSON.stringify({ v: 1, outcome: "done", summary: "done" })),
    });

    await run({ github, k8s });
    // The old Job is still inside its retention window on the second pass.
    await run({ github, k8s });

    const runResultReads = k8s.jobAnnotationReads.filter((read) => read.key === ANNOTATIONS.runResult);
    expect(runResultReads).toHaveLength(1);
  });

  it("never reads the annotation on a Failed Job (no annotation exists on that path)", async () => {
    const { github, k8s } = claimedWorld({ job: failedJob("BackoffLimitExceeded") });
    await run({ github, k8s });
    expect(k8s.jobAnnotationReads.filter((r) => r.key === ANNOTATIONS.runResult)).toEqual([]);
  });
});

describe("outcome: expires-at lifecycle", () => {
  it("Claim clears expires-at when the ticket is re-entered onto the same volume", async () => {
    const { github, k8s } = claimedWorld({
      job: completedJob(JSON.stringify({ v: 1, outcome: "done", summary: "done" })),
    });
    await run({ github, k8s });
    expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBeDefined();

    // Human re-entry: back to ready-for-agent, and k8s has TTL-deleted the Job.
    const ticket = github.issues.find((i) => i.number === TICKET)!;
    ticket.state = "open";
    ticket.labels = [...GATE_LABELS];
    k8s.deleteJob(jobName(REPO, TICKET));

    await run({ github, k8s });

    expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBeUndefined();
    expect(await labelsOf(github)).toContain("agent:in-progress");
    // The volume was reused, not recreated.
    expect(k8s.writeLog.filter((w) => w.startsWith("createPvc"))).toHaveLength(0);
  });

  it("a Claim on a fresh volume writes no expires-at at all", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [TICKET] });
    const k8s = new FakeK8s();
    await run({ github, k8s });
    expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBeUndefined();
    expect(k8s.writeLog.some((w) => w.startsWith("clearPvcAnnotation"))).toBe(false);
  });
});

describe("outcome: T6e is one shape only", () => {
  it("a ticket merely waiting in the gate is never judged", async () => {
    // The ADR-0013 wait: in the gate, an old Job object still present.
    const github = specWorld({ specNumber: 33, subIssueNumbers: [TICKET] });
    const k8s = new FakeK8s({ jobs: [failedJob("DeadlineExceeded")] });

    const result = await run({ github, k8s });

    expect(result.waiting).toBe(1);
    expect(github.writeLog).toEqual([]);
    expect(github.comments).toEqual([]);
    expect(await labelsOf(github)).toEqual(["agent:implement", "ready-for-agent"]);
  });

  it("a ticket with no agent:in-progress and no Job is not an error either", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [TICKET] });
    const k8s = new FakeK8s();
    await run({ github, k8s });
    // Claim picks it up instead (this is the normal path).
    expect(await labelsOf(github)).toContain("agent:in-progress");
    expect(github.comments).toEqual([]);
  });
});

describe("outcome: an unclaimed ticket without a Ticket PVC", () => {
  it("still judges the outcome and posts the comment, skipping expires-at", async () => {
    const { github, k8s } = claimedWorld({
      job: failedJob("BackoffLimitExceeded"),
      pvc: null,
    });
    await run({ github, k8s });
    expect(await labelsOf(github)).toEqual(["agent:error", "agent:implement", "ready-for-human"]);
    expect(github.comments).toHaveLength(1);
  });
});

describe("outcome: a running Job is left alone", () => {
  it("T3 with a live Job: no writes at all, the ticket stays in-progress", async () => {
    const job = managedJob(REPO, TICKET);
    job.annotations[ANNOTATIONS.runResult] = JSON.stringify({ v: 1, outcome: "done", summary: "early" });
    const { github, k8s } = claimedWorld({ job });

    await run({ github, k8s });

    expect(github.writeLog).toEqual([]);
    expect(k8s.writeLog).toEqual([]);
    expect(await labelsOf(github)).toEqual(["agent:implement", "agent:in-progress", "ready-for-agent"]);
    expect(k8s.jobAnnotationReads.filter((r) => r.key === ANNOTATIONS.runResult)).toEqual([]);
  });
});

describe("outcome: step 2 runs before Claim (step 3) in one pass", () => {
  it("closes the finished ticket, then claims the next Frontier in the same pass", async () => {
    const done = 36;
    const next = 35;
    const github = specWorld({
      specNumber: 33,
      subIssueNumbers: [done, next],
      subIssueLabels: { [done]: IN_PROGRESS, [next]: GATE_LABELS },
    });
    const finished = managedJob(REPO, done, { finished: true });
    finished.conditions = [{ type: "Complete", status: "True" }];
    finished.annotations[ANNOTATIONS.runResult] = JSON.stringify({ v: 1, outcome: "done", summary: "done" });
    const k8s = new FakeK8s({
      jobs: [finished],
      pvcs: [{ name: jobName(REPO, done), namespace: "remote-agent", annotations: {}, labels: {} }],
    });

    await run({ github, k8s });

    const closeIndex = github.writeLog.indexOf(`closeIssue ${REPO}#${done}`);
    const claimIndex = github.writeLog.indexOf(`editLabels ${REPO}#${next} +[agent:in-progress] -[]`);
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeGreaterThan(closeIndex);
    // The judged ticket leaves T3 in the same pass the Frontier advances past it.
    expect(await labelsOf(github, done)).toEqual(["agent:implement", "ready-for-agent"]);
    expect(await labelsOf(github, next)).toContain("agent:in-progress");
  });
});

describe("outcome: a ticket fixture sanity check", () => {
  it("the in-progress fixture really is what the state table calls T3", () => {
    expect(issue(TICKET, IN_PROGRESS).labels).toContain("agent:in-progress");
  });
});
