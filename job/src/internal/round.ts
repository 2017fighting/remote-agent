import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness as HarnessHandle } from "@earendil-works/pi-durable";
import { isRunResultV1 } from "@remote-agent/shared";
import { ReviewFixedPointDoc } from "./fixed-point-doc.js";
import {
  ConflictHandoffDoc,
  ReviewRoundDoc,
  RunCompletedDoc,
  RunResultDoc,
} from "./run-docs.js";

const context = BACKGROUND_CONTEXT;

/**
 * The round boundary on a ticket's volume (ADR-0017).
 *
 * A **round** is one run that reported. A ticket's conversation carries several:
 * the human reopens a `done` ticket (or re-enters a `blocked` one), the Job
 * object leaves its retention window, the next Claim reuses the same volume, and
 * the new Job runs the next round **on the same conversation** — which is the
 * whole point of reusing the volume (ADR-0011).
 *
 * What makes that a new round rather than a repeat of the finished one is this
 * reset: everything one round writes and the next must not inherit is cleared in
 * one commit, before the first model request. Five documents, and each one has a
 * failure mode of its own:
 *
 * - `run-completed` — left alone, the open path treats the volume as finished.
 * - `run-result` — left alone, the open path takes its "outcome decided but not
 *   delivered" branch: it skips the agent and re-pushes and re-annotates the
 *   **previous** round's result, which the App reads as this round's.
 * - `review-fixed-point` — a per-run value; inheriting it reviews the wrong range.
 * - `review-round` — left alone, the new round's `code_review` bounces as
 *   "already ran" and its work is never reviewed.
 * - `conflict-handoff` — the conflict turn's budget is per run; inheriting a
 *   spent one turns the new round's first conflict fatal.
 *
 * Each document is reset from its own definition's initial value, so a field
 * added to one of them cannot be forgotten here.
 */
export async function resetForNewRound(harness: HarnessHandle, root: Conversation): Promise<void> {
  await root.commit(async (tx) => {
    Object.assign(await tx.doc(RunCompletedDoc, root.id), RunCompletedDoc.definition.initial());
    Object.assign(await tx.doc(RunResultDoc, root.id), RunResultDoc.definition.initial());
    Object.assign(await tx.doc(ReviewFixedPointDoc, root.id), ReviewFixedPointDoc.definition.initial());
    Object.assign(await tx.doc(ReviewRoundDoc, root.id), ReviewRoundDoc.definition.initial());
    Object.assign(await tx.doc(ConflictHandoffDoc, root.id), ConflictHandoffDoc.definition.initial());
  }, context);
}

/**
 * How the round before this one ended, read **before** the reset clears it: the
 * outcome it reported and when. `outcome` is `null` when the payload is absent or
 * unreadable, which the round header renders as "cannot tell" rather than failing
 * the round (ADR-0017).
 */
export interface PreviousRound {
  outcome: string | null;
  completedAt: string;
}

export async function readPreviousRound(harness: HarnessHandle, root: Conversation): Promise<PreviousRound> {
  const completed = await harness.snapshot(RunCompletedDoc, root.id, context);
  const committed = await harness.snapshot(RunResultDoc, root.id, context);
  return { outcome: outcomeOf(committed?.payload ?? ""), completedAt: completed?.completedAt ?? "" };
}

function outcomeOf(payload: string): string | null {
  if (payload === "") return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return isRunResultV1(parsed) ? parsed.outcome : null;
  } catch {
    return null;
  }
}

/** What the runner knows about this round when it renders the prompt. */
export interface RoundContext {
  /** 1 for a fresh conversation; every reported round adds one. */
  round: number;
  /**
   * How the round before this one ended, read before the reset cleared it — or
   * `null` when this pod did not see that boundary (it opened a volume whose reset
   * already landed), in which case the header says only what is still true.
   */
  previous: PreviousRound | null;
}

/**
 * The header the runner puts in front of the prompt for round 2 and later
 * (ADR-0017): what the conversation cannot say for itself.
 *
 * The history in front of the model ends with its own last act — reporting `done`
 * or `blocked` — and the work item's comments are the human's answer to it. Without
 * a line naming the round, the cheapest thing for the model to do is report the
 * same outcome again, which is the failure ADR-0011 names ("否则 agent 可能直接再报
 * 一次 done"). Round 1 gets nothing: there is no previous round to describe.
 */
export function roundHeader(context: RoundContext): string {
  if (context.round <= 1) return "";
  const previous = context.previous;
  const reported =
    previous?.outcome == null
      ? "A previous round of this ticket already ran and reported its outcome"
      : `A previous round of this ticket already ran and reported **${previous.outcome}**`;
  const when = previous?.completedAt ? ` at ${previous.completedAt}` : "";
  return [
    `# Round ${context.round} of this ticket`,
    "",
    `${reported}${when}. This run is a new round on the same conversation, not a continuation of that ` +
      "report: the work item's comments are what happened since, so re-read them and continue the work — do " +
      "not simply re-report the outcome.",
  ].join("\n");
}
