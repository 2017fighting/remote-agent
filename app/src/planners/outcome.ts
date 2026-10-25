import { ANNOTATIONS, isRunResultV1 } from "@remote-agent/shared";
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
  | "unrecoverable"
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

/**
 * What a Job's terminal state says, with no issue attached: the ticket judge and
 * the spec closeout judge differ only in the label sets they apply, so the
 * reading of the Job is shared. `running` covers both "not finished" and "no
 * Job object at all" being impossible to judge — the caller decides whether an
 * absent object is a fallback (`no-job`) or the normal pre-run state.
 */
export type JobVerdict =
  | { kind: "running" }
  | { kind: "done"; result: RunResultV1 }
  | { kind: "blocked"; result: RunResultV1 }
  | { kind: "error"; reason: AppErrorReason; summary: string | null };

export interface OutcomeInput {
  issue: GitHubIssue;
  /** The Job under `jobName(issue.ownerRepo, issue.number)`, or null when it does not exist. */
  job: K8sJob | null;
}

export function judgeOutcome(input: OutcomeInput): OutcomeTransition {
  const { issue, job } = input;
  if (!issue.labels.includes(LABEL_AGENT_IN_PROGRESS)) return { kind: "none" };

  const verdict = judgeJob(job);
  if (verdict.kind === "running") return { kind: "none" };
  if (verdict.kind === "done") {
    return { kind: "done", result: verdict.result, addLabels: DONE_LABELS.add, removeLabels: DONE_LABELS.remove };
  }
  if (verdict.kind === "blocked") {
    return {
      kind: "blocked",
      result: verdict.result,
      addLabels: BLOCKED_LABELS.add,
      removeLabels: BLOCKED_LABELS.remove,
    };
  }
  return { kind: "error", reason: verdict.reason, summary: verdict.summary, addLabels: ERROR_LABELS.add, removeLabels: ERROR_LABELS.remove };
}

/**
 * T4–T6e as a pure read of one Job (or its absence). `null` is the T6e shape: an
 * issue the App believes is occupied, with no object under the deterministic
 * name.
 */
export function judgeJob(job: K8sJob | null): JobVerdict {
  // T6e: the label says a Job occupies this issue, k8s says none exists.
  if (job === null) return errorVerdict("no-job", null);

  // T3 / T3L: a live Job (pod restarting or not) is not a result.
  if (!job.finished) return { kind: "running" };

  if (!isComplete(job)) {
    // T6b / T6c: a Failed Job never wrote an annotation, so none is read here.
    return errorVerdict(errorReasonFor(failedReason(job)), null);
  }

  // The one and only read of `remote-agent/run-result`.
  const parsed = parseRunResultAnnotation(job.annotations[ANNOTATIONS.runResult]);
  if (parsed === null) return errorVerdict("no-result", null); // T6d

  if (parsed.outcome === "done") return { kind: "done", result: parsed.result };
  if (parsed.outcome === "blocked") return { kind: "blocked", result: parsed.result };
  // T6a: the contract's shape allows `error` even though the agent cannot mean it.
  return errorVerdict("app-judged", parsed.outcome === "error" ? parsed.summary : null);
}

function errorVerdict(reason: AppErrorReason, summary: string | null): JobVerdict {
  return { kind: "error", reason, summary };
}

function isComplete(job: K8sJob): boolean {
  return job.conditions.some((condition) => condition.type === "Complete" && condition.status === "True");
}

/** `Failed` condition reason, if any: `BackoffLimitExceeded` / `DeadlineExceeded` / `PodFailurePolicy`. */
export function failedReason(job: K8sJob): string | undefined {
  return job.conditions.find((condition) => condition.type === "Failed" && condition.status === "True")?.reason;
}

/**
 * What a `Failed` Job's reason means to the human reading the comment.
 *
 * `PodFailurePolicy` is k8s' reason for a pod that tripped a `podFailurePolicy`
 * `FailJob` rule (`JobReasonPodFailurePolicy`, batch/v1). Those rules are exactly
 * the failures no later pod can fix — the seed's fatal exit 78, and the runner's
 * unreconcilable push (#55) — so they fail on the **first** pod. Reporting them as
 * `backoff-exhausted` told the human a retry budget had run out on a Job that
 * never retried, which is the opposite of what happened.
 *
 * An unknown reason stays `backoff-exhausted`: it is the ordinary k8s failure and
 * the safer thing to say about one this code does not recognise.
 */
function errorReasonFor(reason: string | undefined): AppErrorReason {
  if (reason === "DeadlineExceeded") return "deadline-exceeded";
  if (reason === "PodFailurePolicy") return "unrecoverable";
  return "backoff-exhausted";
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

  // The shared contract validator is the single spelling of "is this v1".
  if (isRunResultV1(value)) return { outcome: value.outcome, result: value };

  // T6a is the one shape outside the agent contract: `error` is never
  // self-reported, but the payload shape allows it and must be judged.
  if (payload["v"] === 1 && payload["outcome"] === "error" && typeof payload["summary"] === "string") {
    return { outcome: "error", summary: payload["summary"] };
  }
  return null;
}
