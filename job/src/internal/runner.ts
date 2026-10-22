import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  type Conversation,
  type AgentChange,
  type Harness as HarnessHandle,
  type Storage,
  type Submission,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Models } from "@earendil-works/pi-ai";
import { isRunResultV1, specBranch, type RunResultV1, type WorkItemV1 } from "@remote-agent/shared";
import type { JobPaths, RunnerEnv } from "./env.js";
import { renderPrompt } from "./prompt.js";
import { ReviewFixedPointDoc, type ReviewFixedPoint } from "./fixed-point-doc.js";
import { ReviewRoundDoc, RunCompletedDoc, RunResultDoc } from "./run-docs.js";
import { resultExtension, resultToolsForRole, commitRunResult } from "./result-tools.js";
import { codeReviewTool, type ReviewReports } from "./code-review.js";
import { runReview } from "./reviewer.js";
import { reviewerExtension } from "./reviewer-tools.js";
import { mergeBase, revParseHead, runGit } from "./git.js";

const context = BACKGROUND_CONTEXT;
const THINKING_LEVEL = "high";

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
  const harness = await openHarness(deps, storage, createRegistry(), handle);
  handle.push(harness);
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
      submission = await submitRun(deps, root, fixedPoint);
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
  registry: ReturnType<typeof createRegistry>,
  handle: HarnessHandle[],
): Promise<HarnessHandle> {
  if (deps.env.thinkingLevel !== THINKING_LEVEL) {
    // The Job template pins `high` (docs/deployment.md §9); a different value is an
    // App-side wiring bug and the runner does not silently substitute one.
    throw new Error(`AGENT_THINKING_LEVEL=${deps.env.thinkingLevel} is not the pinned level ${THINKING_LEVEL}`);
  }
  registry.install(CodingTools);
  // Installed so a reviewer conversation can select it by name; the implementer's
  // agent removes it, and a reviewer selects nothing else (spec #33 §6).
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

  const harness = await Harness.open(
    storage,
    {
      models: deps.models,
      registry,
      env: () => new NodeExecutionEnv({ cwd: deps.paths.repo }),
      now: () => (deps.now?.() ?? new Date()).getTime(),
      onReport: (error) => deps.log(`runner-report error=${String(error)}`),
    },
    context,
  );
  return harness;
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

async function submitRun(deps: RunDeps, root: Conversation, fixedPoint: ReviewFixedPoint): Promise<Submission> {
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
      requestId: runRequestId(deps),
    },
    context,
  );
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

/** Push `HEAD` to `agent/spec-<n>`, reading the token from the mounted file at push time (ADR-0009). */
export async function pushToSpecBranch(deps: Pick<RunDeps, "env" | "paths" | "log">): Promise<void> {
  const branch = specBranch(deps.env.specNumber);
  const result = await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], {
    cwd: deps.paths.repo,
    tokenPath: deps.paths.token,
    identity: { name: "remote-agent[bot]", email: deps.env.commitEmail },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git push to ${branch} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  deps.log(`pushed branch=${branch}`);
}
