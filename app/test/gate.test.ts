import { describe, expect, it } from "vitest";
import { claimGate, labelGate, type GateInput } from "../src/planners/gate.js";
import { GATE_LABELS, managedJob, issue } from "./world.js";

/**
 * Gate / Claim-gate (docs/architecture.md §4.2, ADR-0013). Table-driven: each
 * condition missing alone must stop the gate, and the k8s half must stop a
 * claimable issue when a Job object under the deterministic name still exists
 * (terminal or not).
 *
 * The authorization condition has two sources (ticket #46): the ticket's own
 * `agent:implement`, or its parent spec's. The second one is the whole point of
 * the spec loop — "authorize the spec once, never per ticket" — so it is pinned
 * here as its own block, including the rule that only authorization inherits:
 * the other four conditions stay the ticket's own facts.
 */

const claimable: GateInput = {
  issue: issue(35, GATE_LABELS),
  openBlockerCount: 0,
  existingJob: null,
};

/** The parent spec of a sub-issue, as the pass reads it. */
function parent(labels: string[], overrides: { openBlockerCount?: number; state?: "open" | "closed" } = {}) {
  return {
    issue: issue(33, labels, { state: overrides.state ?? "open" }),
    openBlockerCount: overrides.openBlockerCount ?? 0,
  };
}

describe("Gate: each condition missing alone closes the gate", () => {
  const cases: Array<{ name: string; input: GateInput; reason: string }> = [
    {
      name: "closed issue",
      input: { ...claimable, issue: issue(35, GATE_LABELS, { state: "closed" }) },
      reason: "closed",
    },
    { name: "one open blocker", input: { ...claimable, openBlockerCount: 1 }, reason: "open-blocker" },
    {
      name: "missing ready-for-agent",
      input: { ...claimable, issue: issue(35, ["agent:implement"]) },
      reason: "missing-ready-for-agent",
    },
    {
      name: "missing agent:implement, and no parent spec either",
      input: { ...claimable, issue: issue(35, ["ready-for-agent"]) },
      reason: "missing-agent-implement",
    },
    {
      name: "agent:in-progress present",
      input: { ...claimable, issue: issue(35, [...GATE_LABELS, "agent:in-progress"]) },
      reason: "agent-label-present",
    },
    {
      name: "agent:error present",
      input: { ...claimable, issue: issue(35, [...GATE_LABELS, "agent:error"]) },
      reason: "agent-label-present",
    },
    {
      name: "agent:blocked present",
      input: { ...claimable, issue: issue(35, [...GATE_LABELS, "agent:blocked"]) },
      reason: "agent-label-present",
    },
    {
      name: "a Job object under the deterministic name",
      input: { ...claimable, existingJob: managedJob("2017fighting/remote-agent", 35) },
      reason: "job-object-present",
    },
  ];

  for (const c of cases) {
    it(`stops on ${c.name}`, () => {
      expect(claimGate(c.input)).toEqual({ passed: false, reason: c.reason });
    });
  }

  it("passes when every condition holds", () => {
    expect(claimGate(claimable)).toEqual({ passed: true });
  });

  it("ignores labels that are not agent:*", () => {
    expect(claimGate({ ...claimable, issue: issue(35, [...GATE_LABELS, "needs-triage", "p1"]) })).toEqual({
      passed: true,
    });
  });
});

describe("Gate: authorization is inherited from the parent spec (ticket #46)", () => {
  /** A sub-issue that has never had `agent:implement` written on it. */
  const inherited: GateInput = { ...claimable, issue: issue(35, ["ready-for-agent"]) };

  it("a ticket without agent:implement is in the gate when its spec has it", () => {
    expect(claimGate({ ...inherited, parentSpec: parent(GATE_LABELS) })).toEqual({ passed: true });
  });

  it("the ticket's own agent:implement still authorizes it, parent or not", () => {
    // "implement just this one ticket" stays a manual entry point.
    expect(claimGate({ ...claimable, parentSpec: parent(["ready-for-agent"]) })).toEqual({ passed: true });
    expect(claimGate({ ...claimable, parentSpec: parent(["ready-for-human", "agent:error"]) })).toEqual({
      passed: true,
    });
  });

  it("neither the ticket nor the spec carries it: nothing is claimable", () => {
    expect(claimGate({ ...inherited, parentSpec: parent(["ready-for-agent"]) })).toEqual({
      passed: false,
      reason: "spec-out-of-gate",
    });
    expect(claimGate(inherited)).toEqual({ passed: false, reason: "missing-agent-implement" });
  });

  const parentFailures: Array<{ name: string; spec: ReturnType<typeof parent> }> = [
    { name: "the spec is closed", spec: parent(GATE_LABELS, { state: "closed" }) },
    { name: "the spec has an open blocker", spec: parent(GATE_LABELS, { openBlockerCount: 1 }) },
    { name: "the spec is not ready-for-agent", spec: parent(["agent:implement"]) },
    { name: "the spec carries agent:error", spec: parent(["ready-for-human", "agent:implement", "agent:error"]) },
    { name: "the spec carries agent:blocked", spec: parent(["ready-for-human", "agent:implement", "agent:blocked"]) },
  ];

  for (const c of parentFailures) {
    it(`inheritance does not apply when ${c.name}`, () => {
      expect(claimGate({ ...inherited, parentSpec: c.spec })).toEqual({
        passed: false,
        reason: "spec-out-of-gate",
      });
    });
  }

  it("only authorization inherits: ready-for-agent stays the ticket's own fact", () => {
    expect(claimGate({ ...inherited, issue: issue(35, []), parentSpec: parent(GATE_LABELS) })).toEqual({
      passed: false,
      reason: "missing-ready-for-agent",
    });
  });

  it("only authorization inherits: exit markers and blockers stay the ticket's own facts", () => {
    const spec = parent(GATE_LABELS);
    expect(claimGate({ ...inherited, issue: issue(35, ["ready-for-agent", "agent:blocked"]), parentSpec: spec })).toEqual({
      passed: false,
      reason: "agent-label-present",
    });
    expect(claimGate({ ...inherited, openBlockerCount: 1, parentSpec: spec })).toEqual({
      passed: false,
      reason: "open-blocker",
    });
    expect(claimGate({ ...inherited, issue: issue(35, ["ready-for-agent"], { state: "closed" }), parentSpec: spec })).toEqual({
      passed: false,
      reason: "closed",
    });
  });

  it("the k8s half still applies on the inherited path", () => {
    expect(
      claimGate({
        ...inherited,
        parentSpec: parent(GATE_LABELS),
        existingJob: managedJob("2017fighting/remote-agent", 35, { finished: true }),
      }),
    ).toEqual({ passed: false, reason: "job-object-present" });
  });

  it("the label half is the same function, so a spec's own gate reads only its own labels", () => {
    // A spec has no parent: its authorization is only ever its own label.
    expect(labelGate({ issue: issue(33, GATE_LABELS), openBlockerCount: 0 })).toEqual({ passed: true });
    expect(labelGate({ issue: issue(33, ["ready-for-agent"]), openBlockerCount: 0 })).toEqual({
      passed: false,
      reason: "missing-agent-implement",
    });
  });
});

describe("Claim-gate k8s half (ADR-0013)", () => {
  it("a non-terminal Job object under the deterministic name blocks the claim", () => {
    const job = managedJob("2017fighting/remote-agent", 35);
    expect(claimGate({ ...claimable, existingJob: job })).toEqual({
      passed: false,
      reason: "job-object-present",
    });
  });

  it("a terminal Job object inside its retention window blocks the claim too", () => {
    const job = managedJob("2017fighting/remote-agent", 35, { finished: true });
    expect(claimGate({ ...claimable, existingJob: job })).toEqual({
      passed: false,
      reason: "job-object-present",
    });
  });

  it("the label half alone does not look at k8s (closeout uses the same label gate)", () => {
    expect(labelGate({ issue: issue(33, GATE_LABELS), openBlockerCount: 0 })).toEqual({ passed: true });
    expect(labelGate({ issue: issue(33, [...GATE_LABELS, "agent:in-progress"]), openBlockerCount: 0 })).toEqual({
      passed: false,
      reason: "agent-label-present",
    });
  });
});
