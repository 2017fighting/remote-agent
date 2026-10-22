import { describe, expect, it } from "vitest";
import { ANNOTATIONS, jobName, pvcName, tokenSecretName } from "@remote-agent/shared";
import { runReconcilePass, type ReconcileResult } from "../src/reconcile.js";
import { ORPHAN_MIN_AGE_DAYS, volumeReclaimDecision, volumeStats } from "../src/planners/pvc-steward.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import type { K8sPvc } from "../src/ports/K8sPort.js";
import { testConfig } from "./helpers.js";
import { GATE_LABELS, OTHER_REPO, REPO, managedJob, specWorld, ticketPvc, tokenSecret } from "./world.js";

/**
 * Reclamation on the App seam (ADR-0011): one pass over a world holding expired,
 * unexpired and orphaned volumes. Asserts external behaviour only — which
 * objects are gone afterwards, which Secrets went with them, and the volume
 * stats line the pass reports.
 *
 * The unit half below pins the decision table directly, including the three
 * conditions of the orphan fallback and the shapes that must never delete.
 */

const NOW = new Date("2025-03-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * DAY_MS).toISOString();
}

/** A world with no claimable ticket: the spec's only ticket is closed. */
function idleWorld(pvcs: K8sPvc[], options: { jobs?: ReturnType<typeof managedJob>[]; secrets?: ReturnType<typeof tokenSecret>[] } = {}) {
  const github = specWorld({
    specNumber: 33,
    subIssueNumbers: [37],
    subIssueLabels: { 37: [...GATE_LABELS, "agent:done"] },
    extraIssues: [],
  });
  const k8s = new FakeK8s({ jobs: options.jobs ?? [], secrets: options.secrets ?? [], pvcs });
  return { github, k8s };
}

function run(deps: { github: ReturnType<typeof idleWorld>["github"]; k8s: FakeK8s }): Promise<ReconcileResult> {
  return runReconcilePass({ ...deps, config: testConfig(), now: () => NOW }, "tick");
}

describe("reclamation: expired volumes", () => {
  it("deletes an expired Ticket PVC together with its same-named Secret", async () => {
    const { github, k8s } = idleWorld([ticketPvc(REPO, 37, { expiresAt: daysFromNow(-1) })], {
      secrets: [tokenSecret(REPO, 37)],
    });

    await run({ github, k8s });

    expect(k8s.pvcs).toEqual([]);
    expect(k8s.secrets).toEqual([]);
    expect(k8s.writeLog).toEqual([
      `deletePvc ${pvcName(REPO, 37)}`,
      `deleteSecret ${tokenSecretName(jobName(REPO, 37))}`,
    ]);
  });

  it("keeps an unexpired volume and a volume with no expires-at at all", async () => {
    const { github, k8s } = idleWorld([
      ticketPvc(REPO, 37, { expiresAt: daysFromNow(3) }),
      // No expires-at = not deletable (Claim clears it; T3 / T3L shape). Young
      // enough that the orphan fallback does not apply either.
      ticketPvc(OTHER_REPO, 38, { creationTimestamp: daysFromNow(-1) }),
    ]);

    const result = await run({ github, k8s });

    expect(k8s.pvcs).toHaveLength(2);
    expect(k8s.writeLog).toEqual([]);
    expect(result.volumeStats.live).toBe(2);
  });

  it("deletes an expired volume even when its Job object is still around", async () => {
    // The Job outliving its volume is normal (ADR-0012 retention window); the
    // volume's own clock decides, not the Job's presence.
    const { github, k8s } = idleWorld([ticketPvc(REPO, 37, { expiresAt: daysFromNow(-1) })], {
      jobs: [managedJob(REPO, 37, { finished: true })],
    });

    await run({ github, k8s });

    expect(k8s.pvcs).toEqual([]);
    expect(k8s.jobs).toHaveLength(1);
  });
});

describe("reclamation: orphan fallback", () => {
  it("deletes a volume with no expires-at, no live Job and age over 30 days", async () => {
    const { github, k8s } = idleWorld([
      ticketPvc(REPO, 37, { creationTimestamp: daysFromNow(-(ORPHAN_MIN_AGE_DAYS + 1)) }),
    ]);

    await run({ github, k8s });

    expect(k8s.pvcs).toEqual([]);
  });

  it("keeps a young volume with no expires-at (the Claim-to-Job window)", async () => {
    const { github, k8s } = idleWorld([
      ticketPvc(REPO, 37, { creationTimestamp: daysFromNow(-(ORPHAN_MIN_AGE_DAYS - 1)) }),
    ]);

    await run({ github, k8s });

    expect(k8s.pvcs).toHaveLength(1);
    expect(k8s.writeLog).toEqual([]);
  });

  it("never orphan-deletes a volume with a live Job, however old it is", async () => {
    const { github, k8s } = idleWorld([
      ticketPvc(REPO, 37, { creationTimestamp: daysFromNow(-(ORPHAN_MIN_AGE_DAYS + 100)) }),
    ], {
      jobs: [managedJob(REPO, 37)],
    });

    await run({ github, k8s });

    expect(k8s.pvcs).toHaveLength(1);
    expect(k8s.writeLog).toEqual([]);
  });

  it("the three orphan conditions are all required", () => {
    const old = daysFromNow(-(ORPHAN_MIN_AGE_DAYS + 1));
    const pvc = (options: { expiresAt?: string; creationTimestamp?: string }) =>
      ticketPvc(REPO, 37, options);
    const live = new Set([pvcName(REPO, 37)]);
    const none = new Set<string>();

    expect(volumeReclaimDecision({ pvc: pvc({ creationTimestamp: old }), now: NOW, liveJobNames: none })).toEqual({
      kind: "delete",
      reason: "orphan",
    });
    expect(volumeReclaimDecision({ pvc: pvc({ creationTimestamp: old }), now: NOW, liveJobNames: live })).toEqual({
      kind: "keep",
      reason: "live-job",
    });
    expect(
      volumeReclaimDecision({ pvc: pvc({ creationTimestamp: daysFromNow(-1) }), now: NOW, liveJobNames: none }),
    ).toEqual({ kind: "keep", reason: "young-orphan" });
    // An unreadable age is not a licence to delete.
    expect(volumeReclaimDecision({ pvc: pvc({}), now: NOW, liveJobNames: none })).toEqual({
      kind: "keep",
      reason: "unknown-age",
    });
    // expires-at present always wins over the orphan path.
    expect(
      volumeReclaimDecision({
        pvc: pvc({ expiresAt: daysFromNow(2), creationTimestamp: old }),
        now: NOW,
        liveJobNames: none,
      }),
    ).toEqual({ kind: "keep", reason: "unexpired" });
  });
});

describe("reclamation: only App-created objects", () => {
  it("never deletes a volume without the App's provenance label", async () => {
    const foreign: K8sPvc = {
      name: "someone-elses-claim",
      namespace: "remote-agent",
      annotations: { [ANNOTATIONS.expiresAt]: daysFromNow(-30) },
      labels: {},
      creationTimestamp: daysFromNow(-400),
    };
    const { github, k8s } = idleWorld([foreign]);

    const result = await run({ github, k8s });

    expect(k8s.pvcs.map((p) => p.name)).toEqual(["someone-elses-claim"]);
    expect(k8s.writeLog).toEqual([]);
    // Foreign volumes do not show up in the App's own volume accounting either.
    expect(result.volumeStats.live).toBe(0);
  });

  it("only ever deletes PVCs and Secrets — never a Job (ADR-0012)", async () => {
    const { github, k8s } = idleWorld(
      [
        ticketPvc(REPO, 37, { expiresAt: daysFromNow(-1) }),
        ticketPvc(REPO, 38, { creationTimestamp: daysFromNow(-400) }),
      ],
      {
        jobs: [managedJob(REPO, 39, { finished: true }), managedJob(REPO, 40)],
        secrets: [tokenSecret(REPO, 37), tokenSecret(REPO, 39)],
      },
    );

    await run({ github, k8s });

    expect(k8s.writeLog.filter((entry) => entry.includes("Job"))).toEqual([]);
    // The finished Job's Secret is not the reclaimed volume's Secret: it stays.
    expect(k8s.secrets.map((s) => s.name)).toEqual([tokenSecretName(jobName(REPO, 39))]);
  });

  it("reclaims nothing when the volume is gone already (404 is success)", async () => {
    const { github, k8s } = idleWorld([ticketPvc(REPO, 37, { expiresAt: daysFromNow(-1) })]);
    // Simulate another actor winning the race: the objects vanish between the
    // list and the delete.
    k8s.pvcs.length = 0;
    const result = await run({ github, k8s });
    expect(result.volumeStats.live).toBe(0);
  });

  it("a second pass over the post-reclamation world writes nothing", async () => {
    const { github, k8s } = idleWorld([ticketPvc(REPO, 37, { expiresAt: daysFromNow(-1) })], {
      secrets: [tokenSecret(REPO, 37)],
    });
    await run({ github, k8s });

    const githubWrites = github.writeLog.length;
    const k8sWrites = k8s.writeLog.length;
    await run({ github, k8s });
    expect(github.writeLog.length).toBe(githubWrites);
    expect(k8s.writeLog.length).toBe(k8sWrites);
  });
});

describe("reclamation: volume stats line", () => {
  it("reports live count, oldest expiry and per-spec usage of the post-reclamation world", async () => {
    const { github, k8s } = idleWorld([
      // Deleted this pass: must not be counted.
      ticketPvc(REPO, 37, { expiresAt: daysFromNow(-1), spec: 33 }),
      ticketPvc(REPO, 38, { expiresAt: daysFromNow(3), spec: 33 }),
      ticketPvc(REPO, 39, { expiresAt: daysFromNow(9), spec: 34 }),
      ticketPvc(OTHER_REPO, 40, { spec: 33 }),
    ]);

    const result = await run({ github, k8s });

    expect(result.volumeStats).toEqual({
      live: 3,
      oldestExpiry: daysFromNow(3),
      perSpec: [
        { spec: "33", count: 2 },
        { spec: "34", count: 1 },
      ],
    });
  });

  it("reports zero volumes and no expiry on an empty world", async () => {
    const { github, k8s } = idleWorld([]);
    const result = await run({ github, k8s });
    expect(result.volumeStats).toEqual({ live: 0, oldestExpiry: null, perSpec: [] });
  });

  it("volumeStats ignores unreadable expiry values when picking the oldest", () => {
    const stats = volumeStats([
      ticketPvc(REPO, 37, { expiresAt: "not-a-date" }),
      ticketPvc(REPO, 38, { expiresAt: daysFromNow(5) }),
    ]);
    expect(stats.live).toBe(2);
    expect(stats.oldestExpiry).toBe(daysFromNow(5));
  });
});
