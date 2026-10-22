import { describe, expect, it } from "vitest";
import { isRunResultV1, type RunResultV1 } from "../src/run-result.js";

describe("run result v1 shape", () => {
  it("accepts a minimal done payload", () => {
    const result: RunResultV1 = { v: 1, outcome: "done", summary: "implemented #34" };
    expect(isRunResultV1(result)).toBe(true);
  });

  it("accepts a full finish_spec payload", () => {
    const result: RunResultV1 = {
      v: 1,
      outcome: "done",
      summary: "spec complete",
      prBody: "Closes #33",
      newTickets: [{ title: "follow-up", body: "details", readyForAgent: true }],
      warnings: ["minor leftovers"],
    };
    expect(isRunResultV1(result)).toBe(true);
  });

  it("rejects outcome=error — the agent can never self-report error", () => {
    expect(isRunResultV1({ v: 1, outcome: "error", summary: "x" })).toBe(false);
  });

  it("rejects wrong version, missing summary, or non-object", () => {
    expect(isRunResultV1({ v: 2, outcome: "done", summary: "x" })).toBe(false);
    expect(isRunResultV1({ v: 1, outcome: "done" })).toBe(false);
    expect(isRunResultV1(null)).toBe(false);
    expect(isRunResultV1("done")).toBe(false);
  });
});
