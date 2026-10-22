import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type Conversation,
  type EntryId,
  type Harness as HarnessHandle,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { renderReviewPrompt, type ReviewAxis } from "./prompt.js";
import { reviewerExtension } from "./reviewer-tools.js";
import { findStandardsFiles } from "./standards-files.js";
import type { ReviewReports } from "./code-review.js";

const context = BACKGROUND_CONTEXT;
const REVIEW_THINKING_LEVEL = "high";

export interface ReviewerDeps {
  harness: HarnessHandle;
  /** The working copy all three cwds live in (spec #33 §5). */
  repo: string;
  promptsDir: string;
  /** `owner/repo#<spec>`: the Spec axis' comparison surface. */
  specRef: string;
  /** The spec body; empty when the work item carries none. */
  specBody: string;
  /** The reviewer runs on its own model (docs/deployment.md §9). */
  model: { provider: string; modelId: string };
  /** The `code_review` call that owns both reviewer conversations. */
  parentTaskId: TaskId;
  /** Injected in tests; production scans the working copy. */
  standardsFiles?(): Promise<string[]>;
  log(line: string): void;
}

/**
 * One review round: two independent reviewer conversations, one per axis, each
 * reading its own template (spec #33 §6). Neither sees the other's report, and
 * neither can reach a review tool: `reviewerExtension()` is the conversation's
 * whole tool table.
 */
export async function runReview(deps: ReviewerDeps, fixedPoint: string): Promise<ReviewReports> {
  const spec = await runAxis(deps, "spec", fixedPoint);
  const standards = await runAxis(deps, "standards", fixedPoint);
  return { fixedPoint, spec, standards, completedAt: new Date().toISOString() };
}

async function runAxis(deps: ReviewerDeps, axis: ReviewAxis, fixedPoint: string): Promise<string> {
  const prompt = await axisPrompt(deps, axis, fixedPoint);
  const conversation = await deps.harness.createConversation(
    {
      // Foreground: the `code_review` call holds the round, so its own task owns
      // both reviewer conversations (spec #33 §6).
      ownership: { kind: "task", taskId: deps.parentTaskId },
      agent: {
        model: deps.model,
        thinkingLevel: REVIEW_THINKING_LEVEL,
        // Exactly one extension: the reviewer's three tools. No result tools, no
        // coding tools (write/edit), and no `code_review` itself.
        extensions: [reviewerExtension()],
        cwd: deps.repo,
      },
    },
    context,
  );
  deps.log(`reviewer-open axis=${axis} conversation=${conversation.id}`);

  // The axis template is the conversation's first message, the same way the
  // implementer's prompt is: every injected value (fixed point, spec ref and body,
  // standards list) arrives with it and no file has to be found (spec #33 §7).
  const submission = await conversation.submit({ type: "input", content: prompt }, context);
  const settled = await submission.wait(context);
  if (settled.status !== "done" || settled.type !== "input") {
    throw new Error(`reviewer ${axis} ended without an answer: status=${settled.status}`);
  }
  const report = await answerText(conversation, settled.answer);
  deps.log(`reviewer-done axis=${axis} conversation=${conversation.id}`);
  return report;
}

/** The axis template, rendered with the values the tool injects and nothing else. */
async function axisPrompt(deps: ReviewerDeps, axis: ReviewAxis, fixedPoint: string): Promise<string> {
  const rendered = await renderReviewPrompt({
    axis,
    fixedPoint,
    specRef: deps.specRef,
    specBody: deps.specBody,
    promptsDir: deps.promptsDir,
  });
  if (axis !== "standards") return rendered;
  // The standards list is not a template value: the runner scans the working copy
  // at review time (A17a), so the list is appended to the rendered prompt.
  const files = await (deps.standardsFiles?.() ?? findStandardsFiles(deps.repo));
  return `${rendered.trimEnd()}\n\n## Standards files found in this working copy\n\n${renderStandardsList(files)}`;
}

/** The real list, or an explicit empty table — never a placeholder the reviewer must resolve. */
export function renderStandardsList(files: readonly string[]): string {
  if (files.length === 0) return "none (this repository has no written standards files; use the smell baseline only)";
  return files.map((file) => `- \`${file}\``).join("\n");
}

async function answerText(conversation: Conversation, answer: EntryId): Promise<string> {
  const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, answer), context);
  const message = entry?.model?.[0];
  if (message === undefined || message.role !== "assistant") {
    throw new Error(`reviewer ${conversation.id} answered without an assistant message`);
  }
  return textOf(message);
}

function textOf(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}
