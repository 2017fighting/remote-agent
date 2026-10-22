import { describe, expect, it } from "vitest";
import { jobName, secretName } from "@remote-agent/shared";
import { runReconcilePass } from "../src/reconcile.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import { K8sApiError } from "../src/ports/errors.js";
import { testConfig } from "./helpers.js";
import { GATE_LABELS, OTHER_REPO, REPO, issue, managedJob, specWorld } from "./world.js";

/**
 * Claim on the App seam (spec #33 §2 step 3, ADR-0013):
 *
 *   PVC (if absent) → Secret (mint) → Job (if absent) → `agent:in-progress`
 *
 * plus the two classifications that carry product meaning — `409 AlreadyExists`
 * is success, `403 quota exceeded` is a normal branch — and the rule that any
 * other failure stops the pass at that ticket, with the next pass recomputing
 * from world state.
 */

const config = testConfig();

/** One spec, one claimable ticket. */
function oneTicket() {
  return { github: specWorld({ specNumber: 33, subIssueNumbers: [35] }), k8s: new FakeK8s() };
}

describe("claim write order", () => {
  it("writes PVC → Secret → Job → agent:in-progress", async () => {
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "webhook");

    const pvc = jobName(REPO, 35);
    expect(k8s.writeLog).toEqual([`createPvc ${pvc}`, `createSecret ${secretName(REPO, 35)}`, `createJob ${pvc}`]);
    expect(github.writeLog).toEqual([`mintInstallationToken ${REPO}`, `editLabels ${REPO}#35 +[agent:in-progress] -[]`]);

    // Cross-port order is the contract: PVC and Secret before the Job, Job before the label.
    expect(k8s.writeLog.indexOf(`createJob ${pvc}`)).toBe(2);
    expect(github.writeLog.indexOf(`editLabels ${REPO}#35 +[agent:in-progress] -[]`)).toBe(1);
    expect((await github.getIssue(REPO, 35))?.labels).toContain("agent:in-progress");
  });

  it("stops at the first failure and the next pass recomputes from world state", async () => {
    const { github, k8s } = oneTicket();
    const pvc = jobName(REPO, 35);

    // Fail the Secret create: the PVC exists, the Secret and Job do not.
    k8s.failNextCreate = { object: "secret", error: new K8sApiError(500, "boom") };
    await expect(runReconcilePass({ github, k8s, config }, "webhook")).rejects.toThrow(/boom/);
    expect(k8s.pvcs.map((p) => p.name)).toEqual([pvc]);
    expect(k8s.secrets).toEqual([]);
    expect(k8s.jobs).toEqual([]);
    expect((await github.getIssue(REPO, 35))?.labels).not.toContain("agent:in-progress");

    // Next pass: the PVC is reused (no second create), the rest proceeds.
    await runReconcilePass({ github, k8s, config }, "tick");
    expect(k8s.writeLog.filter((w) => w === `createPvc ${pvc}`)).toHaveLength(1);
    expect(k8s.secrets.map((s) => s.name)).toEqual([secretName(REPO, 35)]);
    expect(k8s.jobs.map((j) => j.name)).toEqual([pvc]);
    expect((await github.getIssue(REPO, 35))?.labels).toContain("agent:in-progress");
  });

  it("stops before writing the label when the Job create fails", async () => {
    const { github, k8s } = oneTicket();
    k8s.failNextCreate = { object: "job", error: new K8sApiError(500, "job boom") };
    await expect(runReconcilePass({ github, k8s, config }, "webhook")).rejects.toThrow(/job boom/);
    expect((await github.getIssue(REPO, 35))?.labels).not.toContain("agent:in-progress");
  });

  it("stops before creating anything when the PVC create fails", async () => {
    const { github, k8s } = oneTicket();
    k8s.failNextCreate = { object: "pvc", error: new K8sApiError(500, "pvc boom") };
    await expect(runReconcilePass({ github, k8s, config }, "webhook")).rejects.toThrow(/pvc boom/);
    expect(k8s.writeLog).toEqual([]);
    expect(github.writeLog).toEqual([]);
  });

  it("stops the pass at the failed ticket, leaving later candidates untouched", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [35, 36] });
    const k8s = new FakeK8s();
    k8s.failNextCreate = { object: "job", error: new K8sApiError(500, "first fails") };
    await expect(runReconcilePass({ github, k8s, config }, "webhook")).rejects.toThrow(/first fails/);
    // The second ticket never reached the gate this pass.
    expect((await github.getIssue(REPO, 36))?.labels).not.toContain("agent:in-progress");
  });
});

describe("claim determinism and idempotence", () => {
  it("uses deterministic names within the 63-char budget", async () => {
    const longRepo = "a".repeat(40) + "/" + "b".repeat(40);
    const github = specWorld({ specNumber: 33, subIssueNumbers: [35], ownerRepo: longRepo });
    const k8s = new FakeK8s();
    await runReconcilePass({ github, k8s, config }, "webhook");

    const created = k8s.jobs[0]!.name;
    expect(created).toBe(jobName(longRepo, 35));
    expect(created.length).toBeLessThanOrEqual(63);
    expect(k8s.pvcs[0]!.name).toBe(created);
    expect(k8s.secrets[0]!.name).toBe(`${created}-token`);
    expect(k8s.secrets[0]!.name.length).toBeLessThanOrEqual(63);
  });

  it("treats 409 AlreadyExists as success: the claim completes and the label is written", async () => {
    const { github, k8s } = oneTicket();
    const pvc = jobName(REPO, 35);
    // The pass read an empty world; another pass created the Job first, so the
    // create comes back 409. That is the intended end state, not a failure.
    k8s.failNextCreate = { object: "job", error: new K8sApiError(409, `jobs.batch "${pvc}" already exists`) };

    const result = await runReconcilePass({ github, k8s, config }, "webhook");

    expect(result.slotsUsed).toBe(1);
    // The 409 is swallowed rather than thrown, and the pass does not retry the
    // create: the label — the last write of the order — still lands.
    expect(k8s.writeLog).not.toContain(`createJob ${pvc}`);
    expect((await github.getIssue(REPO, 35))?.labels).toContain("agent:in-progress");
  });

  it("409 on the PVC and Secret creates is success too", async () => {
    const { github, k8s } = oneTicket();
    k8s.failNextCreate = { object: "pvc", error: new K8sApiError(409, "already exists") };
    await runReconcilePass({ github, k8s, config }, "webhook");
    // The PVC create was swallowed, so the rest of the order still ran.
    expect(k8s.secrets.map((s) => s.name)).toEqual([secretName(REPO, 35)]);
    expect(k8s.jobs.map((j) => j.name)).toEqual([jobName(REPO, 35)]);
  });

  it("a replay over the claimed world mints no second token and creates nothing", async () => {
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "startup");

    const githubWrites = github.writeLog.length;
    const k8sWrites = k8s.writeLog.length;
    const secrets = k8s.secrets.length;

    await runReconcilePass({ github, k8s, config }, "tick");
    expect(github.writeLog.length).toBe(githubWrites);
    expect(k8s.writeLog.length).toBe(k8sWrites);
    expect(k8s.secrets.length).toBe(secrets);
    expect(github.writeLog.filter((w) => w.startsWith("mintInstallationToken"))).toHaveLength(1);
  });
});

describe("claim: a Job object under the deterministic name", () => {
  const cases: Array<{ name: string; job: ReturnType<typeof managedJob> }> = [
    { name: "non-terminal Job", job: managedJob(REPO, 35) },
    { name: "terminal Job still in its retention window", job: managedJob(REPO, 35, { finished: true }) },
  ];

  for (const c of cases) {
    it(`does not claim, does not create and does not read the annotation when a ${c.name} exists`, async () => {
      const github = specWorld({ specNumber: 33, subIssueNumbers: [35] });
      // An old run's annotation is present; the gate must not consume it.
      c.job.annotations["remote-agent/run-result"] = '{"v":1,"outcome":"done","summary":"old run"}';
      const k8s = new FakeK8s({ jobs: [c.job] });

      const result = await runReconcilePass({ github, k8s, config }, "webhook");

      expect(github.writeLog).toEqual([]);
      expect(k8s.writeLog).toEqual([]);
      expect(result.waiting).toBe(1);
      expect((await github.getIssue(REPO, 35))?.labels).not.toContain("agent:in-progress");
    });
  }

  it("claims again once the Job object is gone (DELETED wakes the next pass)", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [35] });
    const k8s = new FakeK8s({ jobs: [managedJob(REPO, 35, { finished: true })] });
    expect((await runReconcilePass({ github, k8s, config }, "webhook")).waiting).toBe(1);

    k8s.deleteJob(jobName(REPO, 35));
    const result = await runReconcilePass({ github, k8s, config }, "job-watch");
    expect(result.waiting).toBe(0);
    expect(result.slotsUsed).toBe(1);
    expect(k8s.jobs.map((j) => j.name)).toEqual([jobName(REPO, 35)]);
  });
});

describe("claim: Guardrail quota denial is a normal branch", () => {
  it("403 quota exceeded: no Job, no label change, no comment, no agent:error", async () => {
    const { github, k8s } = oneTicket();
    k8s.failNextCreate = {
      object: "job",
      error: new K8sApiError(403, 'jobs.batch is forbidden: exceeded quota: guardrail, requested: count/jobs.batch=1'),
    };

    const result = await runReconcilePass({ github, k8s, config }, "webhook");

    expect(result).toEqual({ slotsUsed: 0, slotsMax: 3, deferred: 0, renewed: 0, waiting: 0 });
    expect(k8s.jobs).toEqual([]);
    expect(github.writeLog).toEqual([`mintInstallationToken ${REPO}`]);
    expect(github.comments).toEqual([]);
    expect((await github.getIssue(REPO, 35))?.labels).toEqual(GATE_LABELS);
  });

  it("403 quota exceeded on the Secret create is the same normal branch", async () => {
    const { github, k8s } = oneTicket();
    k8s.failNextCreate = {
      object: "secret",
      error: new K8sApiError(403, 'secrets is forbidden: exceeded quota: guardrail, requested: count/secrets=1'),
    };
    const result = await runReconcilePass({ github, k8s, config }, "webhook");
    expect(result.deferred).toBe(0);
    expect(github.writeLog).toEqual([`mintInstallationToken ${REPO}`]);
    expect((await github.getIssue(REPO, 35))?.labels).toEqual(GATE_LABELS);
  });

  it("a 403 that is not a quota denial is still an error (no silent swallow)", async () => {
    const { github, k8s } = oneTicket();
    k8s.failNextCreate = { object: "job", error: new K8sApiError(403, "forbidden: cannot create jobs") };
    await expect(runReconcilePass({ github, k8s, config }, "webhook")).rejects.toThrow(/forbidden/);
  });
});

describe("claim: Defer at the Slot cap", () => {
  it("defers a candidate without touching its labels, comments or Jobs", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [35] });
    // Two running Jobs for this repo already fill the per-repo cap.
    const jobs = [managedJob(REPO, 1), managedJob(REPO, 2)];
    const k8s = new FakeK8s({
      jobs,
      pods: jobs.map((job) => ({
        name: `${job.name}-pod`,
        namespace: "remote-agent",
        ownerJobName: job.name,
        phase: "Running",
        deleting: false,
      })),
    });

    const result = await runReconcilePass({ github, k8s, config }, "tick");
    expect(result.deferred).toBe(1);
    expect(result.slotsUsed).toBe(2);
    expect(github.writeLog).toEqual([]);
    expect(k8s.writeLog).toEqual([]);
    expect(github.comments).toEqual([]);
    expect((await github.getIssue(REPO, 35))?.labels).toEqual(GATE_LABELS);
  });

  it("claims up to the cap and defers the rest in one pass", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [35, 36] });
    const k8s = new FakeK8s();
    // maxJobsPerRepo 2 but only one Slot is taken by the first claim, so both fit.
    const result = await runReconcilePass({ github, k8s, config }, "tick");
    expect(result.slotsUsed).toBe(1);
    expect(result.deferred).toBe(0);
  });

  it("lowering MAX_JOBS_PER_REPO defers new claims without killing running Jobs", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [35] });
    const running = managedJob(REPO, 1);
    const k8s = new FakeK8s({
      jobs: [running],
      pods: [{ name: `${running.name}-pod`, namespace: "remote-agent", ownerJobName: running.name, phase: "Running", deleting: false }],
    });

    const result = await runReconcilePass({ github, k8s, config: testConfig({ MAX_JOBS_PER_REPO: "1" }) }, "tick");
    expect(result.deferred).toBe(1);
    // The running Job is untouched: no delete, no patch, no label change on its issue.
    expect(k8s.jobs.map((j) => j.name)).toEqual([running.name]);
    expect(k8s.writeLog).toEqual([]);
  });

  it("counts the per-repo cap by target repo, not by spec", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [35] });
    // The cap is already full for a different repo; this repo still has room.
    const other = managedJob(OTHER_REPO, 1);
    const other2 = managedJob(OTHER_REPO, 2);
    const k8s = new FakeK8s({
      jobs: [other, other2],
      pods: [other, other2].map((job) => ({
        name: `${job.name}-pod`,
        namespace: "remote-agent",
        ownerJobName: job.name,
        phase: "Running",
        deleting: false,
      })),
    });
    const result = await runReconcilePass({ github, k8s, config }, "tick");
    expect(result.deferred).toBe(0);
    expect(k8s.jobs.map((j) => j.name)).toContain(jobName(REPO, 35));
  });

  it("a global cap of 1 admits the first candidate and defers the second spec's", async () => {
    const github = specWorld({
      specNumber: 33,
      subIssueNumbers: [35],
      extraIssues: [issue(34, GATE_LABELS)],
    });
    // Give #34 its own spec so both are candidates.
    github.subIssues.set(`${REPO}:34`, [36]);
    github.issues.push(issue(36, GATE_LABELS));

    const k8s = new FakeK8s();
    const result = await runReconcilePass({ github, k8s, config: testConfig({ MAX_JOBS_GLOBAL: "1" }) }, "tick");
    expect(result.slotsUsed).toBe(1);
    expect(result.deferred).toBe(1);
    // Spec 33 < 34, so #35 was admitted and #36 deferred.
    expect(k8s.jobs.map((j) => j.name)).toEqual([jobName(REPO, 35)]);
  });
});
