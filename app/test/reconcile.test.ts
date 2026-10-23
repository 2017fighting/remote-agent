import { describe, expect, it } from "vitest";
import { jobName } from "@remote-agent/shared";
import { JOB_ENV_KEYS, isWorkItemV1, type WorkItemV1 } from "@remote-agent/shared";
import { runReconcilePass, type WorldSnapshot } from "../src/reconcile.js";
import { FakeGitHub } from "../src/fakes/FakeGitHub.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import { existingPvc, testConfig } from "./helpers.js";
import { GATE_LABELS, REPO, issue, managedJob, specWorld } from "./world.js";

/**
 * Pass-level behaviour of reconcile (spec #33 §2): read world → plan → execute
 * → counters. Reconcile is stateless across passes (ADR-0001), so every pass
 * recomputes from the world, and a replay over an unchanged world issues zero
 * new external writes.
 *
 * Claim-specific behaviour (write order, failure injection, 409/403, job
 * object decision surface) lives in claim.test.ts on the same seam.
 */

const config = testConfig();

/** A world with no spec in it: nothing to claim, so the pass writes nothing. */
function idleWorld() {
  return {
    github: new FakeGitHub({ issues: [issue(34, GATE_LABELS)] }),
    k8s: new FakeK8s(),
  };
}

describe("reconcile pass: counters", () => {
  it("returns the five counters and the global Slot cap", async () => {
    const { github, k8s } = idleWorld();
    const result = await runReconcilePass({ github, k8s, config }, "startup");
    expect(result).toEqual({
      slotsUsed: 0,
      slotsMax: 3,
      deferred: 0,
      renewed: 0,
      waiting: 0,
      volumeStats: { live: 0, oldestExpiry: null, perSpec: [] },
    });
  });

  it("reports the configured global cap (MAX_JOBS_GLOBAL)", async () => {
    const { github, k8s } = idleWorld();
    const result = await runReconcilePass({ github, k8s, config: testConfig({ MAX_JOBS_GLOBAL: "5" }) }, "tick");
    expect(result.slotsMax).toBe(5);
  });

  it("counts a ticket held by a lingering Job object as waiting (ADR-0013), without any write", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [34] });
    const k8s = new FakeK8s({ jobs: [managedJob(REPO, 34)] });
    const result = await runReconcilePass({ github, k8s, config }, "tick");
    expect(result.waiting).toBe(1);
    expect(result.deferred).toBe(0);
    expect(result.slotsUsed).toBe(0);
    expect(github.writeLog).toEqual([]);
    expect(k8s.writeLog).toEqual([]);
  });

  it("does not count blocked, errored or already-claimed tickets as waiting", async () => {
    // Those tickets need a human or are already running; "waiting" is only the
    // ADR-0013 shape (in the gate, held by an old Job object).
    const cases: Record<string, string[]> = {
      blocked: ["ready-for-human", "agent:blocked", "agent:implement"],
      errored: ["ready-for-human", "agent:error", "agent:implement"],
    };
    for (const [name, labels] of Object.entries(cases)) {
      const github = specWorld({ specNumber: 33, subIssueNumbers: [34], subIssueLabels: { 34: labels } });
      const result = await runReconcilePass({ github, k8s: new FakeK8s(), config }, "tick");
      expect(result.waiting, name).toBe(0);
      expect(result.deferred, name).toBe(0);
      expect(github.writeLog, name).toEqual([]);
    }
  });

  it("a ticket nobody authorized is not waiting — it is simply not claimable", async () => {
    // Ticket #46: `ready-for-agent` alone is not authorization, and here the
    // spec carries none either, so the ticket never enters the gate.
    const github = specWorld({ specNumber: 33, subIssueNumbers: [34], subIssueLabels: { 34: ["ready-for-agent"] } });
    github.issues[0] = issue(33, ["ready-for-agent"]);
    const result = await runReconcilePass({ github, k8s: new FakeK8s(), config }, "tick");
    expect(result.waiting).toBe(0);
    expect(result.deferred).toBe(0);
    expect(result.slotsUsed).toBe(0);
    expect(github.writeLog).toEqual([]);
  });

  it("an already-claimed ticket with no Job is judged T6e, not counted as waiting", async () => {
    // `waiting` is the gate shape (no agent:in-progress). An in-progress ticket
    // whose deterministic-name Job is gone is the T6e fallback instead.
    const github = specWorld({
      specNumber: 33,
      subIssueNumbers: [34],
      subIssueLabels: { 34: [...GATE_LABELS, "agent:in-progress"] },
    });
    const result = await runReconcilePass({ github, k8s: new FakeK8s(), config }, "tick");
    expect(result.waiting).toBe(0);
    expect(result.deferred).toBe(0);
    expect((await github.getIssue(REPO, 34))?.labels).toEqual([
      "agent:implement",
      "ready-for-human",
      "agent:error",
    ]);
  });
});

describe("reconcile pass: Slot occupancy", () => {
  it("counts a held Slot when a managed Job has a non-terminal pod; terminal pods release it", async () => {
    const { github, k8s } = idleWorld();
    const job = managedJob(REPO, 34);
    k8s.jobs.push(job);
    k8s.pvcs.push(existingPvc(job.name));

    // No pods → no Slots held.
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(0);

    k8s.pods.push({ name: `${job.name}-pod`, namespace: "remote-agent", ownerJobName: job.name, phase: "Running", deleting: false });
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(1);

    // Terminating still counts as holding (spec §5).
    k8s.pods[0]!.deleting = true;
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(1);

    // A terminal pod releases the Slot.
    k8s.pods[0]!.phase = "Succeeded";
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(0);
  });

  it("ignores pods owned by Jobs the App does not manage", async () => {
    const { github, k8s } = idleWorld();
    k8s.jobs.push({ name: "somebody-elses-job", namespace: "remote-agent", labels: {}, annotations: {}, conditions: [], finished: false });
    k8s.pods.push({ name: "foreign-pod", namespace: "remote-agent", ownerJobName: "somebody-elses-job", phase: "Running", deleting: false });
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(0);
  });

  it("counts several pods of one Job as one Slot", async () => {
    const { github, k8s } = idleWorld();
    const job = managedJob(REPO, 34);
    k8s.jobs.push(job);
    for (const phase of ["Pending", "Running"]) {
      k8s.pods.push({ name: `${job.name}-${phase}`, namespace: "remote-agent", ownerJobName: job.name, phase, deleting: false });
    }
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(1);
  });
});

describe("reconcile pass: the claimed ticket's work item", () => {
  /** The `AGENT_WORK_ITEM` the pass put on the Job it created, parsed as v1. */
  function claimedWorkItem(k8s: FakeK8s): WorkItemV1 {
    const env = k8s.jobManifests[0]!.podTemplate.containers[0]!.env!;
    const raw = env.find((e) => e.name === JOB_ENV_KEYS.agentWorkItem)?.value;
    const parsed: unknown = JSON.parse(raw ?? "null");
    expect(isWorkItemV1(parsed)).toBe(true);
    return parsed as WorkItemV1;
  }

  it("carries the parent spec's body so the Spec axis has something to review", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [34] });
    github.issues[0]!.body = "## Spec 33\n\nthe spec's own body";
    const k8s = new FakeK8s();

    await runReconcilePass({ github, k8s, config }, "webhook");

    const workItem = claimedWorkItem(k8s);
    expect(workItem.number).toBe(34);
    expect(workItem.specNumber).toBe(33);
    expect(workItem.specBody).toBe("## Spec 33\n\nthe spec's own body");
    // The ticket's own body is untouched: `specBody` is the parent, not a copy.
    expect(workItem.body).toBe("Body of #34");
  });

  it("costs no extra GitHub read: the spec was already read during planning", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [34] });
    const getIssue = github.getIssue.bind(github);
    let specReads = 0;
    github.getIssue = async (ownerRepo: string, issueNumber: number) => {
      if (issueNumber === 33) specReads += 1;
      return getIssue(ownerRepo, issueNumber);
    };

    await runReconcilePass({ github, k8s: new FakeK8s(), config }, "webhook");

    expect(specReads).toBe(0);
  });
});

describe("reconcile pass: statelessness and replayability", () => {
  it("exposes the world snapshot it read (no state carried between passes)", async () => {
    const { github, k8s } = idleWorld();
    const seen: WorldSnapshot[] = [];
    await runReconcilePass({ github, k8s, config, onWorldRead: (world) => seen.push(world) }, "startup");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.issues.map((i) => i.number)).toEqual([34]);
  });

  it("a claim pass followed by a second pass over the new world makes zero new writes", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [34] });
    const k8s = new FakeK8s();
    await runReconcilePass({ github, k8s, config }, "startup");

    const githubWrites = github.writeLog.length;
    const k8sWrites = k8s.writeLog.length;
    expect(githubWrites).toBeGreaterThan(0);
    expect(k8sWrites).toBeGreaterThan(0);

    // The Job controller starts the pod; from now on the Job holds its Slot.
    const job = k8s.jobs[0]!;
    k8s.pods.push({ name: `${job.name}-pod`, namespace: "remote-agent", ownerJobName: job.name, phase: "Running", deleting: false });

    const second = await runReconcilePass({ github, k8s, config }, "tick");
    expect(github.writeLog.length).toBe(githubWrites);
    expect(k8s.writeLog.length).toBe(k8sWrites);
    expect(second.slotsUsed).toBe(1);
  });

  it("makes no writes at all when nothing is claimable", async () => {
    const { github, k8s } = idleWorld();
    await runReconcilePass({ github, k8s, config }, "webhook");
    expect(github.writeLog).toEqual([]);
    expect(k8s.writeLog).toEqual([]);
  });

  it("a spec that is closed or whose own facts are out of the gate never yields a claim", async () => {
    // Ticket #46: the spec's own `agent:implement` is not on this list — a ticket
    // that carries it itself is claimed anyway (gate-pass.test.ts). What still
    // stops the loop is the spec's own state: closed, blocked, errored, no
    // `ready-for-agent`, an open blocker.
    for (const spec of [
      issue(33, GATE_LABELS, { state: "closed" }),
      issue(33, ["agent:implement"]),
      issue(33, [...GATE_LABELS, "agent:blocked"]),
      issue(33, [...GATE_LABELS, "agent:error"]),
    ]) {
      const github = specWorld({ specNumber: 33, subIssueNumbers: [34], extraIssues: [] });
      github.issues[0] = spec;
      const k8s = new FakeK8s();
      const result = await runReconcilePass({ github, k8s, config }, "tick");
      expect(github.writeLog, `${JSON.stringify(spec.labels)} ${spec.state}`).toEqual([]);
      expect(k8s.writeLog).toEqual([]);
      expect(result.slotsUsed).toBe(0);
    }
  });

  it("a spec that only lacks its own agent:implement still advances a self-authorized ticket", async () => {
    // The other half of ticket #46: authorization is not part of "the spec may
    // drive its sub-issues", because the ticket may carry it.
    const github = specWorld({ specNumber: 33, subIssueNumbers: [34] });
    github.issues[0] = issue(33, ["ready-for-agent"]);
    const k8s = new FakeK8s();
    const result = await runReconcilePass({ github, k8s, config }, "tick");
    expect(k8s.jobs.map((job) => job.name)).toEqual([jobName(REPO, 34)]);
    expect(result.slotsUsed).toBe(1);
  });
});
