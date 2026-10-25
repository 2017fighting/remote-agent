import { describe, expect, it } from "vitest";
import { ANNOTATIONS } from "@remote-agent/shared";
import {
  judgeOutcome,
  parseRunResultAnnotation,
  ticketPvcExpiresAt,
  type OutcomeTransition,
} from "../src/planners/outcome.js";
import { GATE_LABELS, REPO, issue, managedJob } from "./world.js";

/**
 * Outcome judge (docs/architecture.md §4.3): one table row per terminal shape.
 * Pure — a ticket, its deterministic-name Job (or its absence) and the Job's
 * conditions go in, a transition intent comes out. No writes here; the write
 * order is tested on the App seam in outcome.test.ts.
 */

const IN_PROGRESS = [...GATE_LABELS, "agent:in-progress"];
const NOW = new Date("2025-03-01T12:00:00.000Z");

/** A Job whose conditions say what the k8s world would say. */
function job(conditions: Array<{ type: string; status: string; reason?: string }>, annotation?: string) {
  const base = managedJob(REPO, 36, { finished: true });
  base.conditions = conditions;
  if (annotation !== undefined) base.annotations[ANNOTATIONS.runResult] = annotation;
  return base;
}

const complete = (annotation?: string) => job([{ type: "Complete", status: "True" }], annotation);
const failed = (reason: string) => job([{ type: "Failed", status: "True", reason }]);

function runResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

interface Case {
  name: string;
  /** The Job under the deterministic name; `null` = T6e (no object at all). */
  job: ReturnType<typeof managedJob> | null;
  /** Labels the ticket carries; defaults to in-progress. */
  labels?: string[];
  expected: Pick<OutcomeTransition, "kind"> & {
    reason?: string;
    addLabels?: string[];
    removeLabels?: string[];
  };
}

const cases: Case[] = [
  {
    name: "T4 done: Complete + a done annotation",
    job: complete(runResult({ v: 1, outcome: "done", summary: "shipped it" })),
    expected: { kind: "done", addLabels: [], removeLabels: ["agent:in-progress"] },
  },
  {
    name: "T5 blocked: Complete + a blocked annotation",
    job: complete(runResult({ v: 1, outcome: "blocked", summary: "stuck", commentBody: "need a decision" })),
    expected: {
      kind: "blocked",
      addLabels: ["ready-for-human", "agent:blocked"],
      removeLabels: ["ready-for-agent", "agent:in-progress"],
    },
  },
  {
    name: "T6a self-reported error (defensive branch): Complete + outcome=error",
    job: complete(runResult({ v: 1, outcome: "error", summary: "the contract allows this shape" })),
    expected: {
      kind: "error",
      reason: "app-judged",
      addLabels: ["ready-for-human", "agent:error"],
      removeLabels: ["ready-for-agent", "agent:in-progress"],
    },
  },
  {
    name: "T6b backoff exhausted: Failed reason=BackoffLimitExceeded, no annotation",
    job: failed("BackoffLimitExceeded"),
    expected: {
      kind: "error",
      reason: "backoff-exhausted",
      addLabels: ["ready-for-human", "agent:error"],
      removeLabels: ["ready-for-agent", "agent:in-progress"],
    },
  },
  {
    /**
     * T6b2: a `podFailurePolicy` `FailJob` rule fired. k8s names this reason
     * `PodFailurePolicy` (`JobReasonPodFailurePolicy`, batch/v1), and it means the
     * pod failed on a class no later pod can fix — the seed's fatal exit 78, or the
     * runner's unreconcilable push (#55). Reporting it as `backoff-exhausted` would
     * tell the human a retry budget ran out on a Job that never retried.
     */
    name: "T6b2 unrecoverable: Failed reason=PodFailurePolicy, no annotation",
    job: failed("PodFailurePolicy"),
    expected: {
      kind: "error",
      reason: "unrecoverable",
      addLabels: ["ready-for-human", "agent:error"],
      removeLabels: ["ready-for-agent", "agent:in-progress"],
    },
  },
  {
    name: "T6c deadline exceeded: Failed reason=DeadlineExceeded, no annotation",
    job: failed("DeadlineExceeded"),
    expected: {
      kind: "error",
      reason: "deadline-exceeded",
      addLabels: ["ready-for-human", "agent:error"],
      removeLabels: ["ready-for-agent", "agent:in-progress"],
    },
  },
  {
    name: "T6d no-result: Complete with no annotation at all",
    job: complete(),
    expected: {
      kind: "error",
      reason: "no-result",
      addLabels: ["ready-for-human", "agent:error"],
      removeLabels: ["ready-for-agent", "agent:in-progress"],
    },
  },
  {
    name: "T6d no-result: Complete with an unparseable annotation",
    job: complete("not json at all"),
    expected: {
      kind: "error",
      reason: "no-result",
      addLabels: ["ready-for-human", "agent:error"],
      removeLabels: ["ready-for-agent", "agent:in-progress"],
    },
  },
  {
    name: "T6e no-job: agent:in-progress and no Job under the deterministic name",
    job: null,
    expected: {
      kind: "error",
      reason: "no-job",
      addLabels: ["ready-for-human", "agent:error"],
      removeLabels: ["ready-for-agent", "agent:in-progress"],
    },
  },
];

describe("outcome judge: T4 / T5 / T6a–e", () => {
  for (const c of cases) {
    it(`${c.name} → ${c.expected.kind}`, () => {
      const transition = judgeOutcome({
        issue: issue(36, c.labels ?? IN_PROGRESS),
        job: c.job === null ? null : c.job,
      });

      expect(transition.kind).toBe(c.expected.kind);
      if (transition.kind === "none") throw new Error("expected a terminal transition");
      expect(transition.addLabels).toEqual(c.expected.addLabels);
      expect(transition.removeLabels).toEqual(c.expected.removeLabels);
      if (transition.kind === "error") expect(transition.reason).toBe(c.expected.reason);
    });
  }

  it("covers every App-derived error reason", () => {
    const reasons = cases
      .map((c) => c.expected.reason)
      .filter((reason): reason is string => reason !== undefined);
    expect(new Set(reasons)).toEqual(
      new Set(["app-judged", "backoff-exhausted", "deadline-exceeded", "unrecoverable", "no-result", "no-job"]),
    );
  });
});

describe("outcome judge: T3 and T3L write nothing", () => {
  it("a non-terminal Job is still running — pod restarts are invisible to GitHub", () => {
    const running = managedJob(REPO, 36);
    running.annotations[ANNOTATIONS.runResult] = runResult({ v: 1, outcome: "done", summary: "early" });
    expect(judgeOutcome({ issue: issue(36, IN_PROGRESS), job: running })).toEqual({ kind: "none" });
  });

  it("a ticket without agent:in-progress is never judged (T6e needs the label)", () => {
    expect(judgeOutcome({ issue: issue(36, GATE_LABELS), job: null })).toEqual({ kind: "none" });
  });

  it("a ticket waiting in the gate with a lingering Job is not judged either", () => {
    // The ADR-0013 wait shape: in the gate, old Job object still there.
    expect(judgeOutcome({ issue: issue(36, GATE_LABELS), job: failed("DeadlineExceeded") })).toEqual({
      kind: "none",
    });
  });
});

describe("outcome judge: annotation parsing", () => {
  it("accepts v1 done and blocked payloads", () => {
    expect(parseRunResultAnnotation(runResult({ v: 1, outcome: "done", summary: "s" }))).toEqual({
      outcome: "done",
      result: { v: 1, outcome: "done", summary: "s" },
    });
    expect(parseRunResultAnnotation(runResult({ v: 1, outcome: "blocked", summary: "s" }))?.outcome).toBe(
      "blocked",
    );
  });

  it("reads the defensive error shape as a summary, not a run result", () => {
    expect(parseRunResultAnnotation(runResult({ v: 1, outcome: "error", summary: "boom" }))).toEqual({
      outcome: "error",
      summary: "boom",
    });
  });

  it("rejects anything that is not a v1 payload with a known outcome", () => {
    for (const raw of [
      undefined,
      "",
      "{}",
      '{"v":2,"outcome":"done","summary":"s"}',
      '{"v":1,"outcome":"weird","summary":"s"}',
      '{"v":1,"summary":"no outcome"}',
      '{"v":1,"outcome":"done"}',
      "null",
      "[1,2,3]",
    ]) {
      expect(parseRunResultAnnotation(raw), String(raw)).toBeNull();
    }
  });
});

describe("ticket PVC retention (ADR-0011)", () => {
  it("done keeps the volume 7 days, blocked / error 30", () => {
    expect(ticketPvcExpiresAt("done", NOW)).toBe("2025-03-08T12:00:00.000Z");
    expect(ticketPvcExpiresAt("blocked", NOW)).toBe("2025-03-31T12:00:00.000Z");
    expect(ticketPvcExpiresAt("error", NOW)).toBe("2025-03-31T12:00:00.000Z");
  });
});
