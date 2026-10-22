import { ANNOTATIONS } from "@remote-agent/shared";
import type { RunResultV1 } from "@remote-agent/shared";
import type { GitHubIssue } from "../ports/GitHubPort.js";
import type { K8sJob } from "../ports/K8sPort.js";
import {
  LABEL_AGENT_BLOCKED,
  LABEL_AGENT_ERROR,
  LABEL_AGENT_IN_PROGRESS,
  LABEL_READY_FOR_AGENT,
  LABEL_READY_FOR_HUMAN,
} from "./gate.js";

/**
 * Outcome judge (docs/architecture.md §4.3, spec #33 §2 step 2). Pure: a ticket
 * that carries `agent:in-progress`, the Job under its deterministic name (or
 * its absence) and that Job's terminal conditions go in; one transition intent
 * comes out.
 *
 * ```
 * T4  done    ⟸ Job Complete ∧ annotation parses ∧ outcome=done
 * T5  blocked ⟸ Job Complete ∧ annotation parses ∧ outcome=blocked
 * T6a error   ⟸ Job Complete ∧ annotation parses ∧ outcome=error   (defensive)
 * T6b error   ⟸ Job Failed   reason=BackoffLimitExceeded           (no annotation)
 * T6c error   ⟸ Job Failed   reason=DeadlineExceeded               (no annotation)
 * T6d error   ⟸ Job Complete ∧ annotation missing / unparseable
 * T6e error   ⟸ `agent:in-progress` ∧ no Job under the deterministic name
 * ```
 *
 * Two disciplines are structural here, not conventions:
 *
 * - **The annotation is read exactly once per run.** It is consulted only on
 *   the `Complete` branch, and the whole judge only runs for tickets carrying
 *   `agent:in-progress` — i.e. in the pass that moves the ticket out of T3
 *   (ADR-0007 / ADR-0013). A Job still inside its retention window after that
 *   pass is never judged again: the ticket is no longer in-progress, and the
 *   Claim-gate's k8s half keeps it from being claimed while the object lives.
 * - **T6e is one shape only.** It fires when the label says in-progress and the
 *   deterministic name resolves to no Job. A ticket merely waiting inside the
 *   gate has no `agent:in-progress` and never reaches this planner.
 *
 * `error` is never an agent self-report in v1 (ADR-0007): the four App reasons
 * `backoff-exhausted` / `deadline-exceeded` / `no-result` / `no-job` are derived
 * from the Job's terminal state and from whether an annotation was readable.
 * T6a keeps the payload shape the contract allows, and reports `app-judged`
 * because the payload carries no `reason` field.
 */

/** The reasons the App derives; they never appear in a run result payload. */
export type AppErrorReason =
  | "app-judged"
  | "backoff-exhausted"
  | "deadline-exceeded"
  | "no-result"
  | "no-job";

/** Label sets per transition (docs/architecture.md §4.3). `agent:implement` is never touched. */
const DONE_LABELS = { add: [] as string[], remove: [LABEL_AGENT_IN_PROGRESS] };
const BLOCKED_LABELS = {
  add: [LABEL_READY_FOR_HUMAN, LABEL_AGENT_BLOCKED],
  remove: [LABEL_READY_FOR_AGENT, LABEL_AGENT_IN_PROGRESS],
};
const ERROR_LABELS = {
  add: [LABEL_READY_FOR_HUMAN, LABEL_AGENT_ERROR],
  remove: [LABEL_READY_FOR_AGENT, LABEL_AGENT_IN_PROGRESS],
};

/**
 * What this pass should do with one in-progress ticket. `none` means "still
 * running" (T3 / T3L): the pass writes nothing at all — pod restarts are
 * invisible to GitHub (§4.4).
 */
export type OutcomeTransition =
  | { kind: "none" }
  | { kind: "done"; result: RunResultV1; addLabels: string[]; removeLabels: string[] }
  | { kind: "blocked"; result: RunResultV1; addLabels: string[]; removeLabels: string[] }
  | {
      kind: "error";
      reason: AppErrorReason;
      /** Self-reported summary, only present on T6a. */
      summary: string | null;
      addLabels: string[];
      removeLabels: string[];
    };

/** Ticket PVC retention (ADR-0011): `done` keeps the volume 7 days, `blocked` / `error` 30. */
export const TICKET_PVC_RETENTION_DAYS = { done: 7, blocked: 30, error: 30 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `remote-agent/expires-at` value for a judged outcome: RFC3339, judged-at + retention. */
export function ticketPvcExpiresAt(outcome: keyof typeof TICKET_PVC_RETENTION_DAYS, now: Date): string {
  return new Date(now.getTime() + TICKET_PVC_RETENTION_DAYS[outcome] * DAY_MS).toISOString();
}

export interface OutcomeInput {
  issue: GitHubIssue;
  /** The Job under `jobName(issue.ownerRepo, issue.number)`, or null when it does not exist. */
  job: K8sJob | null;
}

export function judgeOutcome(input: OutcomeInput): OutcomeTransition {
  const { issue, job } = input;
  if (!issue.labels.includes(LABEL_AGENT_IN_PROGRESS)) return { kind: "none" };

  // T6e: the label says a Job occupies this ticket, k8s says none exists.
  if (job === null) return errorTransition("no-job", null);

  // T3 / T3L: a live Job (pod restarting or not) is not a result.
  if (!job.finished) return { kind: "none" };

  if (!isComplete(job)) {
    // T6b / T6c: a Failed Job never wrote an annotation, so none is read here.
    const reason = failedReason(job);
    return errorTransition(reason === "DeadlineExceeded" ? "deadline-exceeded" : "backoff-exhausted", null);
  }

  // The one and only read of `remote-agent/run-result`.
  const parsed = parseRunResultAnnotation(job.annotations[ANNOTATIONS.runResult]);
  if (parsed === null) return errorTransition("no-result", null); // T6d

  if (parsed.outcome === "done") {
    return { kind: "done", result: parsed.result, addLabels: DONE_LABELS.add, removeLabels: DONE_LABELS.remove };
  }
  if (parsed.outcome === "blocked") {
    return {
      kind: "blocked",
      result: parsed.result,
      addLabels: BLOCKED_LABELS.add,
      removeLabels: BLOCKED_LABELS.remove,
    };
  }
  // T6a: the contract's shape allows `error` even though the agent cannot mean it.
  return errorTransition("app-judged", parsed.outcome === "error" ? parsed.summary : null);
}

function errorTransition(reason: AppErrorReason, summary: string | null): OutcomeTransition {
  return { kind: "error", reason, summary, addLabels: ERROR_LABELS.add, removeLabels: ERROR_LABELS.remove };
}

function isComplete(job: K8sJob): boolean {
  return job.conditions.some((condition) => condition.type === "Complete" && condition.status === "True");
}

/** `Failed` condition reason (`BackoffLimitExceeded` / `DeadlineExceeded`), if any. */
export function failedReason(job: K8sJob): string | undefined {
  return job.conditions.find((condition) => condition.type === "Failed" && condition.status === "True")?.reason;
}

export type ParsedRunResult =
  | { outcome: "done" | "blocked"; result: RunResultV1 }
  | { outcome: "error"; summary: string };

/**
 * Read the annotation payload. Anything that is not a v1 payload with a known
 * outcome is `null`, which the judge turns into `no-result` — an unparseable
 * annotation and a missing one are the same thing to the App.
 */
export function parseRunResultAnnotation(raw: string | undefined): ParsedRunResult | null {
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const payload = value as Record<string, unknown>;
  if (payload["v"] !== 1 || typeof payload["summary"] !== "string") return null;

  const outcome = payload["outcome"];
  if (outcome === "done" || outcome === "blocked") {
    return { outcome, result: payload as unknown as RunResultV1 };
  }
  if (outcome === "error") return { outcome: "error", summary: payload["summary"] };
  return null;
}
