import { describe, expect, it } from "vitest";
import {
  commentMarker,
  hasCommentMarker,
  renderBlockedComment,
  renderDoneComment,
  renderErrorComment,
  renderEvidenceComment,
} from "../src/renders/comments.js";

/**
 * Comment renderer (docs/architecture.md §4.6, spec #33 §1): four English
 * templates, one stable marker each. The marker is the whole dedupe mechanism —
 * the App re-reads an issue's comments and skips a body that already carries it
 * (ADR-0001: no in-memory state).
 */

const JOB = "agent-2017fighting-remote-agent-36";
const RESULT = { v: 1 as const, outcome: "done" as const, summary: "the summary" };

describe("markers", () => {
  it("is <!-- remote-agent:<kind>:<job-name> -->", () => {
    expect(commentMarker("done", JOB)).toBe(`<!-- remote-agent:done:${JOB} -->`);
    expect(commentMarker("blocked", JOB)).toBe(`<!-- remote-agent:blocked:${JOB} -->`);
    expect(commentMarker("error", JOB)).toBe(`<!-- remote-agent:error:${JOB} -->`);
    expect(commentMarker("evidence", JOB)).toBe(`<!-- remote-agent:evidence:${JOB} -->`);
  });

  it("matches only the same kind and job name", () => {
    const body = renderDoneComment({ jobName: JOB, result: RESULT });
    expect(hasCommentMarker(body, "done", JOB)).toBe(true);
    expect(hasCommentMarker(body, "blocked", JOB)).toBe(false);
    expect(hasCommentMarker(body, "done", "agent-other-1")).toBe(false);
  });
});

describe("done template", () => {
  it("falls back to the summary when the agent gave no commentBody", () => {
    const body = renderDoneComment({ jobName: JOB, result: RESULT });
    expect(body).toContain("the summary");
    expect(body.startsWith(`<!-- remote-agent:done:${JOB} -->`)).toBe(true);
  });

  it("prefers commentBody over the summary", () => {
    const body = renderDoneComment({
      jobName: JOB,
      result: { ...RESULT, commentBody: "the long body" },
    });
    expect(body).toContain("the long body");
    expect(body).not.toContain("the summary");
  });

  it("appends warnings at the very end, one bullet each", () => {
    const body = renderDoneComment({
      jobName: JOB,
      result: { ...RESULT, commentBody: "body", warnings: ["w one", "w two"] },
    });
    expect(body.indexOf("w one")).toBeLessThan(body.indexOf("w two"));
    expect(body.trimEnd().endsWith("- w two")).toBe(true);
  });

  it("adds nothing when warnings are empty or absent", () => {
    const withEmpty = renderDoneComment({ jobName: JOB, result: { ...RESULT, warnings: [] } });
    expect(withEmpty).toBe(renderDoneComment({ jobName: JOB, result: RESULT }));
    expect(withEmpty).not.toContain("Warnings");
  });
});

describe("blocked template", () => {
  it("transcribes the agent's commentBody and adds the re-entry note when absent", () => {
    const withBody = renderBlockedComment({
      jobName: JOB,
      result: { v: 1, outcome: "blocked", summary: "s", commentBody: "what a human must change" },
    });
    expect(withBody).toContain("what a human must change");
    expect(withBody).not.toContain("kubectl delete job");

    const withoutBody = renderBlockedComment({
      jobName: JOB,
      result: { v: 1, outcome: "blocked", summary: "the summary" },
    });
    expect(withoutBody).toContain("the summary");
    expect(withoutBody).toContain("kubectl delete job");
  });
});

describe("error template (T6a)", () => {
  it("states the App-judged reason and the agent's summary", () => {
    const body = renderErrorComment({ jobName: JOB, reason: "app-judged", summary: "self-reported" });
    expect(body).toContain("outcome=error");
    expect(body).toContain("app-judged");
    expect(body).toContain("self-reported");
    expect(body).toContain(JOB);
  });
});

describe("evidence template (T6b–e)", () => {
  const evidence = {
    jobName: JOB,
    reason: "deadline-exceeded" as const,
    jobExists: true,
    podName: `${JOB}-abcde`,
    podPhase: "Failed",
    containerEvidence: ["Container `runner` reason=`OOMKilled` exitCode=`137`"],
    jobEvidence: ["Job condition: `Failed` reason=`DeadlineExceeded`"],
    logTail: "the last log line",
    pvcName: JOB,
    expiresAt: "2025-03-31T12:00:00.000Z",
  };

  it("carries every element ADR-0010 / 0011 / 0013 require", () => {
    const body = renderEvidenceComment(evidence);
    expect(body).toContain("outcome=error");
    expect(body).toContain("deadline-exceeded");
    expect(body).toContain(JOB); // Job name
    expect(body).toContain(`${JOB}-abcde`); // pod name
    expect(body).toContain("OOMKilled");
    expect(body).toContain("exitCode");
    expect(body).toContain("DeadlineExceeded");
    expect(body).toContain("the last log line");
    expect(body).toContain(JOB); // Ticket PVC name
    expect(body).toContain("2025-03-31T12:00:00.000Z"); // retention date
    expect(body).toContain("kubectl delete job"); // escape hatch
    expect(body).toContain("never pushed"); // unpushed-commit warning
  });

  it("says so when the Job object and its pod are both gone (T6e)", () => {
    const body = renderEvidenceComment({
      ...evidence,
      reason: "no-job",
      jobExists: false,
      podName: null,
      podPhase: null,
      containerEvidence: [],
      jobEvidence: [],
      logTail: null,
    });
    expect(body).toContain("no longer exists");
    expect(body).toContain("no pod of this Job is left");
    expect(body).toContain("none — the Job and its pod are both gone");
    expect(body).toContain("_no logs available_");
    // The retention and unpushed-commit notes still apply.
    expect(body).toContain("2025-03-31T12:00:00.000Z");
    expect(body).toContain("never pushed");
  });

  it("is English throughout", () => {
    const body = renderEvidenceComment(evidence);
    expect(body).not.toMatch(/[一-龥]/);
  });
});
