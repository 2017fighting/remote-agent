import { describe, expect, it } from "vitest";
import { jobName, secretName, specBranch } from "@remote-agent/shared";
import { MODEL_SCRIPT, SCENARIO, SPEC_NUMBER, TARGET_REPO, TICKET_NUMBERS } from "../src/scenario.js";

/**
 * The scenario fixture's consistency with the product's own contracts.
 *
 * The fixture hardcodes Job names in the harness's assertions and tool names in
 * the model script. If either drifts from the product, the e2e would fail for a
 * reason that looks like an App bug. These checks move that failure here, where
 * it names the drift.
 */

describe("scenario: the world it starts from is a legal spec", () => {
  it("has one spec with two sub-issues in order, both claimable by inheritance", () => {
    expect(SCENARIO.repo).toBe(TARGET_REPO);
    const spec = SCENARIO.issues.find((issue) => issue.number === SPEC_NUMBER);
    expect(spec).toBeDefined();
    // The spec is the only place the authorization is written (ticket #46).
    expect(spec!.labels).toContain("agent:implement");
    expect(spec!.labels).toContain("ready-for-agent");

    // A spec never carries agent:in-progress (§4.5), so the fixture must not.
    expect(spec!.labels).not.toContain("agent:in-progress");

    expect(SCENARIO.subIssues[String(SPEC_NUMBER)]).toEqual([...TICKET_NUMBERS]);
    for (const ticketNumber of TICKET_NUMBERS) {
      const ticket = SCENARIO.issues.find((issue) => issue.number === ticketNumber);
      expect(ticket, `ticket #${ticketNumber} is missing from the fixture`).toBeDefined();
      expect(ticket!.state).toBe("open");
      // The Gate needs ready-for-agent plus authorization, and no other agent:*.
      // The authorization is the spec's: no ticket carries its own, which is
      // exactly what this scenario is here to prove end to end.
      expect(ticket!.labels).toContain("ready-for-agent");
      expect(ticket!.labels, `ticket #${ticketNumber} must inherit, not carry, agent:implement`).not.toContain(
        "agent:implement",
      );
      expect(ticket!.labels.filter((label) => label.startsWith("agent:"))).toEqual([]);
    }
  });

  it("starts with no blockers, no comments and no PRs", () => {
    expect(SCENARIO.blockers).toEqual({});
    expect(SCENARIO.comments).toEqual([]);
    expect(SCENARIO.pullRequests).toEqual([]);
  });
});

describe("scenario: the names the harness asserts are the product's names", () => {
  it("uses the shared jobName rule for both tickets and the closeout", () => {
    for (const number of [...TICKET_NUMBERS, SPEC_NUMBER]) {
      // The harness polls `agent-2017fighting-remote-agent-<n>`; that is the
      // shared rule, so assert the two spellings agree.
      expect(jobName(TARGET_REPO, number)).toBe(`agent-2017fighting-remote-agent-${number}`);
      expect(secretName(TARGET_REPO, number)).toBe(`${jobName(TARGET_REPO, number)}-token`);
    }
  });

  it("targets the branch the PR assertion expects", () => {
    expect(specBranch(SPEC_NUMBER)).toBe(`agent/spec-${SPEC_NUMBER}`);
  });
});

describe("scenario: the model script speaks the runner's tool table", () => {
  /**
   * The runner's two tool tables (job/test/result-tools.test.ts pins both): the
   * implement-ticket run offers read/write/edit/bash + finish_ticket + blocked +
   * code_review, and the implement-spec closeout offers the same minus
   * finish_ticket, plus finish_spec. The reviewer offers read/grep/bash only. A
   * script step naming anything else would fail at runtime, so it fails here.
   */
  const TICKET_TOOLS = new Set(["read", "write", "edit", "bash", "finish_ticket", "blocked", "code_review"]);
  const SPEC_TOOLS = new Set(["read", "write", "edit", "bash", "finish_spec", "blocked", "code_review"]);
  const REVIEWER_TOOLS = new Set(["read", "grep", "bash"]);

  /** The closeout run is the tail of the script: everything after the last finish_ticket. */
  function closeoutSteps(): typeof MODEL_SCRIPT.steps {
    const steps = MODEL_SCRIPT.steps;
    let lastFinish = -1;
    steps.forEach((step, index) => {
      if ((step.toolCalls ?? []).some((call) => call.name === "finish_ticket")) lastFinish = index;
    });
    return steps.slice(lastFinish + 1);
  }

  it("only calls tools the ticket role offers, before the closeout", () => {
    const steps = MODEL_SCRIPT.steps;
    const closeout = new Set(closeoutSteps());
    for (const step of steps.filter((candidate) => candidate.model === "default" && !closeout.has(candidate))) {
      for (const call of step.toolCalls ?? []) {
        expect(TICKET_TOOLS, `script calls unknown ticket tool ${call.name}`).toContain(call.name);
      }
    }
  });

  it("only calls tools the spec role offers, in the closeout", () => {
    for (const step of closeoutSteps().filter((candidate) => candidate.model === "default")) {
      for (const call of step.toolCalls ?? []) {
        expect(SPEC_TOOLS, `script calls unknown spec tool ${call.name}`).toContain(call.name);
      }
    }
  });

  it("finishes each ticket run once and the closeout once", () => {
    const finishTicketCalls = MODEL_SCRIPT.steps.flatMap((step) =>
      (step.toolCalls ?? []).filter((call) => call.name === "finish_ticket"),
    );
    const finishSpecCalls = MODEL_SCRIPT.steps.flatMap((step) =>
      (step.toolCalls ?? []).filter((call) => call.name === "finish_spec"),
    );
    expect(finishTicketCalls).toHaveLength(TICKET_NUMBERS.length);
    expect(finishSpecCalls).toHaveLength(1);
    // The spec role never offers finish_ticket, so the closeout must not call it.
    expect(closeoutSteps().flatMap((step) => step.toolCalls ?? []).some((call) => call.name === "finish_ticket")).toBe(
      false,
    );
  });

  it("gives the reviewer only read/grep/bash turns, as text (it has no Result tools)", () => {
    const reviewerSteps = MODEL_SCRIPT.steps.filter((step) => step.model === "review");
    expect(reviewerSteps.length).toBeGreaterThan(0);
    for (const step of reviewerSteps) {
      for (const call of step.toolCalls ?? []) {
        expect(REVIEWER_TOOLS).toContain(call.name);
      }
      // The reviewer answers with a report; it cannot finish anything.
      expect(step.text).toBeDefined();
    }
  });

  it("ends the closeout with a finish_spec carrying a prBody", () => {
    const finishSpec = MODEL_SCRIPT.steps.flatMap((step) =>
      (step.toolCalls ?? []).filter((call) => call.name === "finish_spec"),
    )[0];
    expect(finishSpec).toBeDefined();
    expect(typeof finishSpec!.arguments["prBody"]).toBe("string");
    expect(String(finishSpec!.arguments["prBody"]).length).toBeGreaterThan(0);
    // The App appends `Closes #<spec>` itself; the script must not pre-empt it.
    expect(String(finishSpec!.arguments["prBody"])).not.toContain("Closes #");
  });

  it("writes a distinct file per ticket so both commits are visible on the branch", () => {
    const written = MODEL_SCRIPT.steps.flatMap((step) =>
      (step.toolCalls ?? [])
        .filter((call) => call.name === "write")
        .map((call) => String(call.arguments["path"])),
    );
    expect(written).toHaveLength(TICKET_NUMBERS.length);
    expect(new Set(written).size).toBe(written.length);
  });
});
