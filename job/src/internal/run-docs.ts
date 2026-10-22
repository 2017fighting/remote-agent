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
