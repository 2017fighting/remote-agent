import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_EXIT } from "@remote-agent/shared";
import { MIN_FREE_BYTES, seed } from "../src/internal/seed.js";
import { run } from "../src/internal/runner.js";
import type { RunnerEnv } from "../src/internal/env.js";
import {
  cleanup,
  finishSpecCall,
  git,
  noOwnRunResult,
  openStorageFor,
  runnerFixture,
  WORK_ITEM,
  type RunnerFixture,
} from "./support/runner-fixture.js";

/**
 * The closeout round transition at the Job seam (ticket #60, ADR-0016), the
 * composition the bug report describes: the init container seeds, the runner
 * reports, and then the App starts the **next** round.
 *
 * Two things make the second round a round: the App reclaims the spent volume
 * (so the pod mounts an empty one — simulated here by removing the volume tree,
 * which is exactly what a recreated PVC is), and the runner refuses if it ever
 * finds itself on a volume whose round already reported. Together they turn
 * 「重新判断还剩什么」 from a no-op into a run.
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
    env: specEnv(f),
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

/** The spec's own run: the closeout role, on the spec's own number. */
function specEnv(f: RunnerFixture): RunnerEnv {
  return { ...f.env, role: "implement-spec", workItem: { ...WORK_ITEM, number: 33 } };
}

function seedDeps(f: RunnerFixture, log: string[]) {
  return {
    env: f.env,
    paths: f.paths,
    freeBytes: async () => MIN_FREE_BYTES * 2,
    log: (line: string) => log.push(line),
  };
}

describe("closeout round transition", () => {
  it("a reclaimed volume lets the next round really run and report", async () => {
    fixture = await runnerFixture();
    const firstLog: string[] = [];
    expect((await seed(seedDeps(fixture, firstLog))).exitCode).toBe(0);
    expect(firstLog.join("\n")).toContain("seeded repo=");

    const first: Recorded = { events: [], results: [] };
    fixture.script([finishSpecCall({ newTickets: [{ title: "follow-up", body: "b", readyForAgent: true }] })]);
    const firstOutcome = await run(depsFor(fixture, first));
    expect(firstOutcome.alreadyComplete).toBe(false);
    expect(first.events).toEqual(["push", "annotate"]);

    // The next round: the App reclaimed the spent volume, so the pod mounts an
    // empty one (ADR-0016). The TTL already removed the Job object, so this is a
    // new Job under the same deterministic name.
    await rm(join(fixture.root, "volume"), { recursive: true, force: true });
    const secondLog: string[] = [];
    expect((await seed(seedDeps(fixture, secondLog))).exitCode).toBe(0);
    // Seeded, not skipped: the marker went with the volume.
    expect(secondLog.join("\n")).toContain("seeded repo=");
    expect(secondLog.join("\n")).not.toContain("seed-skip");

    const second: Recorded = { events: [], results: [] };
    const runLog: string[] = [];
    fixture.script([finishSpecCall({ prBody: "## Summary\n\nnothing left" })]);
    const secondOutcome = await run(depsFor(fixture, second, { log: (line: string) => runLog.push(line) }));

    // The round happened: a fresh run, a push, a run result for the App to judge.
    expect(secondOutcome.alreadyComplete).toBe(false);
    expect(secondOutcome.exitCode).toBe(0);
    expect(second.events).toEqual(["push", "annotate"]);
    expect(second.results[0]).toMatchObject({ outcome: "done" });
    // Its review fixed point is re-derived for this round, not inherited from the
    // round that already reported.
    expect(runLog.join("\n")).toContain("source=merge-base");
  });

  it("without the reclaim the same round refuses instead of reporting nothing", async () => {
    fixture = await runnerFixture();
    expect((await seed(seedDeps(fixture, []))).exitCode).toBe(0);

    const first: Recorded = { events: [], results: [] };
    fixture.script([finishSpecCall({ prBody: "## Summary\n\nfirst" })]);
    await run(depsFor(fixture, first));

    // The Job object goes away, a new one appears under the same name, and the
    // volume is *not* reclaimed: the spent-volume shape of #60. The seed shows why
    // — the marker and the finished conversation are still on the volume.
    const skipped: string[] = [];
    expect((await seed(seedDeps(fixture, skipped))).exitCode).toBe(0);
    expect(skipped.join("\n")).toContain("seed-skip");

    const second: Recorded = { events: [], results: [] };
    const outcome = await run(depsFor(fixture, second));

    expect(outcome.exitCode).toBe(RUNNER_EXIT.fatal);
    expect(second.events).toEqual([]);
  });
});
