import { describe, expect, it } from "vitest";
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
    expect(result).toEqual({ slotsUsed: 0, slotsMax: 3, deferred: 0, renewed: 0, waiting: 0 });
  });

  it("reports the configured global cap (MAX_JOBS_GLOBAL)", async () => {
    const { github, k8s } = idleWorld();
    const result = await runReconcilePass({ github, k8s, config: testConfig({ MAX_JOBS_GLOBAL: "5" }) }, "tick");
    expect(result.slotsMax).toBe(5);
  });

  it("counts a spec with open sub-issues but no frontier as waiting", async () => {
    const cases: Record<string, string[]> = {
      blocked: ["ready-for-human", "agent:blocked", "agent:implement"],
      errored: ["ready-for-human", "agent:error", "agent:implement"],
      "already claimed": [...GATE_LABELS, "agent:in-progress"],
    };
    for (const [name, labels] of Object.entries(cases)) {
      const github = specWorld({ specNumber: 33, subIssueNumbers: [34], subIssueLabels: { 34: labels } });
      const result = await runReconcilePass({ github, k8s: new FakeK8s(), config }, "tick");
      expect(result.waiting, name).toBe(1);
      expect(result.deferred, name).toBe(0);
      expect(github.writeLog, name).toEqual([]);
    }
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

  it("a spec that is closed or out of the gate never yields a claim", async () => {
    for (const spec of [
      issue(33, GATE_LABELS, { state: "closed" }),
      issue(33, ["ready-for-agent"]),
      issue(33, [...GATE_LABELS, "agent:blocked"]),
    ]) {
      const github = specWorld({ specNumber: 33, subIssueNumbers: [34], extraIssues: [] });
      github.issues[0] = spec;
      const k8s = new FakeK8s();
      const result = await runReconcilePass({ github, k8s, config }, "tick");
      expect(github.writeLog).toEqual([]);
      expect(k8s.writeLog).toEqual([]);
      expect(result.slotsUsed).toBe(0);
    }
  });
});
