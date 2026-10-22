import { describe, expect, it } from "vitest";
import { ANNOTATIONS, jobName, pvcName, tokenSecretName } from "@remote-agent/shared";
import { runReconcilePass } from "../src/reconcile.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import { testConfig } from "./helpers.js";
import { GATE_LABELS, REPO, managedJob, specWorld, ticketPvc, tokenSecret } from "./world.js";

/**
 * Pass ordering (ADR-0011, spec #33 §2): Claim / outcome handling run **before**
 * reclamation in the same pass. The world below holds both shapes at once — a
 * claimable ticket and an expired volume — and the assertion is on the order of
 * the write calls, because the order is the property, not an implementation
 * detail: deleting before the labels and `expires-at` reach their end-of-pass
 * values would let a volume claimed this pass be reclaimed in the same pass.
 */

const NOW = new Date("2025-03-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIMABLE = 41;
const EXPIRED = 42;

function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * DAY_MS).toISOString();
}

/** One spec, one claimable ticket, and one expired volume belonging to another ticket. */
function mixedWorld() {
  const github = specWorld({
    specNumber: 33,
    subIssueNumbers: [CLAIMABLE, EXPIRED],
    // The expired ticket is out of the gate (its outcome was judged already);
    // only CLAIMABLE is a Frontier candidate.
    subIssueLabels: { [CLAIMABLE]: GATE_LABELS, [EXPIRED]: [...GATE_LABELS, "agent:done"] },
  });
  const k8s = new FakeK8s({
    pvcs: [ticketPvc(REPO, EXPIRED, { expiresAt: daysFromNow(-1) })],
    secrets: [tokenSecret(REPO, EXPIRED)],
  });
  return { github, k8s };
}

describe("pass ordering: Claim before reclamation", () => {
  it("claims the ticket before deleting the expired volume, in one pass", async () => {
    const { github, k8s } = mixedWorld();

    await runReconcilePass({ github, k8s, config: testConfig(), now: () => NOW }, "webhook");

    // Both happened in this one pass...
    const created = k8s.writeLog.indexOf(`createPvc ${pvcName(REPO, CLAIMABLE)}`);
    const claimedLabel = github.writeLog.indexOf(`editLabels ${REPO}#${CLAIMABLE} +[agent:in-progress] -[]`);
    const deletedPvc = k8s.writeLog.indexOf(`deletePvc ${pvcName(REPO, EXPIRED)}`);
    const deletedSecret = k8s.writeLog.indexOf(`deleteSecret ${tokenSecretName(jobName(REPO, EXPIRED))}`);

    expect(created).toBeGreaterThanOrEqual(0);
    expect(claimedLabel).toBeGreaterThanOrEqual(0);
    expect(deletedPvc).toBeGreaterThanOrEqual(0);
    expect(deletedSecret).toBeGreaterThanOrEqual(0);

    // ...and every Claim write came before every reclamation delete.
    expect(created).toBeLessThan(deletedPvc);
    expect(claimedLabel).toBeLessThan(deletedPvc);
    expect(deletedPvc).toBeLessThan(deletedSecret);
  });

  it("the claimed volume is not reclaimed in the same pass (its expiry is cleared first)", async () => {
    // The claimable ticket's own volume already exists and still carries the
    // expiry of its previous run. Claim clears it; reclamation must then see a
    // volume with no clock rather than a deletable one.
    const github = specWorld({ specNumber: 33, subIssueNumbers: [CLAIMABLE] });
    const k8s = new FakeK8s({
      pvcs: [ticketPvc(REPO, CLAIMABLE, { expiresAt: daysFromNow(-1) })],
    });

    await runReconcilePass({ github, k8s, config: testConfig(), now: () => NOW }, "webhook");

    expect(k8s.pvcs.map((p) => p.name)).toEqual([pvcName(REPO, CLAIMABLE)]);
    expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBeUndefined();
    expect(k8s.writeLog.filter((entry) => entry.startsWith("deletePvc"))).toEqual([]);
  });

  it("a judged outcome writes expires-at before reclamation reads it", async () => {
    // T4 shape: the Job completed with a done result. The outcome step writes
    // `expires-at = now + 7d`; reclamation must see that clock, not delete.
    const github = specWorld({
      specNumber: 33,
      subIssueNumbers: [EXPIRED],
      subIssueLabels: { [EXPIRED]: [...GATE_LABELS, "agent:in-progress"] },
    });
    const job = managedJob(REPO, EXPIRED, { finished: true });
    job.conditions = [{ type: "Complete", status: "True" }];
    job.annotations[ANNOTATIONS.runResult] = JSON.stringify({ v: 1, outcome: "done", summary: "shipped" });
    const k8s = new FakeK8s({
      jobs: [job],
      pvcs: [ticketPvc(REPO, EXPIRED)],
    });

    const result = await runReconcilePass({ github, k8s, config: testConfig(), now: () => NOW }, "job-watch");

    const pvc = k8s.pvcs[0]!;
    expect(pvc.annotations[ANNOTATIONS.expiresAt]).toBe(daysFromNow(7));
    expect(k8s.writeLog.filter((entry) => entry.startsWith("deletePvc"))).toEqual([]);
    expect(result.volumeStats.live).toBe(1);
    expect(result.volumeStats.oldestExpiry).toBe(daysFromNow(7));
  });
});
