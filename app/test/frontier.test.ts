import { describe, expect, it } from "vitest";
import { planFrontier } from "../src/planners/frontier.js";
import type { K8sJob } from "../src/ports/K8sPort.js";
import { GATE_LABELS, REPO, issue, managedJob } from "./world.js";

/**
 * Frontier (docs/architecture.md §4.2): the spec's first sub-issue passing the
 * Claim-gate, in sub-issue order. Three outcomes drive three different spec-loop
 * branches, so all three are pinned here.
 */

function jobs(...list: K8sJob[]): Map<string, K8sJob> {
  return new Map(list.map((job) => [job.name, job]));
}

describe("frontier: three outcomes", () => {
  it("has-frontier: the first sub-issue in listed order that passes the Claim-gate", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(35, GATE_LABELS), issue(36, GATE_LABELS)],
      openBlockerCounts: new Map(),
      jobsByName: jobs(),
    });
    expect(outcome.kind).toBe("has-frontier");
    expect(outcome.kind === "has-frontier" && outcome.ticket.number).toBe(35);
  });

  it("no-frontier-open-sub-issues: open sub-issues exist but none passes the gate", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [
        issue(35, ["ready-for-human", "agent:blocked", "agent:implement"]),
        issue(36, ["ready-for-human", "agent:error", "agent:implement"]),
      ],
      openBlockerCounts: new Map(),
      jobsByName: jobs(),
    });
    expect(outcome.kind).toBe("no-frontier-open-sub-issues");
    expect(outcome.kind === "no-frontier-open-sub-issues" && outcome.openSubIssues.map((i) => i.number)).toEqual([35, 36]);
  });

  it("all-closed: every sub-issue is closed (the closeout Job's turn)", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(35, [], { state: "closed" }), issue(36, [], { state: "closed" })],
      openBlockerCounts: new Map(),
      jobsByName: jobs(),
    });
    expect(outcome).toEqual({ kind: "all-closed" });
  });
});

describe("frontier: determinism with several eligible tickets", () => {
  it("picks the first eligible sub-issue in listed order, not the lowest number", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(36, GATE_LABELS), issue(35, GATE_LABELS)],
      openBlockerCounts: new Map(),
      jobsByName: jobs(),
    });
    expect(outcome.kind === "has-frontier" && outcome.ticket.number).toBe(36);
  });

  it("skips closed, blocked and already-claimed tickets to reach the first eligible one", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [
        issue(35, [], { state: "closed" }),
        issue(36, ["ready-for-agent"]),
        issue(37, [...GATE_LABELS, "agent:in-progress"]),
        issue(38, GATE_LABELS),
        issue(39, GATE_LABELS),
      ],
      openBlockerCounts: new Map(),
      jobsByName: jobs(),
    });
    expect(outcome.kind === "has-frontier" && outcome.ticket.number).toBe(38);
  });

  it("skips a ticket with an open blocker and takes the next one", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(35, GATE_LABELS), issue(36, GATE_LABELS)],
      openBlockerCounts: new Map([[35, 1]]),
      jobsByName: jobs(),
    });
    expect(outcome.kind === "has-frontier" && outcome.ticket.number).toBe(36);
  });

  it("skips a ticket whose Job object is still around (terminal or not) — ADR-0013", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(35, GATE_LABELS), issue(36, GATE_LABELS)],
      openBlockerCounts: new Map(),
      jobsByName: jobs(managedJob(REPO, 35, { finished: true })),
    });
    expect(outcome.kind === "has-frontier" && outcome.ticket.number).toBe(36);
  });

  it("is reproducible: the same world yields the same frontier on every call", () => {
    const input = {
      ownerRepo: REPO,
      subIssues: [issue(35, GATE_LABELS), issue(36, GATE_LABELS), issue(37, GATE_LABELS)],
      openBlockerCounts: new Map([[36, 2]]),
      jobsByName: jobs(),
    };
    const first = planFrontier(input);
    for (let i = 0; i < 5; i += 1) expect(planFrontier(input)).toEqual(first);
    expect(first.kind === "has-frontier" && first.ticket.number).toBe(35);
  });

  it("ignores Jobs of other repos when matching the deterministic name", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(35, GATE_LABELS)],
      openBlockerCounts: new Map(),
      jobsByName: jobs(managedJob("2017fighting/pi-web", 35)),
    });
    expect(outcome.kind).toBe("has-frontier");
  });
});

describe("frontier: the parent spec's authorization is inherited (ticket #46)", () => {
  /** The spec as the pass read it: authorized, in the gate. */
  const authorizedSpec = { issue: issue(33, GATE_LABELS), openBlockerCount: 0 };

  it("a sub-issue with only ready-for-agent is the Frontier of an authorized spec", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(35, ["ready-for-agent"]), issue(36, ["ready-for-agent"])],
      openBlockerCounts: new Map(),
      jobsByName: jobs(),
      parentSpec: authorizedSpec,
    });
    expect(outcome.kind === "has-frontier" && outcome.ticket.number).toBe(35);
  });

  it("a ticket's own agent:implement is still enough when the spec has none", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(35, GATE_LABELS)],
      openBlockerCounts: new Map(),
      jobsByName: jobs(),
      parentSpec: { issue: issue(33, ["ready-for-agent"]), openBlockerCount: 0 },
    });
    expect(outcome.kind === "has-frontier" && outcome.ticket.number).toBe(35);
  });

  it("no authorization anywhere: the Frontier stays empty", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(35, ["ready-for-agent"])],
      openBlockerCounts: new Map(),
      jobsByName: jobs(),
      parentSpec: { issue: issue(33, ["ready-for-agent"]), openBlockerCount: 0 },
    });
    expect(outcome.kind).toBe("no-frontier-open-sub-issues");
  });

  it("an unauthorized spec skips only the unauthorized tickets, not the self-authorized one", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(35, ["ready-for-agent"]), issue(36, GATE_LABELS)],
      openBlockerCounts: new Map(),
      jobsByName: jobs(),
      parentSpec: { issue: issue(33, ["ready-for-human", "agent:blocked"]), openBlockerCount: 0 },
    });
    expect(outcome.kind === "has-frontier" && outcome.ticket.number).toBe(36);
  });
});
