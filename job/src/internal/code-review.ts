import { Type } from "@earendil-works/pi-ai";
import { defineTool, type TaskId, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { runGit } from "./git.js";

export const CODE_REVIEW_TOOL_NAME = "code_review";

export interface ReviewRequest {
  /** The literal the implementer passed, already validated to resolve with a non-empty diff. */
  fixedPoint: string;
  /** The `code_review` call's own task: both reviewer conversations are its foreground children. */
  taskId: TaskId;
}

export interface ReviewReports {
  fixedPoint: string;
  spec: string;
  standards: string;
  completedAt: string;
}

/** What the runner hands the tool: conversations and models stay out of this module. */
export interface CodeReviewOptions {
  /** The working copy the reviewer reads and the tool validates the range in. */
  repo: string;
  /** True when this run already took its one round, including across a resume. */
  roundTaken(api: ToolExecutionApi): Promise<boolean>;
  /** Claim the round before any reviewer starts, so a resumed run cannot start another. */
  claimRound(fixedPoint: string, api: ToolExecutionApi): Promise<void>;
  /** Run both axes in independent reviewer conversations. */
  review(request: ReviewRequest): Promise<ReviewReports>;
  /** Store the reports on the claimed round. */
  completeRound(reports: ReviewReports, api: ToolExecutionApi): Promise<void>;
}

/**
 * `code_review` (spec #33 §6): refuses a second round, validates the range
 * before spending reviewer tokens, then runs both axes in independent reviewer
 * conversations. The reviewer's tool table is set where those conversations are
 * created (reviewer.ts), not here — the wall is structural, the prompt is a fuse.
 */
export function codeReviewTool(options: CodeReviewOptions): ToolRegistration {
  return defineTool({
    name: CODE_REVIEW_TOOL_NAME,
    description:
      "Run the two-axis code review over the committed diff: the Standards axis checks the diff against the repo's written standards, the Spec axis checks it against the work item's spec. Pass the fixed point from the prompt verbatim. Exactly one round per run: fix the findings in a new commit, then finish.",
    parameters: Type.Object({
      fixedPoint: Type.String({
        description: "The review fixed point from the prompt, verbatim (a sha). Never HEAD~n, main, or origin/main.",
      }),
    }),
    // Two calls in one round run in call order, so the first round is the one that sticks.
    executionMode: "sequential",
    execute: async (args, api) => {
      if (await options.roundTaken(api)) return bounced("review already ran: fix and finish");

      // Both checks run before the claim: a bad ref or an empty diff costs no
      // reviewer conversation and leaves the round open for a retry.
      const problem = await validateRange(options.repo, args.fixedPoint);
      if (problem !== undefined) return bounced(`code_review did not run: ${problem}`);

      await options.claimRound(args.fixedPoint, api);
      const reports = await options.review({ fixedPoint: args.fixedPoint, taskId: api.taskId });
      await options.completeRound(reports, api);
      return { output: [{ type: "text", text: renderReports(reports) }] };
    },
  });
}

/** An error result the model sees as text: the run continues, nothing was spent. */
function bounced(text: string) {
  return { output: [{ type: "text" as const, text }], isError: true };
}

/**
 * The two checks the checklist requires before any reviewer starts: the ref
 * resolves, and `<ref>...HEAD` is not empty. A bounce costs no reviewer tokens.
 */
async function validateRange(repo: string, fixedPoint: string): Promise<string | undefined> {
  if (fixedPoint.trim() === "") return "the fixed point is empty";
  const local = { cwd: repo, tokenPath: "/dev/null" };
  const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${fixedPoint}^{commit}`], local);
  if (resolved.exitCode !== 0) return `the fixed point ${fixedPoint} does not resolve in this working copy`;

  // Three-dot: exactly the range the reviewer diffs (`git diff <fixed>...HEAD`).
  const diff = await runGit(["diff", "--name-only", `${fixedPoint}...HEAD`], local);
  if (diff.exitCode !== 0) return `git diff ${fixedPoint}...HEAD failed: ${diff.stderr.trim()}`;
  if (diff.stdout.trim() === "") return `the diff ${fixedPoint}...HEAD is empty: commit your work before reviewing`;
  return undefined;
}

function renderReports(reports: ReviewReports): string {
  return [
    "code_review finished: one round. Fix findings inside this change's scope in a new commit, then finish.",
    "",
    "## Spec axis",
    reports.spec.trim() === "" ? "(no report)" : reports.spec.trim(),
    "",
    "## Standards axis",
    reports.standards.trim() === "" ? "(no report)" : reports.standards.trim(),
  ].join("\n");
}
