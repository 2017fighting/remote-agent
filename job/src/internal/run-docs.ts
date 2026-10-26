import { defineDoc } from "@earendil-works/pi-durable";

/**
 * The run's self-report, committed by the Result tool itself so it survives a
 * crash between "outcome decided" and "pushed + annotated" (ADR-0007/0009).
 * `payload` is the serialized `RunResultV1`; `""` means no result yet.
 */
export type RunResultState = {
  payload: string;
};

export const RunResultDoc = defineDoc<RunResultState>({
  kind: "remote-agent.run-result",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ payload: "" }),
  checkpointWhen: () => false,
});

/**
 * The one review round a run may take (spec #33 §6). Committed by `code_review`
 * itself, so a resumed run refuses a second round instead of fanning out again;
 * `fixedPoint` is `""` until the round completes.
 */
export type ReviewRoundState = {
  fixedPoint: string;
  spec: string;
  standards: string;
  completedAt: string;
};

export const ReviewRoundDoc = defineDoc<ReviewRoundState>({
  kind: "remote-agent.review-round",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ fixedPoint: "", spec: "", standards: "", completedAt: "" }),
  checkpointWhen: () => false,
});

/**
 * Set after a successful push + annotation. Its presence is what makes reopening
 * a cleanly finished volume do nothing at all: no model call, no second push, no
 * second annotation.
 */
export type RunCompletedState = {
  completedAt: string;
};

export const RunCompletedDoc = defineDoc<RunCompletedState>({
  kind: "remote-agent.run-completed",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ completedAt: "" }),
  checkpointWhen: () => false,
});

/**
 * The one conflict-resolution turn a run may take (#58): the push stopped on a
 * rebase conflict, so the stopped rebase is handed to the agent that wrote one
 * side of it.
 *
 * Three states, read from the volume rather than from the process, because each
 * one is a different instruction to a pod that opens this volume next:
 *
 * - `attemptedAt` is written **before** the turn is submitted, so a crash mid-turn
 *   resumes that same turn instead of granting a second one;
 * - `reported` is set by the Result tool that closes the turn (`commitRunResult`),
 *   which is also what lets it replace the run's earlier report;
 * - `files` is what git left unmerged, so a resumed pod hands over the same list.
 *
 * The budget is one **reported** attempt: `reported` plus another conflict is a
 * condition of the branch, not of the volume, and goes fatal.
 */
export type ConflictHandoffState = {
  /** ISO time the turn was claimed; "" until a rebase first stops on a conflict. */
  attemptedAt: string;
  /** The paths git left unmerged: the turn's, and the exit's, whole work list. */
  files: string[];
  /** Whether that turn has re-reported the run's result. */
  reported: boolean;
};

/** What a volume that never met a conflict reads: no attempt, no paths, no report. */
export const EMPTY_CONFLICT_HANDOFF: ConflictHandoffState = { attemptedAt: "", files: [], reported: false };

export const ConflictHandoffDoc = defineDoc<ConflictHandoffState>({
  kind: "remote-agent.conflict-handoff",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ attemptedAt: "", files: [], reported: false }),
  checkpointWhen: () => false,
});
