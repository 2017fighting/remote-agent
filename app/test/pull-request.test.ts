import { describe, expect, it } from "vitest";
import { closesLine, renderCloseoutPrBody } from "../src/renders/pull-request.js";

/**
 * The closeout PR body (docs/architecture.md §4.5 S3, ADR-0002): the App appends
 * the `Closes #<spec>` trailer, and appending it twice is the failure mode that
 * matters — the PR is the only thing that closes the spec, and a duplicated
 * trailer makes the body lie about how many times it does.
 */

describe("closeout PR body", () => {
  it("appends exactly one Closes line after the agent's prBody", () => {
    const body = renderCloseoutPrBody("## Summary\n\nThe shape of the change.", 33);
    expect(body).toBe("## Summary\n\nThe shape of the change.\n\nCloses #33");
    expect(closesLine(33)).toBe("Closes #33");
  });

  it("does not append a second Closes when the body already carries it", () => {
    const once = renderCloseoutPrBody("## Summary\n\nDone.\n\nCloses #33", 33);
    expect(once.match(/^Closes #33$/gm)).toHaveLength(1);
    expect(renderCloseoutPrBody(once, 33)).toBe(once);
  });

  it("treats a longer issue number as a different trailer", () => {
    const body = renderCloseoutPrBody("Closes #338", 33);
    expect(body.match(/^Closes #33$/gm)).toHaveLength(1);
    expect(body).toContain("Closes #338");
  });

  it("handles an empty prBody: the trailer is still a complete body", () => {
    expect(renderCloseoutPrBody("", 33)).toBe("Closes #33");
  });
});
