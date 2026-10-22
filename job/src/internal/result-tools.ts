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
   */
  record(result: RunResultV1, api: ToolExecutionApi): Promise<void>;
}

const warningsSchema = Type.Optional(Type.Array(Type.String(), { description: "Out-of-scope findings, in English." }));

/**
 * `finish_ticket` — the ticket role's only exit in v1. The tool name *is* the
 * outcome (ADR-0007): the agent cannot self-report `error`, and one call ends the
 * run through `control: { terminate: true }`.
 */
export function finishTicketTool(options: ResultToolsOptions): ToolRegistration {
  return defineTool({
    name: "finish_ticket",
    description:
      "Report that this ticket is done and end the run. summary is one or two sentences; commentBody is posted on the issue (what was done, how it was verified, what was left); warnings holds out-of-scope findings.",
    parameters: Type.Object({
      summary: Type.String({ description: "One or two sentences on what was delivered." }),
      commentBody: Type.Optional(Type.String({ description: "The comment posted back to the issue." })),
      warnings: warningsSchema,
    }),
    execute: async (args, api) => {
      const result: RunResultV1 = {
        v: 1,
        outcome: "done",
        summary: args.summary,
        ...(args.commentBody === undefined ? {} : { commentBody: args.commentBody }),
        ...(args.warnings === undefined ? {} : { warnings: args.warnings }),
      };
      await options.record(result, api);
      return { output: [{ type: "text", text: "run finished: done" }], control: { terminate: true } };
    },
  });
}

/**
 * The Result tools a role may call. #40 adds `finish_spec`, `blocked` and
 * `code_review`; they register here and the runner needs no restructuring.
 */
export function resultToolsForRole(options: ResultToolsOptions): readonly ToolRegistration[] {
  switch (options.role) {
    case "implement-ticket":
      return [finishTicketTool(options)];
    case "implement-spec":
      return [];
  }
}

export function resultExtension(tools: readonly ToolRegistration[]): Extension {
  return defineExtension({ name: RESULT_EXTENSION_NAME, tools });
}

/** The default recorder: commit the payload on the conversation's run-result doc. */
export function commitRunResult(result: RunResultV1, api: ToolExecutionApi): Promise<void> {
  return api.commit(async (tx) => {
    const doc = await tx.doc(RunResultDoc, api.conversationId);
    doc.payload = JSON.stringify(result);
  }, BACKGROUND_CONTEXT);
}
