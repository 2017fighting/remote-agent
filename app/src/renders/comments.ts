import { commentMarker } from "@remote-agent/shared";
import type { RunResultV1 } from "@remote-agent/shared";
import type { AppErrorReason } from "../planners/outcome.js";

/**
 * Comment renderer (docs/architecture.md §4.6, spec #33 §1 `comment renderer`).
 * Four English templates — `done` / `blocked` / `error` / `evidence` — and one
 * stable marker per comment:
 *
 * ```
 * <!-- remote-agent:<kind>:<job-name> -->
 * ```
 *
 * The marker is what makes posting replayable: the App re-reads the issue's
 * comments before posting and skips a body whose marker is already there, so
 * no control-plane state is needed to avoid double-posting (ADR-0001).
 *
 * `done` and `blocked` carry the agent's own `commentBody` when it gave one
 * (ADR-0002: the agent never writes GitHub, so the App transcribes). The
 * `evidence` template is the App's own account of a run that died without a
 * readable run result: it is the human's only entry point, because `error` is
 * never retried automatically (ADR-0008).
 */

export type CommentKind = "done" | "blocked" | "error" | "evidence";

// One definition of the marker, in the shared contract: the App writes it and the
// dedupe read compares against it, so a drift here would double-post every comment.
export { commentMarker };

/** True when a comment body already carries this marker (dedupe on re-read). */
export function hasCommentMarker(body: string, kind: CommentKind, jobName: string): boolean {
  return body.includes(commentMarker(kind, jobName));
}

export interface DoneCommentInput {
  jobName: string;
  result: RunResultV1;
}

/** T4: `commentBody` wins; otherwise the App's own summary block. `warnings[]` always goes last. */
export function renderDoneComment(input: DoneCommentInput): string {
  const { jobName, result } = input;
  const body = result.commentBody?.trim()
    ? result.commentBody
    : ["## Ticket done", "", result.summary].join("\n");

  const warnings = result.warnings ?? [];
  const withWarnings =
    warnings.length === 0
      ? body
      : [body, "", "### Warnings", ...warnings.map((warning) => `- ${warning}`)].join("\n");

  return [commentMarker("done", jobName), withWarnings].join("\n");
}

export interface BlockedCommentInput {
  jobName: string;
  result: RunResultV1;
}

/** T5: the ticket stays open; the comment says what the human has to change. */
export function renderBlockedComment(input: BlockedCommentInput): string {
  const { jobName, result } = input;
  const body = result.commentBody?.trim()
    ? result.commentBody
    : ["## Agent is blocked", "", result.summary, "", reentryLine(jobName)].join("\n");
  return [commentMarker("blocked", jobName), body].join("\n");
}

export interface ErrorCommentInput {
  jobName: string;
  reason: AppErrorReason;
  /** Self-reported summary; only T6a has one. */
  summary: string | null;
}

/** T6a: the contract's defensive `error` shape — a payload, but no evidence run to gather. */
export function renderErrorComment(input: ErrorCommentInput): string {
  const lines = [
    commentMarker("error", input.jobName),
    "## Agent run reported an error",
    "",
    `\`outcome=error\` — App-judged reason: **${input.reason}**.`,
  ];
  if (input.summary !== null) lines.push("", input.summary);
  lines.push("", `- Job: \`${input.jobName}\``, "", reentryLine(input.jobName));
  return lines.join("\n");
}

export interface EvidenceCommentInput {
  jobName: string;
  reason: AppErrorReason;
  /** The Job object under the deterministic name, or null on the `no-job` path. */
  jobExists: boolean;
  podName: string | null;
  podPhase: string | null;
  /** One line per container: reason and exit code as kubelet reported them. */
  containerEvidence: string[];
  /** Terminal Job conditions, e.g. `Failed reason=DeadlineExceeded`. */
  jobEvidence: string[];
  /** Tail of the last pod's logs; null when there was no pod to read. */
  logTail: string | null;
  pvcName: string;
  /** RFC3339 — the Ticket PVC's `remote-agent/expires-at`. */
  expiresAt: string;
}

/**
 * T6b–T6e: the App's own evidence comment. Every element here is mandated by
 * ADR-0010 / ADR-0011 / ADR-0013, because no annotation exists on these paths
 * and this comment is all the human gets.
 */
export function renderEvidenceComment(input: EvidenceCommentInput): string {
  const lines = [
    commentMarker("evidence", input.jobName),
    "## Agent run failed",
    "",
    `\`outcome=error\` — App-judged reason: **${input.reason}**.`,
    "",
    `- Job: \`${input.jobName}\`${input.jobExists ? "" : " (the object no longer exists)"}`,
    `- Pod: ${input.podName === null ? "unknown — no pod of this Job is left" : `\`${input.podName}\``}`,
  ];

  if (input.podPhase !== null) lines.push(`- Pod phase: \`${input.podPhase}\``);

  lines.push("", "Pod terminal evidence:");
  if (input.jobEvidence.length === 0 && input.containerEvidence.length === 0) {
    lines.push("- none — the Job and its pod are both gone");
  } else {
    for (const line of input.jobEvidence) lines.push(`- ${line}`);
    for (const line of input.containerEvidence) lines.push(`- ${line}`);
  }

  lines.push("", "Container log tail:");
  lines.push(input.logTail === null || input.logTail.trim() === "" ? "_no logs available_" : fenced(input.logTail));

  lines.push(
    "",
    `- Ticket PVC: \`${input.pvcName}\` — the whole conversation lives here; read it with \`kubectl logs\` on the pod above.`,
    `- Retention: this volume is kept until **${input.expiresAt}** (\`remote-agent/expires-at\`).`,
    "- The volume may hold commits that were never pushed: on the `backoffLimit` / `DeadlineExceeded` / `no-result` paths the runner may have died before pushing, so this volume is the only copy of that work.",
    "",
    reentryLine(input.jobName),
  );

  // A failure that is a condition of the volume needs the volume discarded, or the
  // next run resumes to the same state and fails the same way. `unrecoverable` is
  // exactly that class: a push the runner could not reconcile, or a credential it
  // could not read.
  if (input.reason === "unrecoverable") lines.push("", volumeResetLine(input.pvcName));

  return lines.join("\n");
}

/** The ADR-0013 re-entry note, shared by the blocked / error / evidence templates. */
function reentryLine(jobName: string): string {
  return [
    "Re-entry: remove the `agent:*` exit label and switch `ready-for-human` back to `ready-for-agent`.",
    "If the old Job is still inside its retention window, the new run starts within ~30 minutes at the latest;",
    `to skip the wait, \`kubectl delete job ${jobName}\` — the delete event wakes Claim immediately.`,
  ].join(" ");
}

/**
 * The extra step a re-entry needs when the failure was a condition of the
 * **volume** rather than of one run.
 *
 * The App reuses the Ticket PVC on re-entry (ADR-0011), so a run that ended on
 * something recorded in its durable storage — an unreconcilable push (#55), or a
 * settled `unanswered` submission (#52) — resumes to the same state and fails
 * identically. Re-labelling alone would burn another `backoffLimit` for nothing,
 * so the human has to discard the volume and its credential as well.
 *
 * `blocked` is the agent's own verdict and never needs this: it is a report, not a
 * stuck state.
 */
function volumeResetLine(pvcName: string): string {
  return [
    "**This failure lives on the volume, so re-labelling alone will fail the same way.**",
    `Discard it first: \`kubectl delete pvc ${pvcName}\` and`,
    `\`kubectl delete secret ${pvcName}-token\` (Claim mints a new credential only when the Secret is absent).`,
    "The volume is the only copy of any commits that were never pushed, so check that before deleting.",
  ].join(" ");
}

function fenced(text: string): string {
  return ["```", text.trimEnd(), "```"].join("\n");
}
