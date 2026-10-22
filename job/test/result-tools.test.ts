import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/internal/runner.js";
import { ReviewRoundDoc } from "../src/internal/run-docs.js";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { specBodyFor } from "../src/internal/runner.js";
import type { RunnerEnv } from "../src/internal/env.js";
import { findStandardsFiles } from "../src/internal/standards-files.js";
import type { RunResultV1 } from "@remote-agent/shared";
import {
  blockedCall,
  cleanup,
  codeReviewCall,
  finishSpecCall,
  finishTicketCall,
  git,
  implementerTools,
  openStorageFor,
  reviewerConversations,
  reviewerReport,
  runnerFixture,
  toolResults,
  WORK_ITEM,
  type RunnerFixture,
} from "./support/runner-fixture.js";

let fixture: RunnerFixture | undefined;
afterEach(async () => {
  await cleanup(fixture);
  fixture = undefined;
});

interface Recorded {
  events: string[];
  results: RunResultV1[];
}

function depsFor(f: RunnerFixture, recorded: Recorded, overrides: Record<string, unknown> = {}) {
  return {
    env: f.env,
    paths: f.paths,
    models: f.models,
    log: () => {},
    openStorage: openStorageFor(),
    annotate: async (result: RunResultV1) => {
      recorded.events.push("annotate");
      recorded.results.push(result);
    },
    push: async () => {
      recorded.events.push("push");
    },
    ...overrides,
  };
}

function specEnv(f: RunnerFixture, workItem = { ...WORK_ITEM, number: 33 }): RunnerEnv {
  return { ...f.env, role: "implement-spec", workItem };
}

/**
 * One review round as the scripted provider sees it: the implementer calls
 * `code_review`, then the two reviewer conversations answer (Spec axis first),
 * then the implementer self-reports.
 */
function reviewScript(fixedPoint: string, then: ReturnType<typeof finishTicketCall>[], reports = ["spec: ok", "standards: ok"]) {
  return [
    codeReviewCall(fixedPoint),
    reviewerReport(reports[0]!),
    reviewerReport(reports[1]!),
    ...then,
  ];
}

/** A commit on the working copy, so the review range is non-empty. */
async function commitWork(f: RunnerFixture, name: string): Promise<string> {
  await writeFile(join(f.worktree, name), "work\n");
  await git(["add", "-A"], f.worktree);
  await git(["commit", "-m", `work: ${name} (#40)`], f.worktree);
  return git(["rev-parse", "HEAD"], f.worktree);
}

describe("#40 role → tool table", () => {
  it("gives the ticket role finish_ticket + blocked and nothing else of the Result family", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall()]);
    await run(depsFor(fixture, recorded));

    const tools = await implementerTools(fixture);
    expect(tools).toContain("finish_ticket");
    expect(tools).toContain("blocked");
    expect(tools).not.toContain("finish_spec");
    expect(tools).toContain("code_review");
  });

  it("gives the spec role finish_spec + blocked and not finish_ticket", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([finishSpecCall()]);
    await run(depsFor(fixture, recorded, { env: specEnv(fixture) }));

    const tools = await implementerTools(fixture, specEnv(fixture));
    expect(tools).toContain("finish_spec");
    expect(tools).toContain("blocked");
    expect(tools).not.toContain("finish_ticket");
  });
});

describe("#40 a Result tool ends the run with one annotation", () => {
  it("finish_ticket writes outcome=done", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("delivered")]);
    const outcome = await run(depsFor(fixture, recorded));

    expect(outcome.exitCode).toBe(0);
    expect(recorded.events).toEqual(["push", "annotate"]);
    expect(recorded.results).toHaveLength(1);
    expect(recorded.results[0]).toMatchObject({ v: 1, outcome: "done", summary: "delivered" });
    expect(recorded.results[0]).not.toHaveProperty("reason");
  });

  it("finish_spec writes outcome=done with prBody, newTickets and warnings", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([
      finishSpecCall({
        prBody: "## Summary\nshape\n## Evidence\nok\n## Merge Danger\nDoor: two-way",
        newTickets: [{ title: "follow-up", body: "do the thing", readyForAgent: true }],
        warnings: ["out of scope: docs"],
      }),
    ]);
    await run(depsFor(fixture, recorded, { env: specEnv(fixture) }));

    expect(recorded.results).toHaveLength(1);
    expect(recorded.results[0]).toMatchObject({
      outcome: "done",
      prBody: "## Summary\nshape\n## Evidence\nok\n## Merge Danger\nDoor: two-way",
      newTickets: [{ title: "follow-up", body: "do the thing", readyForAgent: true }],
      warnings: ["out of scope: docs"],
    });
  });

  it("blocked writes outcome=blocked with both fields", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([blockedCall({ summary: "needs a decision", commentBody: "pick A or B" })]);
    await run(depsFor(fixture, recorded));

    expect(recorded.results).toHaveLength(1);
    expect(recorded.results[0]).toMatchObject({
      v: 1,
      outcome: "blocked",
      summary: "needs a decision",
      commentBody: "pick A or B",
    });
    expect(recorded.results[0]).not.toHaveProperty("prBody");
  });

  it("writes exactly one annotation when the model calls two Result tools in one round", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    // Both calls in a single assistant message: the round's results arrive together.
    const { fauxAssistantMessage, fauxToolCall } = await import("./support/runner-fixture.js");
    fixture.script([
      fauxAssistantMessage(
        [
          fauxToolCall("finish_ticket", { summary: "first" }, { id: "c1" }),
          fauxToolCall("blocked", { summary: "second", commentBody: "x" }, { id: "c2" }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    await run(depsFor(fixture, recorded));

    expect(recorded.results).toHaveLength(1);
    expect(recorded.results[0]).toMatchObject({ outcome: "done", summary: "first" });
  });
});

describe("#40 Result tool payloads are rejected by schema", () => {
  it.each([
    ["blocked without summary", { commentBody: "x" }],
    ["blocked without commentBody", { summary: "x" }],
  ])("rejects %s", async (_name, args) => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([
      (await import("./support/runner-fixture.js")).fauxAssistantMessage(
        [(await import("./support/runner-fixture.js")).fauxToolCall("blocked", args, { id: "c-bad" })],
        { stopReason: "toolUse" },
      ),
      finishTicketCall("recovered"),
    ]);
    const outcome = await run(depsFor(fixture, recorded));

    const rejected = (await toolResults(fixture)).find((result) => result.callId === "c-bad");
    expect(rejected?.isError).toBe(true);
    expect(rejected?.code).toBe("invalid_arguments");
    // The run recovers and still self-reports once.
    expect(outcome.result).toMatchObject({ outcome: "done", summary: "recovered" });
    expect(recorded.results).toHaveLength(1);
  });

  it("rejects finish_spec without prBody", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    const { fauxAssistantMessage, fauxToolCall } = await import("./support/runner-fixture.js");
    fixture.script([
      fauxAssistantMessage([fauxToolCall("finish_spec", { summary: "no pr body" }, { id: "c-nopr" })], {
        stopReason: "toolUse",
      }),
      finishSpecCall(),
    ]);
    await run(depsFor(fixture, recorded, { env: specEnv(fixture) }));

    const rejected = (await toolResults(fixture)).find((result) => result.callId === "c-nopr");
    expect(rejected?.isError).toBe(true);
    expect(recorded.results[0]).toHaveProperty("prBody");
  });

  it("rejects a newTickets element that is not {title, body, readyForAgent}", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    const { fauxAssistantMessage, fauxToolCall } = await import("./support/runner-fixture.js");
    fixture.script([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "finish_spec",
            { summary: "x", prBody: "y", newTickets: [{ title: "t", body: "b" }] },
            { id: "c-shape" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      finishSpecCall(),
    ]);
    await run(depsFor(fixture, recorded, { env: specEnv(fixture) }));

    const rejected = (await toolResults(fixture)).find((result) => result.callId === "c-shape");
    expect(rejected?.isError).toBe(true);
    expect(rejected?.code).toBe("invalid_arguments");
  });
});

describe("#40 code_review", () => {
  it("runs one reviewer conversation per axis whose tool table is exactly read/grep/bash", async () => {
    fixture = await runnerFixture();
    const fixedPoint = await git(["rev-parse", "HEAD"], fixture.worktree);
    await commitWork(fixture, "work.txt");
    const recorded: Recorded = { events: [], results: [] };
    fixture.script(reviewScript(fixedPoint, [finishTicketCall("reviewed")]));
    await run(depsFor(fixture, recorded, { standardsFiles: async () => ["AGENTS.md"] }));

    const reviewers = await reviewerConversations(fixture);
    expect(reviewers).toHaveLength(2);
    for (const reviewer of reviewers) {
      expect(reviewer.tools).toEqual(["read", "grep", "bash"]);
      expect(reviewer.tools).not.toContain("code_review");
      expect(reviewer.tools).not.toContain("finish_ticket");
      expect(reviewer.tools).not.toContain("blocked");
    }
  });

  it("injects the fixed point and the spec body into the Spec axis, and the standards list into the Standards axis", async () => {
    fixture = await runnerFixture();
    const fixedPoint = await git(["rev-parse", "HEAD"], fixture.worktree);
    await commitWork(fixture, "work.txt");
    const recorded: Recorded = { events: [], results: [] };
    fixture.script(reviewScript(fixedPoint, [finishTicketCall("reviewed")]));
    await run(
      depsFor(fixture, recorded, {
        env: { ...fixture.env, workItem: { ...WORK_ITEM, specBody: "SPEC BODY TEXT" } },
        standardsFiles: async () => ["CODING_STANDARDS.md", "CONTRIBUTING.md"],
      }),
    );

    const reviewers = await reviewerConversations(fixture);
    const spec = reviewers.find((reviewer) => reviewer.firstMessage.includes("# Spec axis"));
    const standards = reviewers.find((reviewer) => reviewer.firstMessage.includes("# Standards axis"));
    expect(spec).toBeDefined();
    expect(standards).toBeDefined();
    // Spec axis: its own template, the literal fixed point, the spec ref and body.
    expect(spec!.firstMessage).toContain(fixedPoint);
    expect(spec!.firstMessage).toContain("2017fighting/remote-agent#33");
    expect(spec!.firstMessage).toContain("SPEC BODY TEXT");
    // Standards axis: its own template plus the real list, no spec text.
    expect(standards!.firstMessage).toContain(fixedPoint);
    expect(standards!.firstMessage).toContain("CODING_STANDARDS.md");
    expect(standards!.firstMessage).toContain("CONTRIBUTING.md");
    expect(standards!.firstMessage).not.toContain("SPEC BODY TEXT");
  });

  it("scans the working copy for standards files and reports an empty table when there are none", async () => {
    fixture = await runnerFixture();
    expect(await findStandardsFiles(fixture.worktree)).toEqual([]);

    await writeFile(join(fixture.worktree, "CONTRIBUTING.md"), "be nice\n");
    await mkdir(join(fixture.worktree, "docs"), { recursive: true });
    await writeFile(join(fixture.worktree, "docs", "CODING_STANDARDS.md"), "types over comments\n");
    expect(await findStandardsFiles(fixture.worktree)).toEqual(["CONTRIBUTING.md", "docs/CODING_STANDARDS.md"]);

    const fixedPoint = await git(["rev-parse", "HEAD"], fixture.worktree);
    await commitWork(fixture, "work.txt");
    const recorded: Recorded = { events: [], results: [] };
    fixture.script(reviewScript(fixedPoint, [finishTicketCall("reviewed")]));
    await run(depsFor(fixture, recorded));

    const reviewers = await reviewerConversations(fixture);
    const standards = reviewers.find((reviewer) => reviewer.firstMessage.includes("# Standards axis"));
    expect(standards!.firstMessage).toContain("CONTRIBUTING.md");
    expect(standards!.firstMessage).toContain("docs/CODING_STANDARDS.md");
  });

  it("bounces a bad fixed point without creating a reviewer conversation", async () => {
    fixture = await runnerFixture();
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([codeReviewCall("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), finishTicketCall("no review")]);
    await run(depsFor(fixture, recorded));

    const bounced = (await toolResults(fixture)).find((result) => result.callId === "call-review");
    expect(bounced?.isError).toBe(true);
    expect(bounced?.text).toContain("does not resolve");
    expect(await reviewerConversations(fixture)).toEqual([]);
  });

  it("bounces an empty diff without creating a reviewer conversation", async () => {
    fixture = await runnerFixture();
    const head = await git(["rev-parse", "HEAD"], fixture.worktree);
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([codeReviewCall(head), finishTicketCall("no review")]);
    await run(depsFor(fixture, recorded));

    const bounced = (await toolResults(fixture)).find((result) => result.callId === "call-review");
    expect(bounced?.isError).toBe(true);
    expect(bounced?.text).toContain("empty");
    expect(await reviewerConversations(fixture)).toEqual([]);
  });

  it("errors on a second call in the same run and starts no third conversation", async () => {
    fixture = await runnerFixture();
    const fixedPoint = await git(["rev-parse", "HEAD"], fixture.worktree);
    await commitWork(fixture, "work.txt");
    const recorded: Recorded = { events: [], results: [] };
    fixture.script([
      ...reviewScript(fixedPoint, []),
      codeReviewCall(fixedPoint, "review-2"),
      finishTicketCall(),
    ]);
    await run(depsFor(fixture, recorded, { standardsFiles: async () => [] }));

    const second = (await toolResults(fixture)).find((result) => result.callId === "review-2");
    expect(second?.isError).toBe(true);
    expect(second?.text).toContain("review already ran");
    expect(await reviewerConversations(fixture)).toHaveLength(2);
  });

  it("takes exactly one round: review → fix commit → finish", async () => {
    fixture = await runnerFixture();
    const fixedPoint = await git(["rev-parse", "HEAD"], fixture.worktree);
    await commitWork(fixture, "work.txt");
    const recorded: Recorded = { events: [], results: [] };
    const { fauxAssistantMessage, fauxToolCall } = await import("./support/runner-fixture.js");
    fixture.script([
      ...reviewScript(fixedPoint, []),
      // The fix commit the agent makes after reading the reports.
      fauxAssistantMessage([fauxToolCall("bash", { command: "git commit --allow-empty -m 'fix: findings (#40)'" }, { id: "c-fix" })], {
        stopReason: "toolUse",
      }),
      finishTicketCall("reviewed and fixed"),
    ]);
    const outcome = await run(depsFor(fixture, recorded, { standardsFiles: async () => [] }));

    expect(outcome.result).toMatchObject({ outcome: "done", summary: "reviewed and fixed" });
    // One round = two reviewer conversations, and the scripted provider was not asked
    // for a second review.
    expect(await reviewerConversations(fixture)).toHaveLength(2);
    expect(fixture.pendingResponses()).toBe(0);
  });
});

describe("#40 the review round is durable", () => {
  it("records the round on the volume, so a later pod finds it taken", async () => {
    fixture = await runnerFixture();
    const fixedPoint = await git(["rev-parse", "HEAD"], fixture.worktree);
    await commitWork(fixture, "work.txt");
    const recorded: Recorded = { events: [], results: [] };
    // The pod dies after the Result tool committed but before the push landed.
    fixture.script(reviewScript(fixedPoint, [finishTicketCall()]));
    await expect(
      run(
        depsFor(fixture, recorded, {
          standardsFiles: async () => [],
          push: async () => {
            throw new Error("simulated push failure");
          },
        }),
      ),
    ).rejects.toThrow(/simulated push failure/);

    // What the next pod reads: the round is committed with the same fixed point, so
    // its `code_review` call bounces instead of fanning out a second time.
    const harness = await Harness.open(
      await openNodeSqliteStorage(fixture.paths.sessionDatabase),
      { models: fixture.models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      const round = await harness.snapshot(ReviewRoundDoc, root.id, BACKGROUND_CONTEXT);
      expect(round).toMatchObject({ fixedPoint, spec: "spec: ok", standards: "standards: ok" });
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
    expect(await reviewerConversations(fixture)).toHaveLength(2);
  });
});

describe("#40 prompt carrier", () => {
  const REPO_ROOT = join(import.meta.dirname, "..", "..");
  const KEYS = ["_common", "implement-ticket", "implement-spec", "review-standards", "review-spec"];

  it.each(KEYS)("ships %s as a ConfigMap key with no slash command", async (key) => {
    const text = await readFile(join(REPO_ROOT, "prompts", key), "utf8");
    expect(text.trim()).not.toBe("");
    // No slash command: durable has no such layer, so a `/implement` in a template
    // sends the model looking for a tool that does not exist (ADR-0004).
    expect(text).not.toMatch(/(^|\s)\/[a-z][a-z-]*/m);
  });

  it("keeps the two review templates free of sub-agent bans only where the tool table already holds", async () => {
    const ticket = await readFile(join(REPO_ROOT, "prompts", "implement-ticket"), "utf8");
    const spec = await readFile(join(REPO_ROOT, "prompts", "implement-spec"), "utf8");
    // The ban lives in the review templates (the fuse), not in the implementer ones.
    expect(ticket.toLowerCase()).not.toContain("sub-agent");
    expect(spec.toLowerCase()).not.toContain("sub-agent");
    for (const key of ["review-spec", "review-standards"]) {
      const text = await readFile(join(REPO_ROOT, "prompts", key), "utf8");
      expect(text.toLowerCase()).toContain("sub-agent");
    }
  });
});

describe("#40 the Spec axis' comparison surface", () => {
  it("uses the spec role's own body as the spec body", () => {
    expect(specBodyFor("implement-spec", { ...WORK_ITEM, body: "the spec" })).toBe("the spec");
  });

  it("prefers an explicit specBody for the ticket role", () => {
    expect(specBodyFor("implement-ticket", { ...WORK_ITEM, body: "the ticket", specBody: "the spec" })).toBe("the spec");
  });

  it("leaves a ticket run without a specBody empty rather than reusing the ticket body", () => {
    expect(specBodyFor("implement-ticket", { ...WORK_ITEM, body: "the ticket" })).toBe("");
  });

  it("reaches the reviewer through the real review-spec template: spec role uses its body", async () => {
    fixture = await runnerFixture();
    const fixedPoint = await git(["rev-parse", "HEAD"], fixture.worktree);
    await commitWork(fixture, "work.txt");
    const recorded: Recorded = { events: [], results: [] };
    const env = specEnv(fixture, { ...WORK_ITEM, number: 33, body: "THE SPEC BODY" });
    fixture.script(reviewScript(fixedPoint, [finishSpecCall()]));
    await run(depsFor(fixture, recorded, { env, standardsFiles: async () => [] }));

    const specAxis = (await reviewerConversations(fixture, env)).find((reviewer) =>
      reviewer.firstMessage.includes("# Spec axis"),
    );
    expect(specAxis!.firstMessage).toContain("2017fighting/remote-agent#33");
    expect(specAxis!.firstMessage).toContain("THE SPEC BODY");
  });

  it("reaches the reviewer through the real review-spec template: a ticket without specBody says so", async () => {
    fixture = await runnerFixture();
    const fixedPoint = await git(["rev-parse", "HEAD"], fixture.worktree);
    await commitWork(fixture, "work.txt");
    const recorded: Recorded = { events: [], results: [] };
    // The fixture's review-spec template renders {{spec_body}} verbatim; the real
    // template's own "no spec available" instruction is asserted against the file
    // in the prompt-carrier block, and the empty value is what reaches it here.
    const env = { ...fixture.env, workItem: { ...WORK_ITEM, body: "THE TICKET BODY" } };
    fixture.script(reviewScript(fixedPoint, [finishTicketCall()]));
    await run(depsFor(fixture, recorded, { env, standardsFiles: async () => [] }));

    const specAxis = (await reviewerConversations(fixture, env)).find((reviewer) =>
      reviewer.firstMessage.includes("# Spec axis"),
    );
    // Never the ticket body: the axis compares against the spec, and an empty body
    // makes the real template answer "no spec available" instead of a fake pass.
    expect(specAxis!.firstMessage).not.toContain("THE TICKET BODY");
    expect(specAxis!.firstMessage).toContain(fixedPoint);
  });
});
