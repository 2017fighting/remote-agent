import { mkdir } from "node:fs/promises";
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
import { ReviewFixedPointDoc, type ReviewFixedPoint } from "./fixed-point-doc.js";
import { ReviewRoundDoc, RunCompletedDoc, RunResultDoc } from "./run-docs.js";
import { resultExtension, resultToolsForRole, commitRunResult } from "./result-tools.js";
import { codeReviewTool, type ReviewReports } from "./code-review.js";
import { runReview } from "./reviewer.js";
import { reviewerExtension } from "./reviewer-tools.js";
import { mergeBase, revParseHead, runGit, type GitOptions } from "./git.js";

const context = BACKGROUND_CONTEXT;
const THINKING_LEVEL = "high";
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
  /** Writes the run result on the Job annotation. Called only after a successful push. */
  annotate(result: RunResultV1): Promise<void>;
  /** Pushes `HEAD` to `agent/spec-<n>`; throws on any failure, including a non-fast-forward. */
  push(): Promise<void>;
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
  /** True when the volume already carried a finished run: nothing was done. */
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
    if (await isComplete(harness, root)) {
      deps.log(`runner-open conversation=${ROOT_CONVERSATION_ID} already-complete=true`);
      return { exitCode: 0, resumed: false, alreadyComplete: true };
    }

    // Outcome already decided but not delivered (the previous pod died before the push
    // landed): go straight to push + annotate, never back through the agent.
    const decided = await readCommittedResult(deps, harness, root);
    const pending = decided === undefined ? await resumeUnfinished(deps, harness) : undefined;
    const resumed = decided !== undefined || pending !== undefined;
    let submission = pending;
    if (decided === undefined && submission === undefined) {
      const fixedPoint = await readOrComputeFixedPoint(deps, harness, root);
      submission = await submitRun(deps, storage, root, fixedPoint);
      deps.crashAfterSubmit?.();
    }
    deps.log(`runner-open conversation=${ROOT_CONVERSATION_ID} resumed=${resumed}`);
    const result = decided ?? (await waitForResult(deps, harness, root, submission!));
    // Push strictly precedes the annotation: a push failure leaves no result behind,
    // so k8s starts a new pod that resumes to this same point and pushes again.
    await deps.push();
    await deps.annotate(result);
    await markComplete(harness, root);
    return { exitCode: 0, result, resumed, alreadyComplete: false };
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
      env: () => new NodeExecutionEnv({ cwd: deps.paths.repo }),
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

async function submitRun(deps: RunDeps, storage: Storage, root: Conversation, fixedPoint: ReviewFixedPoint): Promise<Submission> {
  const prompt = await renderPrompt({
    role: deps.env.role,
    workItem: deps.env.workItem,
    fixedPoint: fixedPoint.fixedPoint,
    promptsDir: deps.paths.prompts,
  });
  return root.submit(
    {
      type: "input",
      content: prompt,
      // Deduplication key: a process that reaches this line again after a crash finds
      // the same submission instead of starting a second run (ADR-0008).
      requestId: await submissionKeyFor(deps, storage, root),
    },
    context,
  );
}

/** A submission that can no longer change: the run it admitted has ended. */
function isSettled(submission: SubmissionRecord): boolean {
  return submission.status === "done" || submission.status === "unanswered";
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
async function submissionKeyFor(deps: RunDeps, storage: Storage, root: Conversation): Promise<string> {
  const base = runRequestId(deps);
  const settled = await settledInputSubmissions(storage, root);
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
 * This conversation's settled **input** submissions, oldest first.
 *
 * Input-only on purpose: pi-durable admits compaction summaries as `type:
 * "write"` on the same conversation and settles them `done`, so counting every
 * settled record would inflate the attempt number and point the retry log at a
 * compaction rather than at the failed run it is retrying.
 */
async function settledInputSubmissions(storage: Storage, root: Conversation): Promise<readonly SubmissionRecord[]> {
  const settled: SubmissionRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanSubmissions({ conversationId: root.id, order: "ascending" }, SCAN_PAGE_SIZE, cursor, context);
    for (const submission of page.items) {
      if (submission.type === "input" && isSettled(submission)) settled.push(submission);
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
 * places in sequence. A rebase that **conflicts** is the one case the runner
 * cannot resolve — the two tickets changed the same lines with different intent —
 * so it aborts the rebase (leaving the worktree exactly as the run left it) and
 * throws a fatal error, which the entry turns into an exit code `podFailurePolicy`
 * maps to FailJob. Deterministic means one attempt, not five.
 */
export async function pushToSpecBranch(deps: Pick<RunDeps, "env" | "paths" | "log">): Promise<void> {
  const branch = specBranch(deps.env.specNumber);
  const options = {
    cwd: deps.paths.repo,
    tokenPath: deps.paths.token,
    identity: { name: "remote-agent[bot]", email: deps.env.commitEmail },
  };
  await reconcileWithBranch(deps, branch, options);

  const result = await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], options);
  if (result.exitCode !== 0) {
    // A non-fast-forward here means the branch moved again between the fetch and
    // the push. It is not retryable in this process, but it is also not the
    // deterministic conflict `reconcileWithBranch` classifies — the next pod
    // fetches the newer tip and reconciles, so this stays a retryable failure.
    throw new Error(`git push to ${branch} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  deps.log(`pushed branch=${branch}`);
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
): Promise<void> {
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
      return;
    }
    throw classifyPushFailure(fetched.stderr, fetched.exitCode, ["fetch", "origin", branch]);
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  const ancestor = await runGit(["merge-base", "--is-ancestor", remoteRef, "HEAD"], options);
  // 0 = already an ancestor, 1 = it is not (a rebase is needed), anything else = the
  // ref is unreadable, which is not a decision this function may guess at.
  if (ancestor.exitCode === 0) return;
  if (ancestor.exitCode !== 1) {
    throw new Error(`git merge-base against ${remoteRef} failed (${ancestor.exitCode}): ${ancestor.stderr.trim()}`);
  }

  deps.log(`push-rebase onto=origin/${branch}`);
  const rebased = await runGit(["rebase", remoteRef], options);
  if (rebased.exitCode === 0) return;

  // Only a rebase that actually started and stopped on a conflict is the case no
  // later pod can fix. `git rebase` also fails before it begins — a worktree with
  // unstaged changes is the common one — and that is not a conflict between two
  // tickets, so it must not borrow the fatal class (or the message).
  const inProgress = await rebaseInProgress(deps.paths.repo, options);
  if (!inProgress) {
    throw new Error(
      `git rebase onto origin/${branch} did not start (${rebased.exitCode}): ${rebased.stderr.trim() || rebased.stdout.trim()}`,
    );
  }
  // Leave the worktree as the run left it: a half-applied rebase would make the
  // next pod's work ambiguous. The commits survive on the branch either way.
  const aborted = await runGit(["rebase", "--abort"], options);
  const abortNote = aborted.exitCode === 0 ? "" : ` (and \`rebase --abort\` failed: ${aborted.stderr.trim()})`;
  throw new FatalPushError(
    `git rebase onto origin/${branch} conflicted: ${rebased.stderr.trim() || rebased.stdout.trim()}${abortNote}`,
  );
}

/** Whether git left a rebase half-applied: the only signal that separates a conflict from a rebase that never began. */
async function rebaseInProgress(repo: string, options: GitOptions): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], options);
  // REBASE_HEAD is written only once a rebase has a commit to stop on.
  return result.exitCode === 0;
}

/**
 * A push that no later pod can fix, so it gets one attempt and then a human
 * (`podFailurePolicy` → `FailJob`, #55). Two shapes qualify: the rebase stopped on
 * a conflict between two tickets' work, and the credential or repository cannot be
 * read at all — ADR-0009's "GitHub answers 404 to a repo the credential cannot
 * see", which the seed treats as equally fatal.
 */
export class FatalPushError extends Error {}

/**
 * Classify a failed git operation during the push. `repo_unreachable` is the one
 * kind another pod may survive; everything else is a condition of the volume or
 * the credential, which the next pod would meet identically.
 */
export function classifyPushFailure(stderr: string, exitCode: number, args: readonly string[]): Error {
  const text = stderr.toLowerCase();
  const detail = `git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`;
  if (
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("terminal prompts disabled") ||
    text.includes("permission denied") ||
    text.includes("invalid username or password") ||
    text.includes("invalid username or token") ||
    text.includes("repository not found") ||
    text.includes("does not appear to be a git repository")
  ) {
    return new FatalPushError(detail);
  }
  return new Error(detail);
}

/**
 * Which exit code a failed run ends the pod with. Only a `FatalPushError` is
 * terminal; everything else (a fetch that timed out, a push that raced another
 * pod, a model error) is what `backoffLimit` is for.
 */
export function pushExitCodeFor(error: unknown): typeof RUNNER_EXIT.retryable | typeof RUNNER_EXIT.fatal {
  return error instanceof FatalPushError ? RUNNER_EXIT.fatal : RUNNER_EXIT.retryable;
}
