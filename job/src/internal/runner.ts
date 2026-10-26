import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  type Conversation,
  type AgentChange,
  type Cursor,
  type Harness as HarnessHandle,
  type Storage,
  type Submission,
  type SubmissionRecord,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Models } from "@earendil-works/pi-ai";
import { RUNNER_EXIT, isRunResultV1, specBranch, type RunResultV1, type WorkItemV1 } from "@remote-agent/shared";
import type { JobPaths, RunnerEnv } from "./env.js";
import { renderPrompt } from "./prompt.js";
import { readPreviousRound, resetForNewRound, roundHeader, type PreviousRound, type RoundContext } from "./round.js";
import { ReviewFixedPointDoc, type ReviewFixedPoint } from "./fixed-point-doc.js";
import {
  ConflictHandoffDoc,
  EMPTY_CONFLICT_HANDOFF,
  ReviewRoundDoc,
  RunCompletedDoc,
  RunResultDoc,
  type ConflictHandoffState,
} from "./run-docs.js";
import { resultExtension, resultToolsForRole, commitRunResult } from "./result-tools.js";
import { codeReviewTool, type ReviewReports } from "./code-review.js";
import { runReview } from "./reviewer.js";
import { reviewerExtension } from "./reviewer-tools.js";
import { mergeBase, revParseHead, runGit, type GitOptions } from "./git.js";

const context = BACKGROUND_CONTEXT;
const THINKING_LEVEL = "high";
/** The bot identity every commit this system makes carries (ADR-0009). */
const COMMIT_IDENTITY = { name: "remote-agent[bot]" } as const;
/** Page size for storage scans; the same 256 pi-durable uses for its own. */
const SCAN_PAGE_SIZE = 256;

/**
 * Generation retries, sized to outlast a gateway restart rather than a blip.
 *
 * pi-durable's default is 3 retries with a 2 s base delay — 2+4+8 = 14 s of
 * backoff total. On 2026-10-24 and again 10-25 the one dependency every run needs
 * (`omniroute`) was restarted by its own liveness probe and stayed down ~50 s;
 * every retry landed inside the outage, the run settled `unanswered/model_error`,
 * and ~20 minutes of agent work was thrown away on two tickets. Both error texts
 * (`terminated`, `connection error`) are on pi-ai's retryable allowlist, so the
 * classification was right — the budget was simply too small.
 *
 * 6 retries with a 5 s base delay gives 5+10+20+40+60+60 = 195 s, and
 * `maxAgentDelayMs` caps a single wait at 60 s so a long outage does not turn
 * into a silent 20-minute stall. A restart of the gateway now costs one attempt's
 * latency instead of the run.
 */
export const GENERATION_RETRY_POLICY = {
  maxRetries: 6,
  baseDelayMs: 5_000,
  maxAgentDelayMs: 60_000,
} as const;

/** Everything the run touches that a test wants to replace. */
export interface RunDeps {
  env: RunnerEnv;
  paths: JobPaths;
  models: Models;
  /** durable storage on the Ticket PVC; a fresh handle per open. */
  openStorage(path: string): Promise<Storage>;
  /**
   * Writes the run result on the Job annotation. Called exactly once, after the
   * delivery step: a successful push, or a `blocked` report on a conflict the
   * agent could not resolve (#58).
   */
  annotate(result: RunResultV1): Promise<void>;
  /**
   * Whether **this run's own Job** object carries a `remote-agent/run-result`
   * annotation. Throws when the object cannot be read.
   *
   * Consulted only on the already-complete branch (ADR-0016), where it is the one
   * thing that tells a replacement pod of the Job that finished the run apart from
   * a new Job created on a spent volume.
   */
  hasOwnRunResult(): Promise<boolean>;
  /** Pushes `HEAD` to `agent/spec-<n>`; throws on a failure no later pod can fix, and
   * reports a stopped rebase as `conflict` instead of failing (#58). */
  push(): Promise<PushOutcome>;
  log(line: string): void;
  now?(): Date;
  /** Simulates a process death right after the run is admitted (before any model request). */
  crashAfterSubmit?(): void;
  /** Injected in tests: the standards files the runner scans for the Standards axis. */
  standardsFiles?(): Promise<string[]>;
}

export interface RunOutcome {
  exitCode: number;
  /** Present when this process ended through a Result tool. */
  result?: RunResultV1;
  /** True when this process resumed an unfinished run instead of starting a new one. */
  resumed: boolean;
  /**
   * True when the volume already carried a finished run. Nothing is done in either
   * case, but *why* differs and the exit code carries it: 0 for a replacement pod of
   * the Job that finished the run, `RUNNER_EXIT.fatal` for a new Job on a spent
   * volume (ADR-0016).
   */
  alreadyComplete: boolean;
}

/**
 * One runner pass over the Ticket PVC (spec #33 §6):
 *
 * 1. open durable storage; a finished run does nothing at all;
 * 2. resume an unfinished run, else commit the review fixed point and submit one;
 * 3. run the agent to a Result tool;
 * 4. push, and only then write the annotation.
 *
 * The App never says "rerun or reopen": the volume answers it.
 */
export async function run(deps: RunDeps): Promise<RunOutcome> {
  await mkdir(deps.paths.state, { recursive: true });
  await mkdir(deps.paths.home, { recursive: true });

  const storage = await deps.openStorage(deps.paths.sessionDatabase);
  // The `code_review` tool is registered before the harness exists (the registry
  // is a Harness input), so it reaches the harness through this holder.
  const handle: HarnessHandle[] = [];
  const harness = await openHarness(deps, storage, handle);
  handle.push(harness);

  // SIGTERM (k8s eviction, activeDeadlineSeconds, node drain) is NOT a terminal
  // state: the run must close the harness so sqlite is left consistent, exit
  // non-zero, and write NO annotation — the next pod resumes from the last
  // checkpoint (ADR-0007 / ADR-0008). Without this handler `harness.close()` only
  // ran on the normal return path, so a signal abandoned the storage mid-flight.
  const onSignal = async (signal: NodeJS.Signals): Promise<void> => {
    deps.log(`runner-signal signal=${signal} closing=true annotation=false`);
    try {
      await harness.close(context);
    } finally {
      process.exit(1);
    }
  };
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => void onSignal(signal);
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    const root = await harness.root(context, { agent: implementerAgent(deps) });
    // Which round this Job is (ADR-0017). The same count the retry key uses, read
    // once and used by both the boundary log and the prompt header; the reset below
    // touches no submission, so a round that crashes keeps its number.
    const roundNumber = await roundNumberFor(deps, storage, root);
    let previous: PreviousRound | null = null;
    if (await isComplete(harness, root)) {
      // The volume's conversation already reported. Which Job is asking, though?
      //
      // A **replacement pod of the Job that finished it** finds its own run result
      // already on that Job and has nothing left to do. A **new Job on a reported
      // volume** carries no annotation, and that shape has two different answers,
      // by role (ADR-0017):
      //
      // - **closeout**: the volume is spent for good — the App reclaims it at the
      //   start of every round (ADR-0016), so finding one here means the reclaim did
      //   not happen, which must stay loud. Refuse (exit 78 → `podFailurePolicy`
      //   `FailJob` → the App judges `unrecoverable`, whose evidence comment already
      //   tells the human to discard the volume).
      // - **ticket**: this is the normal path. The human reopened a `done` ticket or
      //   re-entered a `blocked` one, and a ticket's volume is meant to be reused
      //   (ADR-0011): reset the round's documents and run the next round on this same
      //   conversation, with the previous round's history in front of the model.
      //
      // Presence is the whole test: a Job object is created fresh per round, so an
      // annotation can only ever be this Job's own.
      let reported: boolean;
      try {
        reported = await deps.hasOwnRunResult();
      } catch (error) {
        // "Cannot tell which Job this is." Failing the run would FailJob a Job whose
        // result may already have landed, so keep the old behaviour instead — and
        // reset nothing: starting a round nobody asked for is the other half of the
        // same mistake.
        deps.log(
          `runner-open conversation=${ROOT_CONVERSATION_ID} already-complete=true own-result-unreadable=true detail=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { exitCode: 0, resumed: false, alreadyComplete: true };
      }
      if (!reported && deps.env.role !== "implement-ticket") {
        deps.log(`runner-refused reason=spent-volume role=${deps.env.role} job=${deps.env.jobName}`);
        return { exitCode: RUNNER_EXIT.fatal, resumed: false, alreadyComplete: true };
      }
      if (!reported) {
        // A new round on this conversation. Everything the round must *say* about the
        // one before it is read first: the reset below clears it (ADR-0017).
        previous = await readPreviousRound(harness, root);
        await resetForNewRound(harness, root);
        deps.log(
          `runner-round-start round=${roundNumber} previous-outcome=${previous.outcome ?? "unknown"} previous-completed-at=${
            previous.completedAt
          }`,
        );
      } else {
        deps.log(`runner-open conversation=${ROOT_CONVERSATION_ID} already-complete=true`);
        return { exitCode: 0, resumed: false, alreadyComplete: true };
      }
    }
    const round: RoundContext = { round: roundNumber, previous };

    // Outcome already decided but not delivered (the previous pod died before the push
    // landed): go straight to push + annotate, never back through the agent. A claimed
    // conflict hand-off is the one case that still has an unfinished submission behind
    // an already-committed result: the turn that resolves the stopped rebase (#58).
    const handoff = await readConflictHandoff(harness, root);
    const decided = await readCommittedResult(deps, harness, root);
    const mayHoldConflictTurn = handoff.attemptedAt !== "" && !handoff.reported;
    const pending = decided === undefined || mayHoldConflictTurn ? await resumeUnfinished(deps, harness) : undefined;
    const resumed = decided !== undefined || pending !== undefined;
    let submission = pending;
    if (decided === undefined && submission === undefined) {
      const fixedPoint = await readOrComputeFixedPoint(deps, harness, root);
      submission = await submitRun(deps, storage, root, fixedPoint, round);
      deps.crashAfterSubmit?.();
    }
    deps.log(`runner-open conversation=${ROOT_CONVERSATION_ID} resumed=${resumed}`);
    const result = submission === undefined ? decided! : await waitForResult(deps, harness, root, submission);
    // Push strictly precedes the annotation: a push failure leaves no result behind,
    // so k8s starts a new pod that resumes to this same point and pushes again.
    const delivered = await pushAndResolveConflict(deps, storage, harness, root, result);
    await deps.annotate(delivered);
    await markComplete(harness, root);
    return { exitCode: 0, result: delivered, resumed, alreadyComplete: false };
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    await harness.close(context);
  }
}

function modelRefFor(deps: RunDeps): { provider: string; modelId: string } {
  return { provider: "omniroute", modelId: deps.env.omniRoute.model };
}

function runRequestId(deps: RunDeps): string {
  return `remote-agent:${deps.env.repo}#${deps.env.workItem.number}:${deps.env.role}`;
}

async function openHarness(
  deps: RunDeps,
  storage: Storage,
  handle: HarnessHandle[],
): Promise<HarnessHandle> {
  if (deps.env.thinkingLevel !== THINKING_LEVEL) {
    // The Job template pins `high` (docs/deployment.md §9); a different value is an
    // App-side wiring bug and the runner does not silently substitute one.
    throw new Error(`AGENT_THINKING_LEVEL=${deps.env.thinkingLevel} is not the pinned level ${THINKING_LEVEL}`);
  }
  return Harness.open(
    storage,
    {
      models: deps.models,
      registry: buildRegistry(deps, handle),
      // Retries are a run-policy decision, not a per-request one (see
      // GENERATION_RETRY_POLICY): the default budget cannot outlast the gateway
      // restart that made this run necessary in the first place.
      settings: { retry: GENERATION_RETRY_POLICY },
      // What the agent's own git needs to finish a handed-over rebase (#58):
      //
      // - `GIT_EDITOR=true` accepts the commit message git already has, so
      //   `git rebase --continue` cannot stop on an editor nobody can answer;
      // - the committer identity, because `--continue` *creates* a commit and the
      //   runner's shell has no `~/.gitconfig` (`HOME` is the volume's `home/`). The
      //   runner's own git calls pass `-c` identity flags; the agent's shell cannot,
      //   so it gets the same bot identity through the environment. Without it the
      //   rebase stays stopped and the run ends fatal on a resolution that worked.
      env: () =>
        new NodeExecutionEnv({
          cwd: deps.paths.repo,
          shellEnv: {
            GIT_EDITOR: "true",
            GIT_COMMITTER_NAME: COMMIT_IDENTITY.name,
            GIT_COMMITTER_EMAIL: deps.env.commitEmail,
          },
        }),
      now: () => (deps.now?.() ?? new Date()).getTime(),
      onReport: (error) => deps.log(`runner-report error=${String(error)}`),
    },
    context,
  );
}

/**
 * Every extension one run installs: the coding tools, the reviewer's three tools
 * (selectable by a reviewer conversation, removed from the implementer's agent),
 * and the Result tools plus `code_review` for the role. Exported so a test can
 * resolve a conversation's tool table against the same registry the run used.
 */
export function buildRegistry(
  deps: Pick<RunDeps, "env" | "paths" | "log" | "standardsFiles">,
  handle: HarnessHandle[],
): ReturnType<typeof createRegistry> {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(reviewerExtension());
  registry.install(
    resultExtension([
      ...resultToolsForRole({ role: deps.env.role, record: commitRunResult }),
      codeReviewTool({
        repo: deps.paths.repo,
        roundTaken: (api) => roundTaken(api),
        claimRound: (fixedPoint, api) => claimRound(fixedPoint, api),
        review: (request) =>
          runReview(
            {
              harness: handle[0]!,
              repo: deps.paths.repo,
              promptsDir: deps.paths.prompts,
              specRef: `${deps.env.repo}#${deps.env.specNumber}`,
              specBody: specBodyFor(deps.env.role, deps.env.workItem),
              model: { provider: "omniroute", modelId: deps.env.omniRoute.reviewModel },
              parentTaskId: request.taskId,
              ...(deps.standardsFiles === undefined ? {} : { standardsFiles: deps.standardsFiles }),
              log: deps.log,
            },
            request.fixedPoint,
          ),
        completeRound: (reports, api) => completeRound(reports, api),
      }),
    ]),
  );
  return registry;
}

/**
 * The implementer's agent: its model, the pinned thinking level, and the coding
 * tools — with the reviewer extension removed, so `code_review`'s tool table is
 * never also the implementer's.
 */
function implementerAgent(deps: RunDeps): AgentChange {
  return {
    model: modelRefFor(deps),
    thinkingLevel: THINKING_LEVEL,
    extensions: { remove: [reviewerExtension()] },
  };
}

/** The one review round is durable: a resumed run finds it taken and refuses a second. */
async function roundTaken(api: ToolExecutionApi): Promise<boolean> {
  const round = await api.snapshot(ReviewRoundDoc, api.conversationId, BACKGROUND_CONTEXT);
  return (round?.fixedPoint ?? "") !== "";
}

/** Claim before the first reviewer starts, so a crash mid-round cannot start a second. */
async function claimRound(fixedPoint: string, api: ToolExecutionApi): Promise<void> {
  await api.commit(async (tx) => {
    const round = await tx.doc(ReviewRoundDoc, api.conversationId);
    round.fixedPoint = fixedPoint;
  }, BACKGROUND_CONTEXT);
}

async function completeRound(reports: ReviewReports, api: ToolExecutionApi): Promise<void> {
  await api.commit(async (tx) => {
    const round = await tx.doc(ReviewRoundDoc, api.conversationId);
    round.spec = reports.spec;
    round.standards = reports.standards;
    round.completedAt = reports.completedAt;
  }, BACKGROUND_CONTEXT);
}

/**
 * The Spec axis' comparison surface: the parent spec's body when the App could
 * read it, else the work item's own body for the spec role (which *is* the spec
 * body). A ticket run without a `specBody` gets an empty string, and the
 * template then reports "no spec available" rather than comparing against the
 * ticket body, which the implementer already read.
 */
export function specBodyFor(role: RunnerEnv["role"], workItem: WorkItemV1): string {
  if (workItem.specBody !== undefined) return workItem.specBody;
  return role === "implement-spec" ? workItem.body : "";
}

/**
 * `inspect()` answers what the last process left behind. An unfinished run means
 * `harness.resume()` and a wait on the same submission — never a second submit
 * (spec #33 §6.2). A clean finish leaves nothing pending, so this returns undefined.
 */
async function resumeUnfinished(deps: RunDeps, harness: HarnessHandle): Promise<Submission | undefined> {
  const inspection = await harness.inspect(context);
  if (inspection.tasks.length === 0 && inspection.submissions.length === 0) return undefined;
  harness.resume();
  deps.log(`runner-resume tasks=${inspection.tasks.length} submissions=${inspection.submissions.length}`);
  const pending = inspection.submissions[0];
  return pending ? await harness.submission(pending.id, context) : undefined;
}

async function submitRun(
  deps: RunDeps,
  storage: Storage,
  root: Conversation,
  fixedPoint: ReviewFixedPoint,
  round: RoundContext,
): Promise<Submission> {
  const rendered = await renderPrompt({
    role: deps.env.role,
    workItem: deps.env.workItem,
    fixedPoint: fixedPoint.fixedPoint,
    promptsDir: deps.paths.prompts,
  });
  // The header goes in front of the rendered prompt, not into the templates: the
  // facts it states (which round, how the last one ended) live on the volume, and
  // the ConfigMap's key and placeholder surface stays untouched (ADR-0004/0017).
  const header = roundHeader(round);
  const prompt = header === "" ? rendered : `${header}\n\n${rendered}`;
  // Deduplication key: a process that reaches this line again after a crash finds
  // the same submission instead of starting a second run (ADR-0008).
  return submitInput(deps, storage, root, prompt, "");
}

/** One conversation turn, admitted under this run's dedup key for its family. */
async function submitInput(
  deps: RunDeps,
  storage: Storage,
  root: Conversation,
  content: string,
  suffix: string,
): Promise<Submission> {
  return root.submit(
    { type: "input", content, requestId: await submissionKeyFor(deps, storage, root, suffix) },
    context,
  );
}

/**
 * The push, and the one turn a stopped rebase buys (#58).
 *
 * `deps.push()` reconciles our commits onto the branch tip. When that rebase stops
 * on a conflict, the runner cannot choose a winner — but the agent that wrote one
 * side can, and it still holds the conversation and the suite. So the stopped
 * rebase is handed over as one more turn in the same conversation; when it
 * reports, the run is pushed and annotated with *its* result.
 *
 * What this process does next is read from the volume on every pass, never from
 * its own earlier turn:
 *
 * - no hand-off yet → push; a conflict claims the hand-off (durable, **before** the
 *   turn is submitted) and loops;
 * - claimed, not reported → the turn still owns the worktree: resume it (a crash),
 *   or submit it under the next numbered key when the earlier one settled
 *   unanswered (a model error — the #52 shape), then verify it finished the rebase;
 * - claimed, reported → push. A conflict here is `FatalPushError`: one *reported*
 *   attempt is the whole budget, so either the branch moved again or the
 *   resolution did not hold. Unreported attempts are pod retries, bounded by the
 *   Job's own backoff and deadline like every other retry.
 *
 * A `blocked` report ends the run without a push: the rebase is still stopped, so
 * pushing could only conflict again — and an `error` would replace the agent's
 * verdict with a human's guess (ADR-0009).
 */
async function pushAndResolveConflict(
  deps: RunDeps,
  storage: Storage,
  harness: HarnessHandle,
  root: Conversation,
  first: RunResultV1,
): Promise<RunResultV1> {
  let result = first;
  for (;;) {
    const handoff = await readConflictHandoff(harness, root);
    if (handoff.attemptedAt !== "") {
      if (!handoff.reported) {
        // The turn owns the worktree until it reports. Pushing first would push the
        // commit the rebase started from — nothing — and annotate a run whose work
        // never left the volume.
        const pending = await resumeUnfinished(deps, harness);
        const submission = pending ?? (await submitConflictHandoff(deps, storage, root, handoff.files));
        result = await waitForResult(deps, harness, root, submission);
        if (result.outcome === "blocked") return result;
      }
      // Whatever the report said, git decides: a rebase still stopped here, or a
      // report with nothing left to push, is a condition of the volume and goes
      // fatal — the budget was the turn that just ran.
      await assertHandoffFinishedTheRebase(deps, handoff.files);
    }

    const outcome = await deps.push();
    if (outcome.kind === "pushed") return result;
    // Read again: the turn that just ran is what reported, so this is the branch
    // rejecting a resolution it already made — the one reported attempt is spent.
    const after = await readConflictHandoff(harness, root);
    if (after.reported) {
      const paths = (outcome.files.length > 0 ? outcome.files : after.files).join(", ");
      throw new FatalPushError(
        `git rebase onto origin/${deps.env.branch} still conflicts after the one resolution turn (${paths}): ` +
          "the branch moved again, or the resolution did not hold",
      );
    }
    await claimConflictHandoff(deps, harness, root, outcome.files);
  }
}

/**
 * What the hand-off's report is worth: the rebase must be finished, and the run's
 * commits must still be on top of the branch tip.
 *
 * Without both checks a turn that reported without `git rebase --continue`, or
 * that reset the worktree to the tip, would be annotated `done` while its work
 * stayed on the volume: the push would succeed as "Everything up-to-date".
 */
async function assertHandoffFinishedTheRebase(deps: RunDeps, files: readonly string[]): Promise<void> {
  const branch = specBranch(deps.env.specNumber);
  const options = { cwd: deps.paths.repo, tokenPath: deps.paths.token };
  if (await rebaseInProgress(deps.paths.repo, options)) {
    throw new FatalPushError(
      `the conflict hand-off reported without finishing the rebase onto origin/${branch} (${files.join(", ")}): ` +
        "it is still stopped on a conflict",
    );
  }
  const ahead = await runGit(["rev-list", "--count", `refs/remotes/origin/${branch}..HEAD`], options);
  if (ahead.exitCode !== 0) {
    throw new Error(
      `git rev-list --count refs/remotes/origin/${branch}..HEAD failed (${ahead.exitCode}): ${ahead.stderr.trim()}`,
    );
  }
  if (Number(ahead.stdout.trim()) === 0) {
    throw new FatalPushError(
      `the conflict hand-off reported but left nothing to push onto origin/${branch}: ` +
        "the run's commits are no longer on top of it",
    );
  }
  deps.log(`push-conflict-resolved ahead=${ahead.stdout.trim()}`);
}

/**
 * The conflict hand-off's message: which rebase is stopped, on which paths, and the
 * commands that finish it. The rules — keep both intents, never abort or skip,
 * re-report, still never push — live in `_common`, which every role reads
 * (ADR-0004: no prompt text in the image).
 */
function conflictHandoffPrompt(input: { branch: string; files: readonly string[] }): string {
  return [
    `The push of this run to \`${input.branch}\` stopped on a rebase conflict, and the control plane has handed you the stopped rebase.`,
    "",
    `It is still in progress against \`origin/${input.branch}\`, and git left these paths unmerged:`,
    ...input.files.map((file) => `  - ${file}`),
    "",
    `Resolve them the way your instructions describe for a handed-over conflict. The commits already on the branch are other tickets of this spec, and \`git log origin/${input.branch}\` says what they were after. Then:`,
    "  1. `git add` each path you resolved.",
    "  2. `git rebase --continue`, and repeat if it stops on another commit.",
    "  3. Run the full test suite and the typecheck once against the merged result.",
    "  4. Call the same Result tool again with the final summary, commentBody and warnings. That report replaces the one this run made before the conflict, and the control plane pushes after it.",
    "",
  ].join("\n");
}

async function submitConflictHandoff(
  deps: RunDeps,
  storage: Storage,
  root: Conversation,
  files: readonly string[],
): Promise<Submission> {
  return submitInput(deps, storage, root, conflictHandoffPrompt({ branch: deps.env.branch, files }), CONFLICT_KEY_SUFFIX);
}

/**
 * Suffix that keeps the conflict hand-off's dedup keys off the run's own (#58): a
 * run holds two submission families, and each numbers its retries from its own base.
 */
const CONFLICT_KEY_SUFFIX = "#conflict";

/** The conflict hand-off's durable state; `initial` when this volume never had one. */
async function readConflictHandoff(harness: HarnessHandle, root: Conversation): Promise<ConflictHandoffState> {
  const state = await harness.snapshot(ConflictHandoffDoc, root.id, context);
  return state ?? EMPTY_CONFLICT_HANDOFF;
}

/**
 * Spend the one attempt, **before** the turn is submitted: a pod that dies between
 * the claim and the submit resumes the same turn, and a pod that finds a claimed
 * hand-off never starts a second one.
 */
async function claimConflictHandoff(
  deps: RunDeps,
  harness: HarnessHandle,
  root: Conversation,
  files: readonly string[],
): Promise<void> {
  let claimed = false;
  await root.commit(async (tx) => {
    const doc = await tx.doc(ConflictHandoffDoc, root.id);
    if (doc.attemptedAt !== "") return;
    doc.attemptedAt = (deps.now?.() ?? new Date()).toISOString();
    doc.files = [...files];
    claimed = true;
  }, context);
  if (claimed) deps.log(`push-conflict-handoff files=${files.join(",")}`);
}

/** A submission that can no longer change: the run it admitted has ended. */
function isSettled(submission: SubmissionRecord): boolean {
  return submission.status === "done" || submission.status === "unanswered";
}

/**
 * Which round this Job is (ADR-0017): round 1 is a fresh conversation, and every
 * reported round adds one.
 *
 * The count comes from the same scan that numbers the retry key — this
 * conversation's settled **input** submissions under the run's base key and its
 * numbered retries. The conflict turn's family (`…:implement-ticket#conflict`) is
 * deliberately outside it, or the two families would consume each other's numbers
 * (#58). The reset at a round boundary touches no submission, so the number a
 * crashed new round reads on its next pod is the same one.
 */
async function roundNumberFor(deps: RunDeps, storage: Storage, root: Conversation): Promise<number> {
  const settled = await settledInputSubmissions(storage, root, runRequestId(deps));
  return settled.length + 1;
}

/**
 * The Submission key for this attempt: the ticket's base key, or a numbered
 * retry of it once an earlier run of this ticket has already settled.
 *
 * `admitSubmission()` returns any existing submission for a key regardless of its
 * status, and `resumeUnfinished()` only sees `queued`/`placed` ones — so a run
 * that died of a model error left a settled submission that a later pod could
 * neither resume nor replace. Dedup handed that dead record back and
 * `waitForResult()` read its terminal outcome immediately: `run-failed` in 1–2 ms,
 * on every pod, for the life of the volume (#52).
 *
 * The base key stays in place for the crash-resume it was built for: a process
 * that dies before its run settles finds the same `queued`/`placed` submission
 * and resumes it, never starting a second. Only a *settled* attempt moves the key
 * on, so a transient provider error costs one attempt instead of the ticket.
 *
 * The number counts this conversation's settled input submissions rather than
 * naming one dead id: a retry can fail too, and keying off "the base key's
 * record" would then compute the same replacement twice and land back on a
 * settled submission. Counting stays deterministic, and the volume is
 * `ReadWriteOncePod` with `parallelism: 1` (ADR-0008), so exactly one process
 * reads it and the count cannot race.
 */
async function submissionKeyFor(
  deps: RunDeps,
  storage: Storage,
  root: Conversation,
  suffix = "",
): Promise<string> {
  const base = `${runRequestId(deps)}${suffix}`;
  const settled = await settledInputSubmissions(storage, root, base);
  if (settled.length === 0) return base;

  const attempt = settled.length + 1;
  const latest = settled.at(-1)!;
  const next = `${base}#retry-${settled.length}`;
  deps.log(
    `runner-retry attempt=${attempt} previous-submission=${latest.id} status=${latest.status} reason=${latest.reason ?? "none"}`,
  );
  return next;
}

/**
 * This conversation's settled **input** submissions for one base key, oldest first.
 *
 * Scoped to the base (and its numbered retries) because a run can hold two
 * families: its own `…:implement-ticket` and the conflict turn's
 * `…:implement-ticket#conflict` (#58). Counting across both would make each family
 * skip numbers the other used.
 *
 * Input-only on purpose: pi-durable admits compaction summaries as `type:
 * "write"` on the same conversation and settles them `done`, so counting every
 * settled record would inflate the attempt number and point the retry log at a
 * compaction rather than at the failed run it is retrying.
 */
async function settledInputSubmissions(
  storage: Storage,
  root: Conversation,
  base: string,
): Promise<readonly SubmissionRecord[]> {
  const settled: SubmissionRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanSubmissions({ conversationId: root.id, order: "ascending" }, SCAN_PAGE_SIZE, cursor, context);
    for (const submission of page.items) {
      if (submission.type !== "input" || !isSettled(submission)) continue;
      if (submission.requestId === base || submission.requestId?.startsWith(`${base}#retry-`)) settled.push(submission);
    }
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  return settled;
}

/** The payload a Result tool already committed in an earlier pod, if any. */
async function readCommittedResult(
  deps: RunDeps,
  harness: HarnessHandle,
  root: Conversation,
): Promise<RunResultV1 | undefined> {
  const payload = await harness.snapshot(RunResultDoc, root.id, context);
  if (!payload || payload.payload === "") return undefined;
  const parsed: unknown = JSON.parse(payload.payload);
  if (!isRunResultV1(parsed)) throw new Error("committed run result does not match run result v1");
  deps.log(`run-result outcome=${parsed.outcome} already-decided=true`);
  return parsed;
}

/** The Result tool committed its payload; wait until the run settles, then read it back. */
async function waitForResult(
  deps: RunDeps,
  harness: HarnessHandle,
  root: Conversation,
  submission: Submission,
): Promise<RunResultV1> {
  const settled = await submission.wait(context);
  if (settled.status !== "done") {
    throw new Error(`run ended without a Result tool: reason=${settled.reason}`);
  }
  const payload = await harness.snapshot(RunResultDoc, root.id, context);
  const parsed: unknown = payload?.payload ? JSON.parse(payload.payload) : undefined;
  if (!isRunResultV1(parsed)) {
    throw new Error("run settled without a committed run result");
  }
  deps.log(`run-result outcome=${parsed.outcome}`);
  return parsed;
}

async function isComplete(harness: HarnessHandle, root: Conversation): Promise<boolean> {
  const completed = await harness.snapshot(RunCompletedDoc, root.id, context);
  return (completed?.completedAt ?? "") !== "";
}

async function markComplete(harness: HarnessHandle, root: Conversation): Promise<void> {
  const completedAt = new Date().toISOString();
  await root.commit(async (tx) => {
    const doc = await tx.doc(RunCompletedDoc, root.id);
    doc.completedAt = completedAt;
  }, context);
}

/**
 * Read the committed fixed point; compute and commit it only when absent, so a
 * resumed run sees exactly the value the first process wrote (ADR-0009).
 */
async function readOrComputeFixedPoint(
  deps: RunDeps,
  harness: HarnessHandle,
  root: Conversation,
): Promise<ReviewFixedPoint> {
  const committed = await harness.snapshot(ReviewFixedPointDoc, root.id, context);
  if (committed && committed.fixedPoint !== "") return committed;

  const source = deps.env.role === "implement-spec" ? "merge-base" : "run-start";
  const fixedPoint: ReviewFixedPoint = {
    fixedPoint: await computeFixedPoint(deps, source),
    source,
    branch: deps.env.branch,
    computedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await root.commit(async (tx) => {
    const doc = await tx.doc(ReviewFixedPointDoc, root.id);
    doc.fixedPoint = fixedPoint.fixedPoint;
    doc.source = fixedPoint.source;
    doc.branch = fixedPoint.branch;
    doc.computedAt = fixedPoint.computedAt;
  }, context);
  deps.log(`fixed-point sha=${fixedPoint.fixedPoint} source=${fixedPoint.source}`);
  return fixedPoint;
}

/** Ticket role: this run's start `HEAD`. Spec role: the branch start, `git merge-base origin/main HEAD`. */
async function computeFixedPoint(deps: RunDeps, source: ReviewFixedPoint["source"]): Promise<string> {
  if (source === "merge-base") return mergeBase(deps.paths.repo, "origin/main", "HEAD");
  return revParseHead(deps.paths.repo);
}

/**
 * What the push left the volume in. `conflict` is not a failure: the rebase is
 * stopped, still in progress, waiting for the agent (#58).
 */
type ConflictOutcome = { kind: "conflict"; files: readonly string[] };

export type PushOutcome = { kind: "pushed" } | ConflictOutcome;

/** What the reconcile step decided: our commits are ready to push, or git stopped. */
type ReconcileOutcome = { kind: "ready" } | ConflictOutcome;

/**
 * Push `HEAD` to `agent/spec-<n>`, reading the token from the mounted file at push
 * time (ADR-0009).
 *
 * The branch is named per **spec**, not per ticket (`specBranch()`), so two
 * tickets of one spec write the same ref. The runner has no lock between them and
 * both run in the same namespace, so whoever commits second meets a branch that
 * already moved — and a plain `git push` is rejected non-fast-forward. Nothing in
 * the runner could reconcile that: the push was replayed identically by every
 * following pod until `backoffLimit` was exhausted, on a volume only a human
 * could repair (#55, and `pi-web#4` lost its run to exactly this).
 *
 * So the push fetches the branch and rebases our work onto its tip first. That is
 * what a human would do, and it makes the shared branch safe to write from two
 * places in sequence. A rebase that **conflicts** means two tickets changed the
 * same lines with different intent: the runner cannot pick a winner, but the agent
 * that wrote one side can — it still holds the conversation and can run the whole
 * suite against the merged result (#58). So the rebase is left stopped, exactly as
 * git left it, and this call reports the paths that need that decision.
 */
export async function pushToSpecBranch(deps: Pick<RunDeps, "env" | "paths" | "log">): Promise<PushOutcome> {
  const branch = specBranch(deps.env.specNumber);
  const options = {
    cwd: deps.paths.repo,
    tokenPath: deps.paths.token,
    identity: { name: COMMIT_IDENTITY.name, email: deps.env.commitEmail },
  };

  // One push attempt, as a sequence: fetch + rebase, then push. The whole sequence
  // is the unit the stale-credential recovery retries, because the fetch runs
  // first and is where a rejected credential usually surfaces.
  const attempt = async (): Promise<PushOutcome> => {
    const reconciled = await reconcileWithBranch(deps, branch, options);
    // A stopped rebase is not a failure of the attempt: the agent resolves it (#58),
    // so the sequence ends here and the recovery has nothing to retry.
    if (reconciled.kind === "conflict") return reconciled;

    const result = await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], options);
    if (result.exitCode !== 0) {
      // A non-fast-forward here means the branch moved again between the fetch and
      // the push. It is not this process's to fix, but it is also not the
      // deterministic conflict `reconcileWithBranch` classifies — the next pod
      // fetches the newer tip and reconciles.
      throw classifyPushFailure(result.stderr, result.exitCode, ["push", "origin", branch]);
    }
    deps.log(`pushed branch=${branch}`);
    return { kind: "pushed" };
  };

  return withStaleCredentialRecovery({
    tokenPath: deps.paths.token,
    waitMs: STALE_CREDENTIAL_WAIT_MS,
    pollMs: STALE_CREDENTIAL_POLL_MS,
    log: deps.log,
    run: attempt,
  });


}

/**
 * Fetch the spec branch and replay our commits on its tip, when it exists and is
 * not already an ancestor of `HEAD`. A no-op for the first ticket to push, for a
 * branch that does not exist yet, and for the ordinary "nothing moved" push.
 *
 * Failure classification mirrors the seed's (`classifyGitFailure`): a credential
 * or repo the runner cannot see is `auth`, and a network failure is
 * `repo_unreachable`. Only the second is worth another pod.
 */
async function reconcileWithBranch(
  deps: Pick<RunDeps, "env" | "paths" | "log">,
  branch: string,
  options: GitOptions,
): Promise<ReconcileOutcome> {
  // `+` because a fetch of an explicit refspec refuses to move the
  // remote-tracking ref backwards, and a previous run may have left a rewritten
  // one behind. The remote is the only authority for where the branch is; the
  // local branch, which holds this run's commits, is a separate ref and is not
  // touched by the fetch.
  const fetched = await runGit(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], options);
  if (fetched.exitCode !== 0) {
    // The one failure that means "nothing to reconcile": the branch does not exist
    // yet, so this ticket creates it. The pattern is deliberately narrow — GitHub
    // answers 404 to a repo the credential cannot see, and a loose `not found` test
    // would read that as "first ticket" and push with a dead credential.
    if (/couldn't find remote ref/i.test(fetched.stderr)) {
      deps.log(`push-branch-new branch=${branch}`);
      return { kind: "ready" };
    }
    throw classifyPushFailure(fetched.stderr, fetched.exitCode, ["fetch", "origin", branch]);
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  const ancestor = await runGit(["merge-base", "--is-ancestor", remoteRef, "HEAD"], options);
  // 0 = already an ancestor, 1 = it is not (a rebase is needed), anything else = the
  // ref is unreadable, which is not a decision this function may guess at.
  if (ancestor.exitCode === 0) return { kind: "ready" };
  if (ancestor.exitCode !== 1) {
    throw new Error(`git merge-base against ${remoteRef} failed (${ancestor.exitCode}): ${ancestor.stderr.trim()}`);
  }

  deps.log(`push-rebase onto=origin/${branch}`);
  const rebased = await runGit(["rebase", remoteRef], options);
  if (rebased.exitCode === 0) return { kind: "ready" };

  // `git rebase` also fails before it begins — a worktree with unstaged changes is
  // the common one — and that is not a conflict between two tickets: no later pod
  // would see it differently either, but the volume, not the branch, is what needs
  // fixing. It stays retryable and must not borrow the conflict's message.
  const inProgress = await rebaseInProgress(deps.paths.repo, options);
  if (!inProgress) {
    throw new Error(
      `git rebase onto origin/${branch} did not start (${rebased.exitCode}): ${rebased.stderr.trim() || rebased.stdout.trim()}`,
    );
  }
  // Leave the rebase exactly where git stopped it: the conflict is the agent's to
  // resolve, and aborting would throw away the state that resolution starts from.
  const files = await conflictedFiles(deps.paths.repo, options);
  deps.log(`push-conflict onto=origin/${branch} files=${files.join(",")}`);
  return { kind: "conflict", files };
}

/** The paths git left unmerged: the exit's whole work list when it is handed the rebase. */
async function conflictedFiles(repo: string, options: GitOptions): Promise<readonly string[]> {
  const result = await runGit(["diff", "--name-only", "--diff-filter=U"], options);
  if (result.exitCode !== 0) {
    throw new Error(`git diff --diff-filter=U failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path !== "")
    .sort();
}

/**
 * Whether git has a rebase half-applied: the only signal that separates a conflict
 * from a rebase that never began.
 *
 * Read from the state directory, **not** from `REBASE_HEAD`: that file survives a
 * rebase that completed, so a volume whose last push rebased cleanly would report
 * "in progress" forever, and the next dirty-worktree failure would be read as a
 * conflict no human can fix (#58 depends on this signal being exact).
 */
async function rebaseInProgress(repo: string, options: GitOptions): Promise<boolean> {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const path = await runGit(["rev-parse", "--git-path", state], options);
    if (path.exitCode !== 0) continue;
    const directory = resolve(repo, path.stdout.trim());
    const exists = await stat(directory).then(
      () => true,
      () => false,
    );
    if (exists) return true;
  }
  return false;
}

/**
 * A push that no later pod can fix, so it gets one attempt and then a human
 * (`podFailurePolicy` → `FailJob`, #55). Narrow on purpose: the repository is not a
 * git repository at all, or the rebase was handed to the agent, it reported a
 * resolution, and the branch still rejects it (#58). Everything else has a later
 * pod, or this process, that can still fix it.
 */
export class FatalPushError extends Error {}

/**
 * The mounted token no longer authenticates — a condition of the *file*, not of the
 * volume (#57).
 *
 * GitHub answers `Invalid username or token` / `Authentication failed` when the
 * token it was handed is stale. The App has already patched the replacement into
 * the Secret, so the fix is either to wait for kubelet to deliver it (this
 * process) or to start a pod that reads the file fresh (the next one). Neither is
 * a human's job, so this is never fatal — it was, briefly, and that turned a
 * recoverable incident into a lost run.
 */
export class StaleCredentialError extends Error {}

/**
 * Classify a failed git operation during the push. Three outcomes, because the
 * recovery differs:
 *
 * - `StaleCredentialError` — the credential is stale; wait for the file, then let
 *   the next attempt (or the next pod) use the new one.
 * - `FatalPushError` — no attempt can change it.
 * - a plain `Error` — transient (network, a non-fast-forward that raced another
 *   pod); the ordinary backoff handles it.
 *
 * The auth patterns are deliberately broad and the fatal ones deliberately narrow:
 * GitHub answers 404 to a repo a credential cannot see, so a repo genuinely absent
 * and a token that cannot see it are the same words on the wire. Reading that as
 * "stale credential" is the safer mistake — it costs one pod, where the opposite
 * costs the run.
 */
export function classifyPushFailure(stderr: string, exitCode: number, args: readonly string[]): Error {
  const text = stderr.toLowerCase();
  const detail = `git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`;
  // Two distinct wordings, both fatal: a bad *remote path* says "does not appear
  // to be a git repository", while a non-repository *cwd* says "not a git
  // repository (or any parent …)". The second shape is the volume's worktree
  // itself being gone or never seeded — no pod fixes that.
  if (text.includes("does not appear to be a git repository") || text.includes("not a git repository")) {
    return new FatalPushError(detail);
  }
  if (
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("terminal prompts disabled") ||
    text.includes("permission denied") ||
    text.includes("invalid username or password") ||
    text.includes("invalid username or token") ||
    text.includes("repository not found")
  ) {
    return new StaleCredentialError(detail);
  }
  return new Error(detail);
}

/**
 * How long to wait for a renewal the App already wrote to reach the pod, and how
 * often to look. ADR-0009 puts kubelet's propagation at ~1–1.5 minutes, so 2
 * minutes clears it with margin.
 */
const STALE_CREDENTIAL_WAIT_MS = 120_000;
const STALE_CREDENTIAL_POLL_MS = 5_000;

/** The parameters of one recovery attempt; every one is injected so a test never sleeps for minutes. */
export interface StaleCredentialRecovery<T> {
  /** The mounted token file. Its *content* is what says whether a renewal has landed. */
  tokenPath: string;
  waitMs: number;
  pollMs: number;
  log(line: string): void;
  /** Runs the whole fetch + rebase + push sequence. Rejects on any failure. */
  run(): Promise<T>;
}

/**
 * Run the push sequence, and when the mounted credential turns out to be stale,
 * wait for it to change and run the sequence once more (#57).
 *
 * This exists because the App can write a renewal the pod has not received yet:
 * a reconcile pass patches the Secret (and the pass log carries `renewed=<n>`),
 * while kubelet needs up to ~1–1.5 minutes to swap the volume's symlink. A push
 * that lands in that window authenticates with the token it was born with and is
 * rejected. Waiting is the only fix available inside the process — the file is
 * the only channel.
 *
 * Three properties matter, and each has a test:
 *
 * - **Only a stale credential waits.** A conflict, a network failure, a
 *   non-fast-forward: none of them get better by waiting, so they return at once.
 * - **The retry happens at most once.** If the second attempt fails too, this
 *   process is done; the next pod reads the file fresh, which is the other half of
 *   the recovery and must stay reachable. So the error it throws is the original
 *   kind, never fatal.
 * - **Waiting is bounded.** A file that never changes must not hang the pod; when
 *   the bound expires the stale-credential error comes back unchanged.
 */
export async function withStaleCredentialRecovery<T>(params: StaleCredentialRecovery<T>): Promise<T> {
  // Fingerprinted before the attempt so the wait cannot miss a renewal that
  // landed mid-attempt (see the comment in the catch block).
  const fingerprintBefore = await tokenFingerprint(params.tokenPath);
  try {
    return await params.run();
  } catch (error) {
    if (!(error instanceof StaleCredentialError)) throw error;

    // The fingerprint is taken from *before* the attempt, not now: a renewal that
    // arrived while the attempt was failing is then already visible, and the wait
    // retries at once instead of sitting out its bound for a change it has.
    params.log(`push-stale-credential waiting-for-renewal file=${fingerprintBefore}`);
    const changed = await waitForFileChange(params, fingerprintBefore);
    if (!changed) {
      // Nothing arrived: hand the original failure to the ordinary retry path.
      params.log(`push-stale-credential renewal-not-seen waited-ms=${params.waitMs}`);
      throw error;
    }

    params.log("push-stale-credential retrying");
    // Deliberately not caught: a second failure of any kind ends this process's
    // attempt, and its own classification decides retryable vs fatal.
    return await params.run();
  }
}

/** A fingerprint of the mounted file: content hash, or a marker when it cannot be read. */
async function tokenFingerprint(path: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex").slice(0, 16);
  } catch {
    return "unreadable";
  }
}

/** Poll until the file's fingerprint differs from `before`, or the bound expires. */
async function waitForFileChange(params: StaleCredentialRecovery<unknown>, before: string): Promise<boolean> {
  const deadline = Date.now() + params.waitMs;
  while (Date.now() < deadline) {
    await sleep(params.pollMs);
    if ((await tokenFingerprint(params.tokenPath)) !== before) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Which exit code a failed run ends the pod with. Only a `FatalPushError` is
 * terminal; everything else — a stale credential (#57), a fetch that timed out, a
 * push that raced another pod, a model error — is what `backoffLimit` is for.
 */
export function pushExitCodeFor(error: unknown): typeof RUNNER_EXIT.retryable | typeof RUNNER_EXIT.fatal {
  return error instanceof FatalPushError ? RUNNER_EXIT.fatal : RUNNER_EXIT.retryable;
}
