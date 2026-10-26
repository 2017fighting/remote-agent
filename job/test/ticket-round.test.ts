import { afterEach, describe, expect, it } from "vitest";
import { MIN_FREE_BYTES, seed } from "../src/internal/seed.js";
import { run } from "../src/internal/runner.js";
import {
  cleanup,
  finishTicketCall,
  git,
  noOwnRunResult,
  openStorageFor,
  runnerFixture,
  submittedPrompts,
  WORK_ITEM,
  type RunnerFixture,
} from "./support/runner-fixture.js";

/**
 * The ticket round transition at the Job seam (ticket #62, ADR-0017), the
 * composition the bug report describes: the init container seeds, the runner
 * reports, the human reopens the ticket, and the next Job runs the next round.
 *
 * What makes the second round a round is the runner's round boundary — the volume
 * is deliberately the same one, because a ticket's conversation is the thing a
 * reopen is meant to continue (ADR-0011). The seed shows why the volume alone
 * cannot do it: the marker still matches, so it skips, and `state/` is untouched.
 */

let fixture: RunnerFixture | undefined;
afterEach(async () => {
  await cleanup(fixture);
  fixture = undefined;
});

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
      return { kind: "pushed" } as const;
    },
    hasOwnRunResult: noOwnRunResult,
    ...overrides,
  };
}

function seedDeps(f: RunnerFixture, log: string[]) {
  return {
    env: f.env,
    paths: f.paths,
    freeBytes: async () => MIN_FREE_BYTES * 2,
    log: (line: string) => log.push(line),
  };
}

describe("ticket round transition", () => {
  it("runs the reopened ticket's next round on its own volume, with the human's comment in the prompt", async () => {
    fixture = await runnerFixture();
    const firstSeed: string[] = [];
    expect((await seed(seedDeps(fixture, firstSeed))).exitCode).toBe(0);
    expect(firstSeed.join("\n")).toContain("seeded repo=");

    const first: Recorded = { events: [], results: [] };
    fixture.script([finishTicketCall("did the thing")]);
    const firstOutcome = await run(depsFor(fixture, first));
    expect(firstOutcome.alreadyComplete).toBe(false);
    expect(first.events).toEqual(["push", "annotate"]);

    // The human reopens the issue and writes what is wrong now. The Job object left
    // its retention window, so the next Claim reuses this very volume.
    const reopened = {
      ...WORK_ITEM,
      comments: [
        ...WORK_ITEM.comments,
        { author: "maintainer", body: "reopened: the CI job still fails", createdAt: "2026-10-26T05:44:00.000Z" },
      ],
    };
    const secondSeed: string[] = [];
    expect((await seed(seedDeps(fixture, secondSeed))).exitCode).toBe(0);
    // Seeded nothing: the marker matches and `state/` is not touched.
    expect(secondSeed.join("\n")).toContain("seed-skip");
    expect(secondSeed.join("\n")).not.toContain("seeded repo=");

    const second: Recorded = { events: [], results: [] };
    const log: string[] = [];
    fixture.script([finishTicketCall("fixed the CI job")]);
    const secondOutcome = await run(
      depsFor(fixture, second, { env: { ...fixture.env, workItem: reopened }, log: (line: string) => log.push(line) }),
    );

    // The round happened: a fresh run, a push, a result for the App to judge.
    expect(secondOutcome.exitCode).toBe(0);
    expect(secondOutcome.alreadyComplete).toBe(false);
    expect(second.events).toEqual(["push", "annotate"]);
    expect(second.results[0]).toMatchObject({ outcome: "done", summary: "fixed the CI job" });
    expect(log.join("\n")).toContain("runner-round-start round=2 previous-outcome=done");

    // Two rounds on one conversation: the previous round's history is in front of the
    // model, and the header tells it that is what it is looking at...
    const prompts = await submittedPrompts(fixture);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("# Round 2 of this ticket");
    // ...and the human's words are the point of the whole round.
    expect(prompts[1]).toContain("reopened: the CI job still fails");
    expect(prompts[0]).not.toContain("reopened: the CI job still fails");
  });
});
