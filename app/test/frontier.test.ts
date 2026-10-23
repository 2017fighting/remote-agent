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
    // Each holdout carries the gate condition that held it, so the log can say
    // why the Frontier is empty (ticket #47).
    expect(outcome.kind === "no-frontier-open-sub-issues" && outcome.holdouts.map((h) => h.issue.number)).toEqual([
      35, 36,
    ]);
    expect(outcome.kind === "no-frontier-open-sub-issues" && outcome.holdouts.map((h) => h.reason)).toEqual([
      "exit-marker",
      "exit-marker",
    ]);
  });

  it("names the action that unblocks each holdout, not the raw gate verdict", () => {
    // The `idle` log line's reason vocabulary (ticket #47): every gate condition
    // is mapped to "who fixes it", because a blocked ticket also lost
    // `ready-for-agent` and would otherwise read as "just re-add the label".
    const cases: Array<{ name: string; labels: string[]; blockers?: number; reason: string }> = [
      { name: "blocked", labels: ["ready-for-human", "agent:blocked"], reason: "exit-marker" },
      { name: "errored", labels: ["ready-for-human", "agent:error"], reason: "exit-marker" },
      { name: "still running", labels: ["ready-for-agent", "agent:in-progress"], reason: "in-flight" },
      { name: "never triaged in", labels: ["agent:implement"], reason: "not-ready" },
      { name: "open blocker", labels: GATE_LABELS, blockers: 1, reason: "open-blocker" },
      { name: "no authorization anywhere", labels: ["ready-for-agent"], reason: "unauthorized" },
    ];
    for (const c of cases) {
      const outcome = planFrontier({
        ownerRepo: REPO,
        subIssues: [issue(35, c.labels)],
        openBlockerCounts: new Map(c.blockers === undefined ? [] : [[35, c.blockers]]),
        jobsByName: jobs(),
        parentSpec: { issue: issue(33, ["ready-for-agent"]), openBlockerCount: 0 },
      });
      expect(
        outcome.kind === "no-frontier-open-sub-issues" ? outcome.holdouts.map((h) => h.reason) : outcome.kind,
        c.name,
      ).toEqual([c.reason]);
    }
  });

  it("a running ticket is in-flight, not a re-entry — it needs no human", () => {
    const outcome = planFrontier({
      ownerRepo: REPO,
      subIssues: [issue(35, [...GATE_LABELS, "agent:in-progress"])],
      openBlockerCounts: new Map(),
      jobsByName: jobs(),
    });
    expect(outcome.kind === "no-frontier-open-sub-issues" && outcome.holdouts[0]!.reason).toBe("in-flight");
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
