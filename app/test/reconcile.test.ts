import { describe, expect, it } from "vitest";
import { runReconcilePass, type WorldSnapshot } from "../src/reconcile.js";
import { FakeGitHub } from "../src/fakes/FakeGitHub.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import { existingJob, existingPvc, testConfig } from "./helpers.js";

/**
 * Reconcile pass skeleton (#34): read world → plan (always empty in this
 * ticket) → execute → counters. Reconcile is stateless across passes
 * (ADR-0001): no in-memory indexes; every pass recomputes from the world.
 * Replayability (spec #33 §2): running twice on the same world produces zero
 * new external writes in the second run.
 */

const config = testConfig();

function makeWorld(): { github: FakeGitHub; k8s: FakeK8s } {
  const github = new FakeGitHub({
    issues: [
      {
        ownerRepo: "2017fighting/remote-agent",
        number: 33,
        state: "open",
        title: "Spec: remote-agent v1",
        body: "...",
        labels: ["ready-for-agent", "agent:implement"],
      },
      {
        ownerRepo: "2017fighting/remote-agent",
        number: 34,
        state: "open",
        title: "App skeleton",
        body: "...",
        labels: ["ready-for-agent", "agent:implement"],
      },
    ],
    subIssues: [{ ownerRepo: "2017fighting/remote-agent", specNumber: 33, issueNumbers: [34] }],
  });
  const k8s = new FakeK8s();
  return { github, k8s };
}

describe("reconcile pass skeleton", () => {
  it("reads the world and returns the five counters with zero used slots", async () => {
    const { github, k8s } = makeWorld();
    const result = await runReconcilePass({ github, k8s, config }, "startup");
    expect(result).toEqual({
      slotsUsed: 0,
      slotsMax: 3,
      deferred: 0,
      renewed: 0,
      waiting: 0,
    });
  });

  it("executes no writes against a world this ticket has no planner for", async () => {
    const { github, k8s } = makeWorld();
    await runReconcilePass({ github, k8s, config }, "webhook");
    expect(github.writeLog).toHaveLength(0);
    expect(k8s.writeLog).toHaveLength(0);
    expect(github.issues[1]!.labels).toEqual(["ready-for-agent", "agent:implement"]);
  });

  it("counts a held slot when a managed Job has a non-terminal pod; terminal pods release it", async () => {
    const { github, k8s } = makeWorld();
    const jobName = "agent-2017fighting-remote-agent-34";
    k8s.jobs.push(
      existingJob({
        name: jobName,
        labels: {
          "app.kubernetes.io/managed-by": "remote-agent",
          "remote-agent/ticket": "2017fighting/remote-agent#34",
        },
      }),
    );
    k8s.pvcs.push(existingPvc(jobName));

    // No pods → no slots held.
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(0);

    // A running pod holds one slot.
    k8s.pods.push({
      name: `${jobName}-pod`,
      namespace: "remote-agent",
      ownerJobName: jobName,
      phase: "Running",
      deleting: false,
    });
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(1);

    // Terminating still counts as holding (spec §5).
    k8s.pods[0]!.deleting = true;
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(1);

    // A terminal pod releases the slot.
    k8s.pods[0]!.phase = "Succeeded";
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(0);
  });

  it("ignores pods owned by Jobs the App does not manage", async () => {
    const { github, k8s } = makeWorld();
    k8s.jobs.push(existingJob({ name: "somebody-elses-job" }));
    k8s.pods.push({
      name: "foreign-pod",
      namespace: "remote-agent",
      ownerJobName: "somebody-elses-job",
      phase: "Running",
      deleting: false,
    });
    expect((await runReconcilePass({ github, k8s, config }, "tick")).slotsUsed).toBe(0);
  });

  it("replayability: two passes on the same world → the second pass makes zero new writes", async () => {
    const { github, k8s } = makeWorld();
    const first = await runReconcilePass({ github, k8s, config }, "startup");
    expect(first.slotsUsed).toBe(0);

    const githubWritesBefore = github.writeLog.length;
    const k8sWritesBefore = k8s.writeLog.length;
    const second = await runReconcilePass({ github, k8s, config }, "webhook");
    expect(github.writeLog.length).toBe(githubWritesBefore);
    expect(k8s.writeLog.length).toBe(k8sWritesBefore);
    expect(second).toEqual(first);
  });

  it("exposes the world snapshot it read (no state carried between passes)", async () => {
    const { github, k8s } = makeWorld();
    const seen: WorldSnapshot[] = [];
    const result = await runReconcilePass(
      { github, k8s, config, onWorldRead: (w) => seen.push(w) },
      "startup",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.issues.map((i) => i.number)).toEqual([33, 34]);
    expect(result.slotsMax).toBe(3);
  });
});
