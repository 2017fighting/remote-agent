import { ANNOTATIONS, jobName, pvcName } from "@remote-agent/shared";
import type { AppConfig } from "./config.js";
import type { GitHubIssue, GitHubPort } from "./ports/GitHubPort.js";
import type { K8sContainerStatus, K8sJob, K8sPod, K8sPort } from "./ports/K8sPort.js";
import {
  judgeOutcome,
  ticketPvcExpiresAt,
  type AppErrorReason,
  type OutcomeTransition,
} from "./planners/outcome.js";
import { LABEL_AGENT_IN_PROGRESS } from "./planners/gate.js";
import {
  hasCommentMarker,
  renderBlockedComment,
  renderDoneComment,
  renderErrorComment,
  renderEvidenceComment,
  type CommentKind,
} from "./renders/comments.js";

/**
 * Outcome handling (spec #33 §2 step 2, docs/architecture.md §4.3). Runs before
 * Claim, over every ticket that carries `agent:in-progress`.
 *
 * Write order per ticket is the one the state table pins down:
 *
 * 1. `done` — sub-issues first (if `newTickets` is non-empty), then the comment,
 *    the label migration and finally the close. Creating sub-issues *before*
 *    closing leaves no window where the ticket is closed and the follow-ups do
 *    not exist yet.
 * 2. `blocked` / `error` — label migration, then the comment. The ticket stays
 *    open: `error` and `blocked` are the human's entry point, not a retry path.
 * 3. `expires-at` on the Ticket PVC, set-if-absent, in this same pass — the
 *    retention clock belongs to the outcome (ADR-0011).
 *
 * Replayability: labels are set-semantics, the close is a no-op once closed,
 * comments dedupe on their marker, and `expires-at` is set-if-absent. A second
 * pass over the same world writes nothing — by then the ticket no longer has
 * `agent:in-progress`, so nothing here runs at all.
 */

export interface OutcomeStepDeps {
  config: AppConfig;
  github: GitHubPort;
  k8s: K8sPort;
  /** Judged-at clock for `expires-at`; injected so tests can pin the date. */
  now: () => Date;
}

export interface OutcomeStepResult {
  /** One entry per in-progress ticket that reached a terminal outcome. */
  judged: Array<{ issue: GitHubIssue; transition: OutcomeTransition }>;
}

/** T4–T6e for every in-progress ticket in the world. */
export async function handleOutcomes(
  deps: OutcomeStepDeps,
  issues: GitHubIssue[],
  jobsByName: ReadonlyMap<string, K8sJob>,
  pods: K8sPod[],
): Promise<OutcomeStepResult> {
  const judged: OutcomeStepResult["judged"] = [];

  for (const issue of issues) {
    if (!isInProgress(issue)) continue;
    const name = jobName(issue.ownerRepo, issue.number);
    const job = jobsByName.get(name) ?? null;
    const transition = judgeOutcome({ issue, job });
    if (transition.kind === "none") continue;

    await execute(deps, issue, job, pods, transition);
    judged.push({ issue, transition });
  }

  return { judged };
}

function isInProgress(issue: GitHubIssue): boolean {
  return issue.state === "open" && issue.labels.includes(LABEL_AGENT_IN_PROGRESS);
}

async function execute(
  deps: OutcomeStepDeps,
  issue: GitHubIssue,
  job: K8sJob | null,
  pods: K8sPod[],
  transition: Exclude<OutcomeTransition, { kind: "none" }>,
): Promise<void> {
  const { github } = deps;
  const name = jobName(issue.ownerRepo, issue.number);

  if (transition.kind === "done") {
    // Sub-issues before the close: the reverse order would leave a window with
    // the ticket closed and its follow-ups not yet created (§4.3 T4).
    for (const ticket of transition.result.newTickets ?? []) {
      await github.createIssue({
        ownerRepo: issue.ownerRepo,
        title: ticket.title,
        body: ticket.body,
        labels: [ticket.readyForAgent ? "ready-for-agent" : "ready-for-human"],
      });
    }
    await postOnce(github, issue, "done", name, renderDoneComment({ jobName: name, result: transition.result }));
    await migrateLabels(github, issue, transition);
    await github.closeIssue(issue.ownerRepo, issue.number);
  } else if (transition.kind === "blocked") {
    await migrateLabels(github, issue, transition);
    await postOnce(
      github,
      issue,
      "blocked",
      name,
      renderBlockedComment({ jobName: name, result: transition.result }),
    );
  } else {
    await migrateLabels(github, issue, transition);
    if (transition.reason === "app-judged") {
      // T6a: a payload exists, so the App has nothing to gather — the agent's
      // own summary is the whole report.
      await postOnce(
        github,
        issue,
        "error",
        name,
        renderErrorComment({ jobName: name, reason: transition.reason, summary: transition.summary }),
      );
    } else {
      const evidence = await gatherEvidence(deps, issue, job, pods, transition.reason);
      await postOnce(github, issue, "evidence", name, renderEvidenceComment(evidence));
    }
  }

  // `expires-at` is written in the same pass that judged the outcome, and only
  // when absent: an existing value is the retention clock already running.
  await setExpiresAtIfAbsent(deps, issue, transition.kind);
}

/** T6b–T6e: the App's own account of a run that left no readable run result. */
async function gatherEvidence(
  deps: OutcomeStepDeps,
  issue: GitHubIssue,
  job: K8sJob | null,
  pods: K8sPod[],
  reason: AppErrorReason,
) {
  const { k8s } = deps;
  const name = jobName(issue.ownerRepo, issue.number);
  const volume = pvcName(issue.ownerRepo, issue.number);

  // The pod is evidence only: the outcome was already judged from the Job.
  const owned = job === null ? [] : pods.filter((pod) => pod.ownerJobName === job.name);
  const pod = owned.at(-1) ?? null;
  const logTail = pod === null ? null : await readLogTail(k8s, pod.name);

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
    expiresAt: ticketPvcExpiresAt("error", deps.now()),
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
    // the pass and leave the ticket stuck in `agent:in-progress`.
    return "";
  }
}

async function migrateLabels(
  github: GitHubPort,
  issue: GitHubIssue,
  transition: Exclude<OutcomeTransition, { kind: "none" }>,
): Promise<void> {
  await github.editLabels(issue.ownerRepo, issue.number, transition.addLabels, transition.removeLabels);
}

/** Post unless a comment carrying this marker is already on the issue (dedupe on re-read). */
async function postOnce(
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

async function setExpiresAtIfAbsent(
  deps: OutcomeStepDeps,
  issue: GitHubIssue,
  outcome: "done" | "blocked" | "error",
): Promise<void> {
  const name = pvcName(issue.ownerRepo, issue.number);
  const pvc = await deps.k8s.getPvc(name);
  // A missing volume means nothing to expire; reclamation (#37) never sees it.
  if (pvc === null) return;
  if (pvc.annotations[ANNOTATIONS.expiresAt] !== undefined) return;
  await deps.k8s.patchPvcAnnotations(name, {
    [ANNOTATIONS.expiresAt]: ticketPvcExpiresAt(outcome, deps.now()),
  });
}
