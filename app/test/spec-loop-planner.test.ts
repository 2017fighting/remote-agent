import { describe, expect, it } from "vitest";
import type { NewTicket } from "@remote-agent/shared";
import {
  LABEL_CLOSEOUT_CONSUMED,
  planSpecStep,
  type SpecStep,
} from "../src/planners/spec-loop.js";
import type { FrontierOutcome } from "../src/planners/frontier.js";
import type { K8sJob } from "../src/ports/K8sPort.js";
import { GATE_LABELS, REPO, closeoutJob, issue } from "./world.js";

/**
 * `planSpecStep` in isolation (docs/architecture.md §4.5): the world goes in, one
 * step comes out. The pass-level behaviour is in spec-loop.test.ts; this file
 * pins the branch table, including the one that ticket #49 added — a closeout
 * outcome that was already consumed must not be judged a second time.
 */

const SPEC = 33;
const allClosed: FrontierOutcome = { kind: "all-closed" };

/** A spec issue, in the gate by default. */
function spec(labels: string[] = GATE_LABELS) {
  return issue(SPEC, labels);
}

function plan(overrides: { spec?: ReturnType<typeof spec>; frontier?: FrontierOutcome; jobs?: K8sJob[] }): SpecStep {
  return planSpecStep({
    spec: overrides.spec ?? spec(),
    frontier: overrides.frontier ?? allClosed,
    openSpecBlockerCount: 0,
    jobsByName: new Map((overrides.jobs ?? []).map((job) => [job.name, job])),
  });
}

function runResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function doneJob(newTickets: NewTicket[] = []) {
  return closeoutJob(REPO, SPEC, {
    finished: true,
    annotation: runResult({ v: 1, outcome: "done", summary: "s", prBody: "p", newTickets }),
  });
}

describe("planSpecStep: the S1 three-way branch", () => {
  it("advances a claimable ticket without needing the spec's own agent:implement", () => {
    const ticket = issue(34, GATE_LABELS);
    expect(plan({ frontier: { kind: "has-frontier", ticket } })).toEqual({ kind: "advance", ticket });
  });

  it("is idle when open sub-issues remain but none is claimable", () => {
    expect(plan({ frontier: { kind: "no-frontier-open-sub-issues", holdouts: [] } })).toEqual({ kind: "idle" });
  });

  it("starts the closeout when nothing is left and no object exists", () => {
    expect(plan({})).toEqual({ kind: "start-closeout" });
  });

  it("does not start a second closeout while the object exists", () => {
    expect(plan({ jobs: [closeoutJob(REPO, SPEC)] })).toEqual({ kind: "closeout-running" });
  });

  it("is out of the gate without its own authorization, even with nothing left to do", () => {
    expect(plan({ spec: spec(["ready-for-agent"]) })).toEqual({ kind: "out-of-gate" });
  });
});

describe("planSpecStep: the closeout outcome", () => {
  it("opens the PR when done carries no newTickets", () => {
    expect(plan({ jobs: [doneJob()] })).toEqual({ kind: "open-pull-request", prBody: "p" });
  });

  it("creates the sub-issues when done carries newTickets", () => {
    const newTickets: NewTicket[] = [{ title: "more work", body: "b", readyForAgent: true }];
    expect(plan({ jobs: [doneJob(newTickets)] })).toEqual({ kind: "create-sub-issues", newTickets });
  });

  it("reports blocked as a label migration plus a comment", () => {
    const blocked = closeoutJob(REPO, SPEC, {
      finished: true,
      annotation: runResult({ v: 1, outcome: "blocked", summary: "s", commentBody: "c" }),
    });
    expect(plan({ jobs: [blocked] }).kind).toBe("closeout-blocked");
  });

  it("reports an App-judged error with its reason and no summary", () => {
    const failed = closeoutJob(REPO, SPEC, { finished: true, failedReason: "DeadlineExceeded" });
    expect(plan({ jobs: [failed] })).toEqual({ kind: "closeout-error", reason: "deadline-exceeded", summary: null });
  });
});

describe("planSpecStep: a consumed outcome is not judged again (ticket #49)", () => {
  /**
   * The hole this closes: S3N stays in the gate, so once every follow-up it
   * created has closed, the spec is back on "no open sub-issue" while the
   * closeout Job object is still in its 30-minute retention window. Without a
   * carrier of its own the same `newTickets` would be created a second time.
   */
  const consumed = spec([...GATE_LABELS, LABEL_CLOSEOUT_CONSUMED]);

  it("does not create the sub-issues a second time", () => {
    const newTickets: NewTicket[] = [{ title: "more work", body: "b", readyForAgent: true }];
    expect(plan({ spec: consumed, jobs: [doneJob(newTickets)] })).toEqual({ kind: "closeout-consumed" });
  });

  it("covers a consumed failure too, so no evidence comment is posted twice", () => {
    const failed = closeoutJob(REPO, SPEC, { finished: true, failedReason: "BackoffLimitExceeded" });
    expect(plan({ spec: consumed, jobs: [failed] })).toEqual({ kind: "closeout-consumed" });
  });

  it("short-circuits before the Job is judged, so no annotation is read a second time", () => {
    // Ordering, not a reachable world: starting a closeout always clears the
    // marker, so a marked spec with a live object cannot be produced. Pinning it
    // anyway keeps the marker check ahead of `judgeJob` — which is what holds
    // ADR-0007's "read the annotation exactly once" while the marker is on.
    expect(plan({ spec: consumed, jobs: [closeoutJob(REPO, SPEC)] })).toEqual({ kind: "closeout-consumed" });
  });

  it("is not read on the S1 branches: a marker with a Frontier still advances", () => {
    const ticket = issue(34, GATE_LABELS);
    expect(plan({ spec: consumed, frontier: { kind: "has-frontier", ticket } })).toEqual({
      kind: "advance",
      ticket,
    });
  });
});
