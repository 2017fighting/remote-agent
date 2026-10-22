import { describe, expect, it } from "vitest";
import { admitSlot, countSlotUsage, occupySlot } from "../src/planners/slots.js";
import type { K8sJob, K8sPod } from "../src/ports/K8sPort.js";
import { OTHER_REPO, REPO, managedJob } from "./world.js";

/**
 * Slot accounting (docs/architecture.md §5): pods grouped by their Job, a
 * Terminating pod still holds its Slot, terminal pods release it, and the two
 * caps (global, per target repo) decide Defer.
 */

function pod(ownerJobName: string, phase = "Running", deleting = false): K8sPod {
  return { name: `${ownerJobName}-${phase}-${deleting}`, namespace: "remote-agent", ownerJobName, phase, deleting };
}

const limits = { maxJobsGlobal: 3, maxJobsPerRepo: 2 };

describe("countSlotUsage", () => {
  it("groups pods by their owning Job, so several pods of one Job hold one Slot", () => {
    const job = managedJob(REPO, 35);
    const usage = countSlotUsage([job], [pod(job.name, "Pending"), pod(job.name, "Running")]);
    expect(usage.total).toBe(1);
    expect(usage.holdingJobNames).toEqual([job.name]);
  });

  it("counts a Terminating pod as still holding its Slot", () => {
    const job = managedJob(REPO, 35);
    expect(countSlotUsage([job], [pod(job.name, "Running", true)]).total).toBe(1);
  });

  it("releases the Slot for terminal pods", () => {
    const job = managedJob(REPO, 35);
    for (const phase of ["Succeeded", "Failed"]) {
      expect(countSlotUsage([job], [pod(job.name, phase)]).total, phase).toBe(0);
    }
  });

  it("holds nothing for a Job with no pods (a terminal Job in its retention window)", () => {
    const job = managedJob(REPO, 35, { finished: true });
    expect(countSlotUsage([job], []).total).toBe(0);
  });

  it("ignores pods whose Job the App does not manage", () => {
    const foreign: K8sJob = {
      name: "somebody-elses-job",
      namespace: "remote-agent",
      labels: {},
      annotations: {},
      conditions: [],
      finished: false,
    };
    expect(countSlotUsage([foreign], [pod(foreign.name)]).total).toBe(0);
  });

  it("ignores pods with no owner reference", () => {
    const job = managedJob(REPO, 35);
    const orphan: K8sPod = { name: "orphan", namespace: "remote-agent", phase: "Running", deleting: false };
    expect(countSlotUsage([job], [orphan]).total).toBe(0);
  });

  it("counts per target repo by the Job's remote-agent/repo label", () => {
    const a = managedJob(REPO, 35);
    const b = managedJob(REPO, 36);
    const c = managedJob(OTHER_REPO, 35);
    const usage = countSlotUsage([a, b, c], [pod(a.name), pod(b.name), pod(c.name)]);
    expect(usage.total).toBe(3);
    expect(usage.perRepo.get(REPO)).toBe(2);
    expect(usage.perRepo.get(OTHER_REPO)).toBe(1);
  });
});

describe("admitSlot", () => {
  it("admits while both caps have room", () => {
    const usage = countSlotUsage([], []);
    expect(admitSlot(usage, REPO, limits)).toEqual({ kind: "admit" });
  });

  it("defers on the global cap even when the repo has room", () => {
    const jobs = [managedJob(REPO, 1), managedJob(REPO, 2), managedJob(OTHER_REPO, 1)];
    const usage = countSlotUsage(jobs, jobs.map((job) => pod(job.name)));
    expect(admitSlot(usage, OTHER_REPO, limits)).toEqual({ kind: "defer", reason: "global-limit" });
  });

  it("defers on the per-repo cap even when the global cap has room", () => {
    const jobs = [managedJob(REPO, 1), managedJob(REPO, 2)];
    const usage = countSlotUsage(jobs, jobs.map((job) => pod(job.name)));
    expect(admitSlot(usage, REPO, limits)).toEqual({ kind: "defer", reason: "repo-limit" });
    // The same occupancy admits a Job for a different target repo.
    expect(admitSlot(usage, OTHER_REPO, limits)).toEqual({ kind: "admit" });
  });

  it("honours lowered caps without touching running Jobs", () => {
    const jobs = [managedJob(REPO, 1), managedJob(REPO, 2)];
    const pods = jobs.map((job) => pod(job.name));
    const usage = countSlotUsage(jobs, pods);
    // Lowering the cap changes the decision only: the Jobs and their pods stay.
    expect(admitSlot(usage, REPO, { maxJobsGlobal: 3, maxJobsPerRepo: 1 })).toEqual({
      kind: "defer",
      reason: "repo-limit",
    });
    expect(admitSlot(usage, REPO, { maxJobsGlobal: 2, maxJobsPerRepo: 2 })).toEqual({
      kind: "defer",
      reason: "global-limit",
    });
    expect(usage.total).toBe(2);
    expect(jobs.map((job) => job.name)).toHaveLength(2);
  });

  it("a cap of 0 defers everything", () => {
    const usage = countSlotUsage([], []);
    expect(admitSlot(usage, REPO, { maxJobsGlobal: 0, maxJobsPerRepo: 2 })).toEqual({
      kind: "defer",
      reason: "global-limit",
    });
    expect(admitSlot(usage, REPO, { maxJobsGlobal: 3, maxJobsPerRepo: 0 })).toEqual({
      kind: "defer",
      reason: "repo-limit",
    });
  });
});

describe("occupySlot", () => {
  it("counts a Job admitted earlier in the same pass (serial admission must not overshoot)", () => {
    let usage = countSlotUsage([], []);
    usage = occupySlot(usage, "agent-a-1", REPO);
    usage = occupySlot(usage, "agent-a-2", REPO);
    expect(usage.total).toBe(2);
    expect(admitSlot(usage, REPO, limits)).toEqual({ kind: "defer", reason: "repo-limit" });
    usage = occupySlot(usage, "agent-b-1", OTHER_REPO);
    expect(admitSlot(usage, OTHER_REPO, limits)).toEqual({ kind: "defer", reason: "global-limit" });
  });

  it("does not mutate the usage it was given", () => {
    const usage = countSlotUsage([], []);
    occupySlot(usage, "agent-a-1", REPO);
    expect(usage.total).toBe(0);
    expect(usage.perRepo.size).toBe(0);
  });
});
