import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { GENERATION_RETRY_POLICY, run } from "../src/internal/runner.js";
import { ReviewFixedPointDoc } from "../src/internal/fixed-point-doc.js";
import { readRunnerEnv, StartupError, type RunnerEnv } from "../src/internal/env.js";
import { runRunner } from "../src/runner.js";
import {
  cleanup,
  finishTicketCall,
  fauxAssistantMessage,
  fauxToolCall,
  git,
  openStorageFor,
  runnerFixture,
  WORK_ITEM,
  type RunnerFixture,
} from "./support/runner-fixture.js";

let fixture: RunnerFixture | undefined;
afterEach(async () => {
  await cleanup(fixture);
  fixture = undefined;
});

/** Everything the runner does to the outside world, in order. */
interface Recorded {
  events: string[];
  results: unknown[];
}

function depsFor(f: RunnerFixture, recorded: Recorded, overrides: Partial<Parameters<typeof run>[0]> = {}) {
  return {
    env: f.env,
    paths: f.paths,
    models: f.models,
    log: () => {},
    openStorage: openStorageFor(),
    annotate: async (result: unknown) => {
      recorded.events.push("annotate");
      recorded.results.push(result);
    },
    push: async () => {
      recorded.events.push("push");
      await git(["push", "origin", "HEAD:refs/heads/agent/spec-33"], f.worktree);
    },
    ...overrides,
  };
}

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
async function submittedPrompt(f: RunnerFixture): Promise<string> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(f.paths.sessionDatabase),
    { models: f.models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const page = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const user = page.items.find((entry) => entry.kind === "pi.user");
    const message = user?.model?.[0] as { content?: unknown } | undefined;
    const content = message?.content;
    return typeof content === "string" ? content : JSON.stringify(content);
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

  it("does nothing at all when the volume already carries a finished run", async () => {
    fixture = await runnerFixture();
    const first: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall()]);
    expect((await run(depsFor(fixture, first))).alreadyComplete).toBe(false);

    const second: Recorded = { events: [], results: [] };
    const outcome = await run(depsFor(fixture, second));
    expect(outcome.alreadyComplete).toBe(true);
    expect(second.events).toEqual([]);
    // No new model request: the scripted response from the first run was not consumed again.
    expect(fixture.pendingResponses()).toBe(0);
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
