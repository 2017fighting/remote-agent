import { ANNOTATIONS, jobName, pvcName } from "@remote-agent/shared";
import type { RunResultV1 } from "@remote-agent/shared";
import type { GitHubIssue, GitHubPort } from "./ports/GitHubPort.js";
import type { K8sContainerStatus, K8sJob, K8sPod, K8sPort } from "./ports/K8sPort.js";
import { ticketPvcExpiresAt, type AppErrorReason } from "./planners/outcome.js";
import {
  hasCommentMarker,
  renderBlockedComment,
  renderErrorComment,
  renderEvidenceComment,
  type CommentKind,
} from "./renders/comments.js";

/**
 * The writes a judged outcome causes on an issue — shared by the ticket role
 * (T4–T6e) and the spec role (S3–S5). The two differ only in the label set and
 * in what "done" means (close the ticket vs open the PR), so everything that is
 * the same lives here once: the label migration, the marker-deduped comment, the
 * evidence gathering and the `expires-at` clock.
 *
 * Every write is idempotent on re-read — labels are set semantics, comments
 * dedupe on their marker, `expires-at` is set-if-absent — which is what keeps a
 * replayed pass free (ADR-0001).
 */

export interface OutcomeEffectsDeps {
  github: GitHubPort;
  k8s: K8sPort;
  /** Judged-at clock for `expires-at`; injected so tests can pin the date. */
  now: () => Date;
}

/** Label set to apply: `add` / `remove` are the port's own spelling (set semantics). */
export interface LabelMigration {
  add: string[];
  remove: string[];
}

export async function migrateLabels(
  github: GitHubPort,
  issue: GitHubIssue,
  migration: LabelMigration,
): Promise<void> {
  await github.editLabels(issue.ownerRepo, issue.number, migration.add, migration.remove);
}

/** Post unless a comment carrying this marker is already on the issue (dedupe on re-read). */
export async function postOnce(
  github: GitHubPort,
  issue: GitHubIssue,
  kind: CommentKind,
  jobNameValue: string,
  body: string,
): Promise<void> {
  const comments = await github.listComments(issue.ownerRepo, issue.number);
  if (comments.some((comment) => hasCommentMarker(comment.body, kind, jobNameValue))) return;
  await github.addComment(issue.ownerRepo, issue.number, body);
}

/**
 * What a non-`done` run reports. `blocked` carries the agent's payload; `error`
 * carries the App-derived reason (and a summary only on the self-reported
 * defensive branch), because the four App reasons have no payload behind them.
 */
export type FailureReport =
  | { outcome: "blocked"; result: RunResultV1 }
  | { outcome: "error"; reason: AppErrorReason; summary: string | null };

/**
 * The `blocked` / `error` comment for a judged run. `error` has two templates:
 * a self-reported payload (`app-judged`) is its own report, while the four
 * App-derived reasons have no annotation behind them and need evidence.
 */
export async function postFailureComment(
  deps: OutcomeEffectsDeps,
  issue: GitHubIssue,
  job: K8sJob | null,
  pods: K8sPod[],
  failure: FailureReport,
  judgedAt: Date,
): Promise<void> {
  const name = jobName(issue.ownerRepo, issue.number);
  if (failure.outcome === "blocked") {
    await postOnce(deps.github, issue, "blocked", name, renderBlockedComment({ jobName: name, result: failure.result }));
    return;
  }

  if (failure.reason === "app-judged") {
    // T6a / S5a: a payload exists, so the App has nothing to gather — the
    // agent's own summary is the whole report.
    await postOnce(
      deps.github,
      issue,
      "error",
      name,
      renderErrorComment({ jobName: name, reason: failure.reason, summary: failure.summary }),
    );
    return;
  }
  const evidence = await gatherEvidence(deps, issue, job, pods, failure.reason, judgedAt);
  await postOnce(deps.github, issue, "evidence", name, renderEvidenceComment(evidence));
}

/** T6b–T6e / S5b–e: the App's own account of a run that left no readable run result. */
async function gatherEvidence(
  deps: OutcomeEffectsDeps,
  issue: GitHubIssue,
  job: K8sJob | null,
  pods: K8sPod[],
  reason: AppErrorReason,
  judgedAt: Date,
) {
  const name = jobName(issue.ownerRepo, issue.number);
  const volume = pvcName(issue.ownerRepo, issue.number);

  // The pod is evidence only: the outcome was already judged from the Job.
  const owned = job === null ? [] : pods.filter((pod) => pod.ownerJobName === job.name);
  const pod = owned.at(-1) ?? null;
  const logTail = pod === null ? null : await readLogTail(deps.k8s, pod.name);

  return {
    jobName: name,
    reason,
    jobExists: job !== null,
    podName: pod?.name ?? null,
    podPhase: pod?.phase ?? null,
    containerEvidence: containerEvidenceLines(pod),
    jobEvidence: jobEvidenceLines(job),
    logTail,
    pvcName: volume,
    expiresAt: ticketPvcExpiresAt("error", judgedAt),
  };
}

function jobEvidenceLines(job: K8sJob | null): string[] {
  if (job === null) return [];
  return job.conditions
    .filter((condition) => condition.status === "True")
    .map((condition) => `Job condition: \`${condition.type}\`${condition.reason ? ` reason=\`${condition.reason}\`` : ""}`);
}

function containerEvidenceLines(pod: K8sPod | null): string[] {
  if (pod === null) return [];
  const statuses: K8sContainerStatus[] = pod.containerStatuses ?? [];
  return statuses.map((status) => {
    const parts = [`Container \`${status.name}\``];
    if (status.reason !== undefined) parts.push(`reason=\`${status.reason}\``);
    if (status.exitCode !== undefined) parts.push(`exitCode=\`${status.exitCode}\``);
    return parts.join(" ");
  });
}

const LOG_TAIL_LINES = 40;

async function readLogTail(k8s: K8sPort, podName: string): Promise<string> {
  try {
    const log = await k8s.getPodLog(podName);
    return log.split("\n").slice(-LOG_TAIL_LINES).join("\n");
  } catch {
    // Logs are evidence, not a decision input: a gone container must not fail
    // the pass and leave the issue stuck mid-transition.
    return "";
  }
}

/**
 * `expires-at` is written in the same pass that judged the outcome, and only
 * when absent: an existing value is the retention clock already running
 * (ADR-0011). A missing volume means nothing to expire.
 */
export async function setExpiresAtIfAbsent(
  deps: OutcomeEffectsDeps,
  issue: GitHubIssue,
  outcome: "done" | "blocked" | "error",
  judgedAt: Date,
): Promise<void> {
  const name = pvcName(issue.ownerRepo, issue.number);
  const pvc = await deps.k8s.getPvc(name);
  if (pvc === null) return;
  if (pvc.annotations[ANNOTATIONS.expiresAt] !== undefined) return;
  await deps.k8s.patchPvcAnnotations(name, {
    [ANNOTATIONS.expiresAt]: ticketPvcExpiresAt(outcome, judgedAt),
  });
}
