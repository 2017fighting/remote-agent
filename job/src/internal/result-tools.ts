import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { RunResultV1 } from "@remote-agent/shared";
import type { AgentRole } from "./env.js";
import { RunResultDoc } from "./run-docs.js";

export const RESULT_EXTENSION_NAME = "remote-agent-result";

export interface ResultToolsOptions {
  role: AgentRole;
  /**
   * Persist the outcome in the same commit the tool's call ends in, so a crash
   * after "outcome decided" still resumes to a pushable result (ADR-0009).
   * Resolves false when the run already self-reported: the first call wins, so
   * one run produces exactly one annotation.
   */
  record(result: RunResultV1, api: ToolExecutionApi): Promise<boolean>;
}

const summarySchema = Type.String({ description: "One or two sentences on what this run delivered or why it stopped." });
const commentBodySchema = Type.String({ description: "The comment posted back to the issue." });
const warningsSchema = Type.Optional(Type.Array(Type.String(), { description: "Out-of-scope findings, in English." }));
const newTicketsSchema = Type.Optional(
  Type.Array(
    Type.Object({
      title: Type.String({ description: "Ticket title." }),
      body: Type.String({ description: "Ticket body, written so a run could start from it directly." }),
      readyForAgent: Type.Boolean({ description: "Whether a run may pick the ticket up without a human first." }),
    }),
    { description: "Work this closeout found but did not do; the control plane opens one issue per element." },
  ),
);

/**
 * Every Result tool returns this: the durable harness settles the run as done
 * after the round and writes no second annotation. `terminate` is the literal
 * `true` (pi-durable 1.3.0 types it as `true`).
 */
const TERMINATE = { control: { terminate: true as const } };

function recordedText(recorded: boolean, outcome: RunResultV1["outcome"]): string {
  return recorded
    ? `run finished: ${outcome}`
    : `run already self-reported ${outcome}: this call changed nothing`;
}

/**
 * `finish_ticket` — the ticket role's "done" exit. The tool name *is* the
 * outcome (ADR-0007): the agent cannot self-report `error`, and no payload
 * carries a `reason`.
 */
export function finishTicketTool(options: ResultToolsOptions): ToolRegistration {
  return defineTool({
    name: "finish_ticket",
    description:
      "Report that this ticket is done and end the run. summary is one or two sentences; commentBody is posted on the issue (what was done, how it was verified, what was left); warnings holds out-of-scope findings.",
    parameters: Type.Object({
      summary: summarySchema,
      commentBody: Type.Optional(commentBodySchema),
      warnings: warningsSchema,
    }),
    // Sequential so several calls in one round run in call order: the first
    // self-report is the one that sticks.
    executionMode: "sequential",
    execute: async (args, api) => {
      const result: RunResultV1 = {
        v: 1,
        outcome: "done",
        summary: args.summary,
        ...(args.commentBody === undefined ? {} : { commentBody: args.commentBody }),
        ...(args.warnings === undefined ? {} : { warnings: args.warnings }),
      };
      const recorded = await options.record(result, api);
      return { output: [{ type: "text", text: recordedText(recorded, result.outcome) }], ...TERMINATE };
    },
  });
}

/**
 * `finish_spec` — the spec closeout's "done" exit: `prBody` is required because
 * the control plane opens the PR with it verbatim (checklist item 6).
 */
export function finishSpecTool(options: ResultToolsOptions): ToolRegistration {
  return defineTool({
    name: "finish_spec",
    description:
      "Report that the whole spec is done and end the run. prBody is the PR body verbatim (Summary / Evidence / Merge Danger, see the role template); summary is one or two sentences; commentBody is posted on the spec issue; newTickets lists work found but not done; warnings holds out-of-scope findings.",
    parameters: Type.Object({
      summary: summarySchema,
      prBody: Type.String({ description: "The PR body verbatim, in the three sections the role template asks for." }),
      commentBody: Type.Optional(commentBodySchema),
      newTickets: newTicketsSchema,
      warnings: warningsSchema,
    }),
    executionMode: "sequential",
    execute: async (args, api) => {
      const result: RunResultV1 = {
        v: 1,
        outcome: "done",
        summary: args.summary,
        prBody: args.prBody,
        ...(args.commentBody === undefined ? {} : { commentBody: args.commentBody }),
        ...(args.newTickets === undefined ? {} : { newTickets: args.newTickets }),
        ...(args.warnings === undefined ? {} : { warnings: args.warnings }),
      };
      const recorded = await options.record(result, api);
      return { output: [{ type: "text", text: recordedText(recorded, result.outcome) }], ...TERMINATE };
    },
  });
}

/**
 * `blocked` — the only way a run says "a human has to take over" (ADR-0007).
 * Both `summary` and `commentBody` are required: a blocker nobody can act on is
 * not a result.
 */
export function blockedTool(options: ResultToolsOptions): ToolRegistration {
  return defineTool({
    name: "blocked",
    description:
      "Report that this run cannot continue and end it. Only call this when the work item contradicts itself, a decision only a human can make is missing, or the environment is broken beyond what this work item's code can work around; difficulty is not blocked. summary says what stopped the run; commentBody says what a human must change (both required).",
    parameters: Type.Object({
      summary: summarySchema,
      commentBody: commentBodySchema,
    }),
    executionMode: "sequential",
    execute: async (args, api) => {
      const result: RunResultV1 = {
        v: 1,
        outcome: "blocked",
        summary: args.summary,
        commentBody: args.commentBody,
      };
      const recorded = await options.record(result, api);
      return { output: [{ type: "text", text: recordedText(recorded, result.outcome) }], ...TERMINATE };
    },
  });
}

/** The two Result tools a role may call; the outcome is which one it called. */
export function resultToolsForRole(options: ResultToolsOptions): readonly ToolRegistration[] {
  switch (options.role) {
    case "implement-ticket":
      return [finishTicketTool(options), blockedTool(options)];
    case "implement-spec":
      return [finishSpecTool(options), blockedTool(options)];
  }
}

export function resultExtension(tools: readonly ToolRegistration[]): Extension {
  return defineExtension({ name: RESULT_EXTENSION_NAME, tools });
}

/**
 * The default recorder: commit the payload on the conversation's run-result doc.
 * The first call of a run wins, so a model that calls two Result tools in one
 * round still yields exactly one annotation.
 */
export function commitRunResult(result: RunResultV1, api: ToolExecutionApi): Promise<boolean> {
  return api.commit(async (tx) => {
    const doc = await tx.doc(RunResultDoc, api.conversationId);
    if (doc.payload !== "") return false;
    doc.payload = JSON.stringify(result);
    return true;
  }, BACKGROUND_CONTEXT);
}
