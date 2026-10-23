import { describe, expect, it } from "vitest";
import { claimGate, labelGate, type GateInput } from "../src/planners/gate.js";
import { GATE_LABELS, managedJob, issue } from "./world.js";

/**
 * Gate / Claim-gate (docs/architecture.md §4.2, ADR-0013). Table-driven: each
 * condition missing alone must stop the gate, and the k8s half must stop a
 * claimable issue when a Job object under the deterministic name still exists
 * (terminal or not).
 */

const claimable: GateInput = {
  issue: issue(35, GATE_LABELS),
  openBlockerCount: 0,
  existingJob: null,
};

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
      name: "missing agent:implement",
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
    expect(labelGate(issue(33, GATE_LABELS), 0)).toEqual({ passed: true });
    expect(labelGate(issue(33, [...GATE_LABELS, "agent:in-progress"]), 0)).toEqual({
      passed: false,
      reason: "agent-label-present",
    });
  });
});
