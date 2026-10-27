import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { RUNNER_EXIT } from "@remote-agent/shared";
import {
  FatalPushError,
  GENERATION_RETRY_POLICY,
  pushExitCodeFor,
  pushToSpecBranch,
  run,
} from "../src/internal/runner.js";
import { ReviewFixedPointDoc } from "../src/internal/fixed-point-doc.js";
import { resetForNewRound } from "../src/internal/round.js";
import { ConflictHandoffDoc, RunCompletedDoc, RunResultDoc } from "../src/internal/run-docs.js";
import { readRunnerEnv, StartupError, type RunnerEnv } from "../src/internal/env.js";
import { runRunner } from "../src/runner.js";
import {
  blockedCall,
  cleanup,
  depsFor,
  codeReviewCall,
  finishSpecCall,
  finishTicketCall,
  fauxAssistantMessage,
  fauxToolCall,
  git,
  noOwnRunResult,
  openStorageFor,
  reviewerConversations,
  reviewerReport,
  runnerFixture,
  specWorkItem,
  type Recorded,
  submittedPrompt,
  submittedPrompts,
  WORK_ITEM,
  type RunnerFixture,
} from "./support/runner-fixture.js";

let fixture: RunnerFixture | undefined;
afterEach(async () => {
  await cleanup(fixture);
  fixture = undefined;
});

/** Read one durable document the way a later process would. */
async function readDoc(f: RunnerFixture, token: typeof ReviewFixedPointDoc): Promise<unknown> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(f.paths.sessionDatabase),
    { models: f.models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    return await harness.snapshot(token, root.id, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

/** Every requestId the volume's session storage carries, in creation order. */
async function submissionRequestIds(f: RunnerFixture): Promise<(string | undefined)[]> {
  const storage = await openNodeSqliteStorage(f.paths.sessionDatabase);
  try {
    const page = await storage.scanSubmissions({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    return page.items.map((submission) => submission.requestId);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}

/**
 * Leave a settled `write` submission on the volume, the shape a compaction
 * summary produces. The harness admits it as a passive entry write, so it never
 * starts a run and must not count as an attempt.
 */
async function appendSettledWrite(f: RunnerFixture): Promise<void> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(f.paths.sessionDatabase),
    { models: f.models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    // A write is a passive entry append: no model, no run, so a bare agent suffices.
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "omniroute", modelId: "default" }, thinkingLevel: "high" },
    });
    const submission = await root.submit(
      { type: "write", requestId: "compaction:seeded", entry: { kind: "pi.compaction" } },
      BACKGROUND_CONTEXT,
    );
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

/** The rendered prompt is the user entry of the run — the only prompt the model ever sees. */

/** Put a specific committed round on the volume: the state a crash or a corruption leaves. */
async function writeCommittedRun(
  f: RunnerFixture,
  state: { completedAt: string; payload: string },
): Promise<void> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(f.paths.sessionDatabase),
    { models: f.models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    await root.commit(async (tx) => {
      (await tx.doc(RunCompletedDoc, root.id)).completedAt = state.completedAt;
      (await tx.doc(RunResultDoc, root.id)).payload = state.payload;
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

describe("runner: startup validation", () => {
  const REQUIRED = [
    "AGENT_ROLE",
    "AGENT_THINKING_LEVEL",
    "AGENT_WORK_ITEM",
    "TARGET_REPO",
    "SPEC_NUMBER",
    "GIT_REMOTE_URL",
    "OMNIROUTE_BASE_URL",
    "OMNIROUTE_MODEL",
    "OMNIROUTE_REVIEW_MODEL",
    "OMNIROUTE_API_KEY",
  ];

  const NAMESPACE = "remote-agent";

  function fullEnv(): Record<string, string> {
    return {
      AGENT_ROLE: "implement-ticket",
      AGENT_THINKING_LEVEL: "high",
      AGENT_WORK_ITEM: JSON.stringify(WORK_ITEM),
      TARGET_REPO: WORK_ITEM.repo,
      SPEC_NUMBER: "33",
      GIT_REMOTE_URL: "https://github.com/2017fighting/remote-agent.git",
      OMNIROUTE_BASE_URL: "http://omniroute.test/v1",
      OMNIROUTE_MODEL: "default",
      OMNIROUTE_REVIEW_MODEL: "review",
      OMNIROUTE_API_KEY: "key",
    };
  }

  it.each(REQUIRED)("fails at startup when %s is missing", (key) => {
    const env = fullEnv();
    delete env[key];
    expect(() => readRunnerEnv(env, NAMESPACE)).toThrow(StartupError);
    expect(() => readRunnerEnv(env, NAMESPACE)).toThrow(new RegExp(key));
  });

  it("fails the entrypoint before it opens storage or calls a model", async () => {
    const env = fullEnv();
    delete env["OMNIROUTE_REVIEW_MODEL"];
    // Not an I/O error from a missing /mnt/agent: validation runs first.
    await expect(runRunner({ env, namespace: NAMESPACE })).rejects.toThrow(StartupError);
    await expect(runRunner({ env, namespace: NAMESPACE })).rejects.toThrow(/OMNIROUTE_REVIEW_MODEL/);
  });

  it("rejects an unparseable work item at startup", () => {
    const env = fullEnv();
    env["AGENT_WORK_ITEM"] = "{not json";
    expect(() => readRunnerEnv(env, NAMESPACE)).toThrow(/AGENT_WORK_ITEM/);
  });

  it("rejects a work item for a different repo than TARGET_REPO", () => {
    const env = fullEnv();
    env["AGENT_WORK_ITEM"] = JSON.stringify({ ...WORK_ITEM, repo: "other/repo" });
    expect(() => readRunnerEnv(env, NAMESPACE)).toThrow(/does not match/);
  });
});

describe("runner: one run to a Result tool", () => {
  it("renders a self-contained prompt with every placeholder substituted", async () => {
    fixture = await runnerFixture();
    const headBefore = await git(["rev-parse", "HEAD"], fixture.worktree);
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall()]);

    const outcome = await run(depsFor(fixture, recorded));
    expect(outcome.exitCode).toBe(0);

    const prompt = await submittedPrompt(fixture);
    // `_common` + the role template, both fully rendered.
    expect(prompt).toContain("You are an unattended agent working on 2017fighting/remote-agent#39.");
    expect(prompt).toContain("Title: Job image: seed + runner");
    expect(prompt).toContain(WORK_ITEM.body);
    expect(prompt).toContain("This run implements ticket #39 of spec #33.");
    expect(prompt).toContain(`Fixed point: ${headBefore}`);
    expect(prompt).not.toMatch(/\{\{\s*[a-z_]+\s*\}\}/);
    // The templates never carry slash commands: durable has no such layer (ADR-0004).
    expect(prompt).not.toMatch(/^\s*\/[a-z-]+\s*$/m);
  });

  /**
   * ADR-0017. A ticket's body is its acceptance surface, but the comments are where
   * a human writes a correction — including the one that made them reopen the ticket.
   * They were never rendered at all, so the model could not read the words the whole
   * round exists to answer. Same shape as the spec role's ticket map: one reader
   * learns one format.
   */
  it("renders the ticket's own comments into the body, oldest first", async () => {
    fixture = await runnerFixture();
    const workItem = {
      ...WORK_ITEM,
      comments: [
        { author: "remote-agent[bot]", body: "Done: pushed a fix", createdAt: "2026-10-26T05:26:00.000Z" },
        { author: "maintainer", body: "reopened: the CI job still fails", createdAt: "2026-10-26T05:44:00.000Z" },
      ],
    };
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall()]);
    await run(depsFor(fixture, recorded, { env: { ...fixture.env, workItem } }));

    const prompt = await submittedPrompt(fixture);
    expect(prompt).toContain("## Comments");
    expect(prompt).toContain("**maintainer** (2026-10-26T05:44:00.000Z):");
    expect(prompt).toContain("reopened: the CI job still fails");
    expect(prompt.indexOf("Done: pushed a fix")).toBeLessThan(prompt.indexOf("reopened: the CI job still fails"));
  });

  it("renders no comment section for a ticket with no comments", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall()]);
    await run(depsFor(fixture, recorded, { env: { ...fixture.env, workItem: { ...WORK_ITEM, comments: [] } } }));

    expect(await submittedPrompt(fixture)).not.toContain("## Comments");
  });

  it("pushes before it annotates, and annotates exactly once", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("delivered")]);

    await run(depsFor(fixture, recorded));

    expect(recorded.events).toEqual(["push", "annotate"]);
    expect(recorded.results).toHaveLength(1);
    expect(recorded.results[0]).toMatchObject({ v: 1, outcome: "done", summary: "delivered" });
    // The push really landed on the spec branch of the bare remote.
    const remoteHead = await git(["rev-parse", "agent/spec-33"], fixture.remote);
    expect(remoteHead).toBe(await git(["rev-parse", "HEAD"], fixture.worktree));
  });

  it("writes no annotation and exits nonzero when the push fails", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall()]);

    await expect(
      run(
        depsFor(fixture, recorded, {
          push: async () => {
            recorded.events.push("push");
            throw new Error("non-fast-forward");
          },
        }),
      ),
    ).rejects.toThrow(/non-fast-forward/);

    expect(recorded.events).toEqual(["push"]);
    expect(recorded.results).toEqual([]);
  });

  it("resumes to the push when the previous pod died before delivering the result", async () => {
    fixture = await runnerFixture();
    const first: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("decided before the crash")]);

    await expect(
      run(
        depsFor(fixture, first, {
          push: async () => {
            first.events.push("push");
            throw new Error("remote unreachable");
          },
        }),
      ),
    ).rejects.toThrow(/remote unreachable/);
    expect(first.results).toEqual([]);

    const second: Recorded = { events: [], results: [] };
    const outcome = await run(depsFor(fixture, second));
    expect(outcome.resumed).toBe(true);
    // No model request on the retry: the outcome was already committed.
    expect(fixture.pendingResponses()).toBe(0);
    expect(second.events).toEqual(["push", "annotate"]);
    expect(second.results[0]).toMatchObject({ summary: "decided before the crash" });
  });

  /**
   * ADR-0016. `already-complete` has two meanings, and only one of them is a
   * no-op. A **replacement pod of the Job that finished the run** finds its own
   * annotation on that Job and has nothing left to do. A **new Job on a spent
   * volume** — the shape that made a second closeout round do nothing (#60) —
   * carries no annotation, and exiting 0 there would end the Job `Complete` with
   * nothing reported: a shape no reader, human or App, can tell apart from a
   * crashed runner. So the runner refuses (exit 78 → `podFailurePolicy` `FailJob`).
   */
  it("does nothing at all when the volume's finished run is this Job's own", async () => {
    fixture = await runnerFixture();
    const first: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall()]);
    expect((await run(depsFor(fixture, first))).alreadyComplete).toBe(false);

    const second: Recorded = { events: [], results: [] };
    const outcome = await run(
      depsFor(fixture, second, {
        // The same Job: its own run-result annotation is already there.
        hasOwnRunResult: async () => true,
      }),
    );
    expect(outcome.alreadyComplete).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(second.events).toEqual([]);
    // No new model request: the scripted response from the first run was not consumed again.
    expect(fixture.pendingResponses()).toBe(0);
  });

  /**
   * ADR-0017. The ticket role's mirror image of the closeout shape above: the
   * volume already reported, but the Job is new — the human reopened a `done`
   * ticket, or re-entered a `blocked` one — so there is a round to run, not a
   * no-op and not a refusal. The conversation stays on purpose: the previous
   * round's history is exactly what makes "reopened, with new comments" worth
   * running (ADR-0011).
   */
  it("runs a new round when a new Job finds a reported ticket volume", async () => {
    fixture = await runnerFixture();
    const first: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("did the thing")]);
    expect((await run(depsFor(fixture, first))).alreadyComplete).toBe(false);
    expect(first.results[0]).toMatchObject({ summary: "did the thing" });

    // The Job object left its retention window and a new one appeared under the same
    // deterministic name: no annotation on this Job, a reported conversation on the
    // volume.
    const second: Recorded = { events: [], results: [] };
    const log: string[] = [];
    fixture.script([finishTicketCall("did the second thing")]);
    const outcome = await run(depsFor(fixture, second, { log: (line: string) => log.push(line) }));

    expect(outcome.exitCode).toBe(0);
    expect(outcome.alreadyComplete).toBe(false);
    expect(second.events).toEqual(["push", "annotate"]);
    // The new round's own result, not the previous round's re-annotated.
    expect(second.results[0]).toMatchObject({ outcome: "done", summary: "did the second thing" });
    // The round says which round it is and how the one before it ended, read before
    // the reset cleared it.
    expect(log.join("\n")).toContain("runner-round-start round=2 previous-outcome=done previous-completed-at=2");
    // The submission key moved on by itself (#52): the base key is settled, so the
    // new round runs under its numbered retry — without which the dedup key would
    // hand the new round the finished run's record.
    const base = `remote-agent:${WORK_ITEM.repo}#${WORK_ITEM.number}:implement-ticket`;
    expect(await submissionRequestIds(fixture)).toEqual([base, `${base}#retry-1`]);

    // A third round keeps counting: the number counts rounds that reported, not Jobs.
    const third: Recorded = { events: [], results: [] };
    const thirdLog: string[] = [];
    fixture.script([finishTicketCall("did the third thing")]);
    const thirdOutcome = await run(depsFor(fixture, third, { log: (line: string) => thirdLog.push(line) }));
    expect(thirdOutcome.exitCode).toBe(0);
    expect(thirdLog.join("\n")).toContain("runner-round-start round=3 previous-outcome=done");
    expect((await submittedPrompts(fixture))[2]).toContain("# Round 3 of this ticket");
  });

  /**
   * #65. The spec issue is where a human writes the correction only a spec-level run
   * can act on — "don't open the PR yet", "the acceptance surface changed: drop
   * ticket X". The spec role is also the one role with no continuity channel: every
   * closeout round starts on a fresh volume (ADR-0016), so the comments — including
   * the App's own failure comment from the round before — are the whole record of what
   * happened. They reached the model nowhere. Same shape as the ticket role's own
   * comments, one level up.
   */
  it("renders the spec's own comments into the body, after the body and before the ticket map", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    const env: RunnerEnv = {
      ...fixture.env,
      role: "implement-spec",
      workItem: specWorkItem({
        comments: [
          { author: "maintainer", body: "first correction", createdAt: "2026-10-26T05:44:00.000Z" },
          { author: "maintainer", body: "don't open the PR yet", createdAt: "2026-10-26T06:00:00.000Z" },
        ],
      }),
    };
    fixture.script([finishSpecCall({ prBody: "p" })]);
    await run(depsFor(fixture, recorded, { env }));

    const prompt = await submittedPrompt(fixture);
    expect(prompt).toContain("**maintainer** (2026-10-26T05:44:00.000Z):");
    expect(prompt).toContain("don't open the PR yet");
    // Body, then the spec's own comments oldest first, then the ticket map. The
    // level-2 heading is what tells the spec's section from the map's `####`.
    const bodyAt = prompt.indexOf("SPEC BODY TEXT");
    const ownCommentsAt = prompt.indexOf("\n## Comments\n");
    const firstCommentAt = prompt.indexOf("first correction");
    const secondCommentAt = prompt.indexOf("don't open the PR yet");
    const ticketMapAt = prompt.indexOf("## Ticket map");
    expect(bodyAt).toBeGreaterThanOrEqual(0);
    expect(ownCommentsAt).toBeGreaterThan(bodyAt);
    expect(firstCommentAt).toBeGreaterThan(ownCommentsAt);
    expect(secondCommentAt).toBeGreaterThan(firstCommentAt);
    expect(ticketMapAt).toBeGreaterThan(secondCommentAt);
    // The ticket map keeps rendering every sub-issue with its own comments.
    expect(prompt).toContain("### #39 — seed + runner");
    expect(prompt).toContain("TICKET BODY TEXT");
    expect(prompt).toContain("#### Comments");
    expect(prompt).toContain("ticket comment");
  });

  it("renders no comment section for a spec with no comments of its own", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    const env: RunnerEnv = {
      ...fixture.env,
      role: "implement-spec",
      // `specWorkItem()` carries no comments of the spec's own and a non-empty map.
      workItem: specWorkItem(),
    };
    fixture.script([finishSpecCall({ prBody: "p" })]);
    await run(depsFor(fixture, recorded, { env }));

    const prompt = await submittedPrompt(fixture);
    expect(prompt).not.toContain("\n## Comments\n");
    // Not vacuous: the ticket map's own `#### Comments` is still there.
    expect(prompt).toContain("#### Comments");
    expect(prompt).toContain("ticket comment");
  });

  it("renders a truncated spec comment list with its pointer line first", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    // The App's truncation pointer as it arrives on the wire — one string, used once
    // here because the job workspace cannot import the App's `OMITTED_COMMENTS_PLACEHOLDER`.
    const omittedPointer = "… earlier comments omitted, see GitHub";
    const env: RunnerEnv = {
      ...fixture.env,
      role: "implement-spec",
      workItem: specWorkItem({
        // What the App's byte budget leaves behind: the pointer the reader needs to
        // know the history above it was dropped (work item budget, 512 KB).
        comments: [
          { author: "remote-agent", body: omittedPointer, createdAt: "" },
          { author: "maintainer", body: "the newest kept comment", createdAt: "2026-10-26T06:00:00.000Z" },
        ],
        tickets: [],
      }),
    };
    fixture.script([finishSpecCall({ prBody: "p" })]);
    await run(depsFor(fixture, recorded, { env }));

    const prompt = await submittedPrompt(fixture);
    const ownCommentsAt = prompt.indexOf("\n## Comments\n");
    const pointerAt = prompt.indexOf(omittedPointer);
    expect(ownCommentsAt).toBeGreaterThanOrEqual(0);
    expect(pointerAt).toBeGreaterThan(ownCommentsAt);
    expect(pointerAt).toBeLessThan(prompt.indexOf("the newest kept comment"));
  });

  /**
   * ADR-0017. A round's review is per-round: its fixed point is where **that**
   * round's work started, and its `code_review` round is its own. Inheriting either
   * from the round that already reported would review the wrong range, or bounce the
   * new round's review as "already ran" and let its work go unreviewed.
   */
  it("gives the new round its own fixed point and its own review round", async () => {
    fixture = await runnerFixture();
    const { writeFile } = await import("node:fs/promises");
    const commit = async (name: string): Promise<string> => {
      await writeFile(join(fixture!.worktree, name), "work\n");
      await git(["add", "-A"], fixture!.worktree);
      await git(["commit", "-m", `work: ${name} (#39)`], fixture!.worktree);
      return git(["rev-parse", "HEAD"], fixture!.worktree);
    };
    const beforeWork = await git(["rev-parse", "HEAD"], fixture.worktree);
    const headAfterRound1 = await commit("round-1.txt");

    const first: Recorded = { events: [], results: [] };
    fixture.script([
      codeReviewCall(beforeWork),
      reviewerReport("round 1 spec"),
      reviewerReport("round 1 standards"),
      finishTicketCall("round 1 done"),
    ]);
    await run(depsFor(fixture, first, { standardsFiles: async () => [] }));
    expect(await readDoc(fixture, ReviewFixedPointDoc)).toMatchObject({ fixedPoint: headAfterRound1 });
    expect(await reviewerConversations(fixture)).toHaveLength(2);

    const headAfterRound2 = await commit("round-2.txt");
    const second: Recorded = { events: [], results: [] };
    const log: string[] = [];
    fixture.script([
      codeReviewCall(headAfterRound1),
      reviewerReport("round 2 spec"),
      reviewerReport("round 2 standards"),
      finishTicketCall("round 2 done"),
    ]);
    const outcome = await run(
      depsFor(fixture, second, { standardsFiles: async () => [], log: (line: string) => log.push(line) }),
    );

    expect(outcome.result).toMatchObject({ outcome: "done", summary: "round 2 done" });
    // Recomputed for this round, not inherited from the one that reported.
    expect(await readDoc(fixture, ReviewFixedPointDoc)).toMatchObject({
      fixedPoint: headAfterRound2,
      source: "run-start",
    });
    expect(log.join("\n")).toContain(`fixed-point sha=${headAfterRound2} source=run-start`);
    // Its own round ran: two reviewer conversations per round, and the scripted
    // provider was asked for exactly the four reports it had.
    expect(await reviewerConversations(fixture)).toHaveLength(4);
    expect(fixture.pendingResponses()).toBe(0);
  });

  /**
   * ADR-0017. The same entrance, one outcome over: `markComplete()` runs for every
   * reported round, so a `blocked` round leaves the volume just as reported as a
   * `done` one — and the human's re-entry (drop `agent:blocked`, swap
   * `ready-for-human` back to `ready-for-agent`) is exactly the re-entry ADR-0011
   * keeps the volume for.
   */
  it("runs a new round after a blocked round too", async () => {
    fixture = await runnerFixture();
    const first: Recorded = { events: [], results: [] };
    fixture.script([blockedCall({ summary: "needs a decision", commentBody: "change X" })]);
    expect((await run(depsFor(fixture, first))).result).toMatchObject({ outcome: "blocked" });

    const second: Recorded = { events: [], results: [] };
    const log: string[] = [];
    fixture.script([finishTicketCall("did it after all")]);
    const outcome = await run(depsFor(fixture, second, { log: (line: string) => log.push(line) }));

    expect(outcome.exitCode).toBe(0);
    expect(outcome.alreadyComplete).toBe(false);
    expect(second.results[0]).toMatchObject({ outcome: "done", summary: "did it after all" });
    expect(log.join("\n")).toContain("runner-round-start round=2 previous-outcome=blocked");
  });

  /**
   * ADR-0017. The previous round's history is in the conversation, but nothing there
   * says "the human reopened this and this is a new round" — the model's own last act
   * was reporting `done`. The header is the runner's one line about that, and it is
   * prepended: it is what the model reads first.
   */
  it("tells the new round that it is one, and leaves the first round without a header", async () => {
    fixture = await runnerFixture();
    const first: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("round 1")]);
    await run(depsFor(fixture, first));

    const second: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("round 2")]);
    await run(depsFor(fixture, second));

    const prompts = await submittedPrompts(fixture);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("# Round 1 of this ticket");
    expect(prompts[1]).toContain("# Round 2 of this ticket");
    expect(prompts[1]).toContain("reported **done**");
    expect(prompts[1]!.indexOf("# Round 2 of this ticket")).toBeLessThan(prompts[1]!.indexOf("# Who you are"));
  });

  /**
   * ADR-0017. The round boundary is one commit, and a pod that dies right after it
   * leaves "a clean unfinished conversation that is still round 2". The number comes
   * from the settled submissions, which the reset never touches — so the next pod
   * names the round correctly even though the facts about the previous one are gone.
   * The header must degrade there, not throw.
   */
  it("still names the round when the previous round's facts were already cleared", async () => {
    fixture = await runnerFixture();
    const first: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("round 1")]);
    await run(depsFor(fixture, first));

    // The crash window: the round boundary landed, the first model request never did.
    const harness = await Harness.open(
      await openNodeSqliteStorage(fixture.paths.sessionDatabase),
      { models: fixture.models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      await resetForNewRound(harness, await harness.root(BACKGROUND_CONTEXT));
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }

    const second: Recorded = { events: [], results: [] };
    const log: string[] = [];
    fixture.script([finishTicketCall("round 2 after the crash")]);
    const outcome = await run(depsFor(fixture, second, { log: (line: string) => log.push(line) }));

    expect(outcome.exitCode).toBe(0);
    expect(second.results[0]).toMatchObject({ summary: "round 2 after the crash" });
    // Not a round boundary this time — the boundary already happened — but still round 2.
    expect(log.join("\n")).not.toContain("runner-round-start");
    const prompts = await submittedPrompts(fixture);
    expect(prompts[1]).toContain("# Round 2 of this ticket");
    expect(prompts[1]).not.toContain("reported **done**");
  });

  it("degrades the header when the previous round's outcome is unreadable", async () => {
    fixture = await runnerFixture();
    const first: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("round 1")]);
    await run(depsFor(fixture, first));

    // A volume whose committed run result no longer parses: the header says what it
    // still knows (which round) instead of inventing an outcome, and the round runs.
    await writeCommittedRun(fixture, { completedAt: "2026-10-26T05:26:00.000Z", payload: "not json" });

    const second: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("round 2")]);
    const outcome = await run(depsFor(fixture, second));

    expect(outcome.exitCode).toBe(0);
    const prompt = (await submittedPrompts(fixture))[1]!;
    expect(prompt).toContain("# Round 2 of this ticket");
    expect(prompt).toContain("already ran and reported its outcome");
    expect(prompt).not.toContain("reported **done**");
  });

  // The guard narrows to the closeout role (ADR-0017): a spent closeout volume can
  // only mean the App's reclaim did not happen, which must stay loud. The ticket
  // role's same shape is a normal path and starts a round instead.
  it("still refuses a new Job on a spent closeout volume", async () => {
    fixture = await runnerFixture();
    const env: RunnerEnv = { ...fixture.env, role: "implement-spec", workItem: { ...WORK_ITEM, number: 33 } };
    const first: Recorded = { events: [], results: [] };
    fixture.script([finishSpecCall({ prBody: "p" })]);
    await run(depsFor(fixture, first, { env }));

    // The Job object went away (its TTL) and a new one was created under the same
    // deterministic name: no annotation on this Job, a finished conversation on
    // the volume.
    const second: Recorded = { events: [], results: [] };
    const log: string[] = [];
    const outcome = await run(depsFor(fixture, second, { env, log: (line: string) => log.push(line) }));

    expect(outcome.exitCode).toBe(RUNNER_EXIT.fatal);
    // Nothing was pushed and nothing was annotated: the App reads a Failed Job, not
    // a Complete one with an empty result.
    expect(second.events).toEqual([]);
    expect(log.join("\n")).toContain("runner-refused");
    expect(log.join("\n")).toContain("spent-volume");
  });

  it("keeps exiting 0 when this Job's own annotation cannot be read", async () => {
    fixture = await runnerFixture();
    const first: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall()]);
    await run(depsFor(fixture, first));

    // An unreadable API is "cannot tell which Job this is". Failing the run would
    // FailJob a Job whose result may already have landed (ADR-0016).
    const second: Recorded = { events: [], results: [] };
    const outcome = await run(
      depsFor(fixture, second, {
        hasOwnRunResult: async () => {
          throw new Error("jobs.batch is unreachable");
        },
      }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(second.events).toEqual([]);

    // And it reset nothing (ADR-0017): "cannot tell" must not start a round nobody
    // asked for. The next Job still reads the round the volume actually carries —
    // `previous-outcome=done` is only knowable if the reset never happened, since a
    // reset clears the completed run and the result with it.
    const third: Recorded = { events: [], results: [] };
    const log: string[] = [];
    fixture.script([finishTicketCall("the real round 2")]);
    const thirdOutcome = await run(depsFor(fixture, third, { log: (line: string) => log.push(line) }));

    expect(thirdOutcome.exitCode).toBe(0);
    expect(third.results[0]).toMatchObject({ summary: "the real round 2" });
    expect(log.join("\n")).toContain("runner-round-start round=2 previous-outcome=done");
  });

  it("resumes an unfinished run instead of submitting a second one", async () => {
    fixture = await runnerFixture();
    const crashed: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall()]);

    // Process death right after the input was admitted, before any model request.
    await expect(
      run(
        depsFor(fixture, crashed, {
          crashAfterSubmit: () => {
            throw new Error("simulated crash");
          },
        }),
      ),
    ).rejects.toThrow(/simulated crash/);
    expect(crashed.events).toEqual([]);

    const resumed: Recorded = { events: [], results: [] };
    const outcome = await run(depsFor(fixture, resumed));
    expect(outcome.resumed).toBe(true);
    expect(resumed.events).toEqual(["push", "annotate"]);
    // Exactly one submitted prompt: the second process resumed the same conversation.
    const prompt = await submittedPrompt(fixture);
    expect(prompt).toContain("You are an unattended agent");
    // And it did not mint a retry key: a crash before the run settles is not a
    // settled failure, so the base dedup key is still what resumes it (ADR-0008).
    expect(await submissionRequestIds(fixture)).toEqual([`remote-agent:${WORK_ITEM.repo}#${WORK_ITEM.number}:implement-ticket`]);
  });

  it("keeps the ticket role's fixed point at the pre-work HEAD across a resume", async () => {
    fixture = await runnerFixture();
    const headBefore = await git(["rev-parse", "HEAD"], fixture.worktree);
    fixture.script([finishTicketCall()]);

    const crashed: Recorded = { events: [], results: [] };
    await expect(
      run(
        depsFor(fixture, crashed, {
          crashAfterSubmit: () => {
            throw new Error("simulated crash");
          },
        }),
      ),
    ).rejects.toThrow(/simulated crash/);
    const committed = await readDoc(fixture, ReviewFixedPointDoc);
    expect(committed).toMatchObject({ fixedPoint: headBefore, source: "run-start", branch: "agent/spec-33" });

    // Work happens between the crash and the new pod.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(fixture.worktree, "change.txt"), "work\n");
    await git(["add", "-A"], fixture.worktree);
    await git(["commit", "-m", "work"], fixture.worktree);
    const headAfterWork = await git(["rev-parse", "HEAD"], fixture.worktree);
    expect(headAfterWork).not.toBe(headBefore);

    const resumed: Recorded = { events: [], results: [] };
    await run(depsFor(fixture, resumed));
    // The committed value wins: resume never recomputes the fixed point.
    expect(await readDoc(fixture, ReviewFixedPointDoc)).toMatchObject({ fixedPoint: headBefore });
    // The work is what gets pushed.
    expect(await git(["rev-parse", "agent/spec-33"], fixture.remote)).toBe(headAfterWork);
  });

  it("takes the spec role's fixed point from the merge-base with origin/main", async () => {
    fixture = await runnerFixture();
    const env: RunnerEnv = { ...fixture.env, role: "implement-spec", workItem: { ...WORK_ITEM, number: 33 } };
    const recorded: Recorded = { events: [], results: [] };
    // No spec-role Result tools in this ticket: the run ends unanswered.
    await expect(run(depsFor(fixture, recorded, { env }))).rejects.toThrow(/without a Result tool/);
    const committed = await readDoc(fixture, ReviewFixedPointDoc);
    expect(committed).toMatchObject({ fixedPoint: await git(["rev-parse", "main"], fixture.worktree), source: "merge-base" });
    expect(recorded.events).toEqual([]);
  });

  /**
   * A run that settles `unanswered` (a model error, an abort) leaves a terminal
   * submission behind. The dedup key is fixed per ticket, so a later pod used to
   * find that dead submission and get its terminal outcome back instantly —
   * `run-failed` in 1–2 ms, forever, on a volume re-entry could not repair (#52).
   * A new pod must start a NEW run instead, so a transient provider error is not
   * a permanent per-ticket failure.
   */
  it("starts a new run when the previous one settled unanswered, instead of replaying its failure", async () => {
    fixture = await runnerFixture();
    const first: Recorded = { events: [], results: [] };
    // A NON-retryable provider error (a quota rejection, not a transient one):
    // it settles the run `unanswered` with `model_error` on the first attempt.
    fixture.script([fauxAssistantMessage([], { stopReason: "error", errorMessage: "insufficient_quota" })]);

    await expect(run(depsFor(fixture, first))).rejects.toThrow(/without a Result tool/);
    expect(first.events).toEqual([]);

    // The next pod is a real retry: it asks the model again and can still finish.
    const second: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("finished on the retry")]);
    const outcome = await run(depsFor(fixture, second));
    expect(outcome.resumed).toBe(false);
    expect(second.events).toEqual(["push", "annotate"]);
    expect(second.results[0]).toMatchObject({ outcome: "done", summary: "finished on the retry" });

    // And the retry is still round 1 (ADR-0017): a round is a run that **reported**,
    // and this conversation has reported nothing yet. Counting settled submissions
    // instead would hand the retry a header claiming a previous round already
    // reported an outcome — a lie the model has no way to check.
    const prompts = await submittedPrompts(fixture);
    expect(prompts[1]).not.toContain("# Round 2 of this ticket");
    expect(prompts[1]).not.toContain("already ran and reported");
  });

  /**
   * A retry that also dies of a model error must leave the next pod a way
   * forward too. The number counts settled attempts, so each failure moves the
   * key on by one instead of landing back on a settled one.
   */
  it("keeps moving the dedup key when a retry fails as well", { timeout: 30_000 }, async () => {
    fixture = await runnerFixture();
    const error = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "insufficient_quota" });

    for (let attempt = 0; attempt < 3; attempt++) {
      fixture.script([error()]);
      await expect(run(depsFor(fixture, { events: [], results: [] }))).rejects.toThrow(/without a Result tool/);
    }

    fixture.script([finishTicketCall("fourth time lucky")]);
    const outcome = await run(depsFor(fixture, { events: [], results: [] }));
    expect(outcome.resumed).toBe(false);
    expect(outcome.result).toMatchObject({ outcome: "done", summary: "fourth time lucky" });

    // One base key plus one retry key per dead run.
    const ids = await submissionRequestIds(fixture);
    expect(ids[0]).toBe(`remote-agent:${WORK_ITEM.repo}#${WORK_ITEM.number}:implement-ticket`);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids.slice(1)) expect(id).toMatch(/#retry-\d+$/);
  });

  /**
   * The attempt number counts settled **input** submissions only. pi-durable
   * admits compaction summaries as `type: "write"` on the same conversation and
   * settles them `done`; counting those would skip attempt numbers and point the
   * retry log at a compaction instead of at the run it is retrying.
   */
  it("ignores settled writes when numbering the retry key", { timeout: 30_000 }, async () => {
    fixture = await runnerFixture();
    // A settled `write` submission, the shape a compaction summary leaves behind.
    await appendSettledWrite(fixture);

    fixture.script([fauxAssistantMessage([], { stopReason: "error", errorMessage: "insufficient_quota" })]);
    await expect(run(depsFor(fixture, { events: [], results: [] }))).rejects.toThrow(/without a Result tool/);

    fixture.script([finishTicketCall()]);
    await run(depsFor(fixture, { events: [], results: [] }));

    const ids = await submissionRequestIds(fixture);
    // The write never becomes a run, so the first run still uses the base key and
    // the retry is #retry-1 — not #retry-2.
    expect(ids).toEqual([
      "compaction:seeded",
      `remote-agent:${WORK_ITEM.repo}#${WORK_ITEM.number}:implement-ticket`,
      `remote-agent:${WORK_ITEM.repo}#${WORK_ITEM.number}:implement-ticket#retry-1`,
    ]);
  });

  /**
   * The retry budget must outlast a gateway restart, not a blip. pi-durable's
   * default is 3 retries / 14 s of backoff, which a ~50 s `omniroute` restart
   * outlasts every time — that is what killed the 2026-10-24 and 10-25 runs. The
   * total is asserted, not just the field values, because it is the total that
   * has to clear the outage.
   */
  /**
   * A *retryable* provider error must not settle the run: the harness retries it
   * within the run, which is the whole point of the enlarged budget. The first
   * error is followed by a good response, and the run finishes — no new pod, no
   * new submission, no `unanswered`.
   */
  it("rides out a retryable provider error inside the same run", { timeout: 30_000 }, async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Connection error." }),
      finishTicketCall("survived the blip"),
    ]);

    const outcome = await run(depsFor(fixture, recorded));
    expect(outcome.resumed).toBe(false);
    expect(outcome.result).toMatchObject({ outcome: "done", summary: "survived the blip" });
    // One submission for the whole run: the retry happened inside it.
    expect(await submissionRequestIds(fixture)).toEqual([
      `remote-agent:${WORK_ITEM.repo}#${WORK_ITEM.number}:implement-ticket`,
    ]);
  });

  it("budgets generation retries against a gateway restart, not a blip", () => {
    const { maxRetries, baseDelayMs, maxAgentDelayMs } = GENERATION_RETRY_POLICY;
    const totalMs = Array.from({ length: maxRetries }, (_, i) => Math.min(baseDelayMs * 2 ** i, maxAgentDelayMs)).reduce(
      (sum, delay) => sum + delay,
      0,
    );
    // A liveness-driven restart took ~50 s on both incidents; 3x that is the bar.
    expect(totalMs).toBeGreaterThan(150_000);
    // A single wait stays short enough that a long outage is still visible as
    // attempts rather than as one silent stall.
    expect(maxAgentDelayMs).toBeLessThanOrEqual(60_000);
  });

  it("refuses a thinking level other than the pinned high", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall()]);
    await expect(
      run(depsFor(fixture, recorded, { env: { ...fixture.env, thinkingLevel: "low" } })),
    ).rejects.toThrow(/not the pinned level high/);
    expect(recorded.events).toEqual([]);
  });
});

/** Every user entry the volume carries, oldest first: the run's prompt, then a conflict turn's. */
/** A second clone of the bare remote, standing in for the ticket that pushed first. */
async function otherTicket(f: RunnerFixture): Promise<string> {
  const other = join(f.root, "other");
  await git(["clone", f.remote, other], f.root);
  await git(["checkout", "-B", "agent/spec-33", "origin/agent/spec-33"], other);
  return other;
}

/** `contested.txt` says one thing on the branch and another here: git cannot pick. */
async function contestedFile(f: RunnerFixture): Promise<string> {
  const other = await otherTicket(f);
  await writeFile(join(other, "contested.txt"), "theirs\n");
  await git(["add", "-A"], other);
  await git(["commit", "-m", "work contested.txt (another ticket)"], other);
  await git(["push", "origin", "HEAD:refs/heads/agent/spec-33"], other);
  await writeFile(join(f.worktree, "contested.txt"), "ours\n");
  await git(["add", "-A"], f.worktree);
  await git(["commit", "-m", "work contested.txt (this run)"], f.worktree);
  return other;
}

/**
 * The hand-off turn's work: the merged file, staged, and the rebase carried to its
 * end. With `rival`, another ticket pushes to the same file right after — the branch
 * moving again under a resolution that was already reported.
 */
function resolveConflictCall(options: { id?: string; rival?: string } = {}): ReturnType<typeof fauxAssistantMessage> {
  const rival = JSON.stringify(options.rival ?? "");
  const moved = options.rival === undefined ? "" :
    ` && cd ${rival} && printf 'theirs again\\n' > contested.txt && ` +
    "git -c user.email=test@example.com -c user.name=test commit -qam 'work contested.txt (another ticket, again)' && " +
    "git push -q origin HEAD:refs/heads/agent/spec-33";
  return fauxAssistantMessage(
    [
      fauxToolCall(
        "bash",
        { command: `printf 'both\\n' > contested.txt && git add contested.txt && git rebase --continue${moved}` },
        { id: options.id ?? "call-resolve" },
      ),
    ],
    { stopReason: "toolUse" },
  );
}

/** The real push, recorded so a test can see where it happened in the sequence. */
function realPush(f: RunnerFixture, recorded: { events: string[] }) {
  return async () => {
    recorded.events.push("push");
    return pushToSpecBranch({ env: f.env, paths: f.paths, log: () => {} });
  };
}

/**
 * The state a pod leaves when it dies between claiming a conflict hand-off and
 * submitting the turn: a committed run result plus a claimed, unreported hand-off.
 */
async function seedHandoffState(f: RunnerFixture, files: string[]): Promise<void> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(f.paths.sessionDatabase),
    { models: f.models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "omniroute", modelId: "default" }, thinkingLevel: "high" },
    });
    await root.commit(async (tx) => {
      const result = await tx.doc(RunResultDoc, root.id);
      result.payload = JSON.stringify({ v: 1, outcome: "done", summary: "first pass" });
      const handoff = await tx.doc(ConflictHandoffDoc, root.id);
      handoff.attemptedAt = "2026-01-01T00:00:00.000Z";
      handoff.files = files;
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

/**
 * A conflict is one file rewritten on both sides: git cannot pick a winner, and the
 * old push died here on purpose (#55). The agent that wrote one of the two sides is
 * the one that can pick — so the runner hands it the stopped rebase (#58).
 */
describe("runner: a conflicted push is resolved by the agent", () => {
  /**
   * The agent's shell has no `~/.gitconfig` (`HOME` is the volume's `home/`), and
   * `git rebase --continue` creates a commit: without the committer identity in the
   * environment it stops with "Author identity unknown", leaving the rebase stopped
   * and the run fatal on a resolution that worked. The image's own git config is
   * closed on purpose (`runGit()`), so this identity is the only one it can use.
   */
  it("hands the agent a committer identity, so the continued rebase can commit", async () => {
    fixture = await runnerFixture();
    await contestedFile(fixture);
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([
      finishTicketCall("first pass"),
      // Deliberately does NOT pass -c user.name/-c user.email: it relies on the
      // environment the runner gives the agent's shell.
      fauxAssistantMessage(
        [
          fauxToolCall(
            "bash",
            { command: "printf 'both\\n' > contested.txt && git add contested.txt && git rebase --continue" },
            { id: "call-resolve" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      finishTicketCall("resolved the conflict"),
    ]);

    const outcome = await run(depsFor(fixture, recorded, { push: realPush(fixture, recorded) }));

    expect(outcome.exitCode).toBe(0);
    expect(recorded.results[0]).toMatchObject({ summary: "resolved the conflict" });
    // The commit the resolution produced carries the bot identity the runner uses.
    expect(await git(["log", "-1", "--format=%cn <%ce>", "agent/spec-33"], fixture.remote)).toBe(
      `remote-agent[bot] <${fixture.env.commitEmail}>`,
    );
  });

  it("hands the stopped rebase over, then pushes and annotates the resolution", async () => {
    fixture = await runnerFixture();
    await contestedFile(fixture);
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([
      finishTicketCall("first pass"),
      resolveConflictCall(),
      finishTicketCall("resolved the conflict"),
    ]);

    const outcome = await run(depsFor(fixture, recorded, { push: realPush(fixture, recorded) }));

    expect(outcome.exitCode).toBe(0);
    // Push, one turn, push again, one annotation: the turn's report is what lands.
    expect(recorded.events).toEqual(["push", "push", "annotate"]);
    expect(recorded.results).toHaveLength(1);
    expect(recorded.results[0]).toMatchObject({ outcome: "done", summary: "resolved the conflict" });
    // Both sides landed on the branch, on the one file that conflicted.
    expect(await git(["show", "agent/spec-33:contested.txt"], fixture.remote)).toBe("both");
    // Exactly one extra submission, keyed apart from the run it reopens.
    expect(await submissionRequestIds(fixture)).toEqual([
      `remote-agent:${WORK_ITEM.repo}#${WORK_ITEM.number}:implement-ticket`,
      `remote-agent:${WORK_ITEM.repo}#${WORK_ITEM.number}:implement-ticket#conflict`,
    ]);
    // Its message says which rebase is stopped and on which paths.
    const prompts = await submittedPrompts(fixture);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("agent/spec-33");
    expect(prompts[1]).toContain("contested.txt");
  });

  it("finishes a claimed turn before pushing when the previous pod died before submitting it", async () => {
    fixture = await runnerFixture();
    await contestedFile(fixture);
    // The stopped rebase the crashed pod leaves behind: its push started it, its
    // claim recorded it, and it died before submitting the turn.
    await pushToSpecBranch({ env: fixture.env, paths: fixture.paths, log: () => {} });
    await seedHandoffState(fixture, ["contested.txt"]);
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([resolveConflictCall(), finishTicketCall("resolved the conflict")]);

    await run(depsFor(fixture, recorded, { push: realPush(fixture, recorded) }));

    // The turn came first: a push before it would push nothing and report the run done.
    expect(recorded.events).toEqual(["push", "annotate"]);
    expect(recorded.results[0]).toMatchObject({ summary: "resolved the conflict" });
    expect(await git(["show", "agent/spec-33:contested.txt"], fixture.remote)).toBe("both");
    // No second run was submitted: the claimed turn already exists.
    expect(await submissionRequestIds(fixture)).toEqual([
      `remote-agent:${WORK_ITEM.repo}#${WORK_ITEM.number}:implement-ticket#conflict`,
    ]);
  });

  it("fails when the turn reports without finishing the rebase", async () => {
    fixture = await runnerFixture();
    await contestedFile(fixture);
    const recorded: Recorded = { events: [], results: [] };
    // Two reports and no `git rebase --continue` in between.
    fixture.script([finishTicketCall("first pass"), finishTicketCall("claimed done")]);

    const error = await run(depsFor(fixture, recorded, { push: realPush(fixture, recorded) })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FatalPushError);
    expect(pushExitCodeFor(error)).toBe(RUNNER_EXIT.fatal);
    expect((error as Error).message).toMatch(/still stopped on a conflict/);
    // Nothing was pushed or annotated: the run's work never left the volume.
    expect(recorded.events).toEqual(["push"]);
    expect(recorded.results).toEqual([]);
  });

  it("goes fatal on the next pod too when the reported rebase is still stopped", async () => {
    fixture = await runnerFixture();
    await contestedFile(fixture);
    const first: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("first pass"), finishTicketCall("claimed done")]);
    await run(depsFor(fixture, first, { push: realPush(fixture, first) })).catch(() => {});

    const second: Recorded = { events: [], results: [] };
    const error = await run(depsFor(fixture, second, { push: realPush(fixture, second) })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FatalPushError);
    expect((error as Error).message).toMatch(/still stopped on a conflict/);
    // A reported hand-off is a spent budget: no model request, no push, no annotation.
    expect(fixture.pendingResponses()).toBe(0);
    expect(second.events).toEqual([]);
    expect(second.results).toEqual([]);
  });

  it("stops after the one resolution turn when the branch moves again underneath it", async () => {
    fixture = await runnerFixture();
    const rival = await contestedFile(fixture);
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([
      finishTicketCall("first pass"),
      resolveConflictCall({ rival }),
      finishTicketCall("resolved the conflict"),
    ]);

    const error = await run(depsFor(fixture, recorded, { push: realPush(fixture, recorded) })).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FatalPushError);
    expect(pushExitCodeFor(error)).toBe(RUNNER_EXIT.fatal);
    expect((error as Error).message).toMatch(/after the one resolution turn/);
    // One turn, two pushes, no annotation: the budget is one reported attempt.
    expect(recorded.events).toEqual(["push", "push"]);
    expect(recorded.results).toEqual([]);
    expect(await submissionRequestIds(fixture)).toHaveLength(2);
  });

  it("annotates `blocked` without pushing when the agent cannot resolve it", async () => {
    fixture = await runnerFixture();
    await contestedFile(fixture);
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("first pass"), blockedCall({ summary: "the two intents cannot both hold" })]);

    await run(depsFor(fixture, recorded, { push: realPush(fixture, recorded) }));

    // The rebase is still stopped, so pushing could only conflict again — and an
    // `error` would replace the agent's verdict.
    expect(recorded.events).toEqual(["push", "annotate"]);
    expect(recorded.results[0]).toMatchObject({ outcome: "blocked" });
  });
});

describe("runner: the scripted model drives real tool calls", () => {
  it("runs a bash tool call and finishes in the same run", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf hello > touched.txt" }, { id: "c1" })], {
        stopReason: "toolUse",
      }),
      finishTicketCall("wrote a file"),
    ]);

    await run(depsFor(fixture, recorded));
    expect(await readFile(join(fixture.worktree, "touched.txt"), "utf8")).toBe("hello");
    expect(recorded.events).toEqual(["push", "annotate"]);
  });
});
