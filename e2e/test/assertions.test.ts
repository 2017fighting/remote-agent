import { afterEach, describe, expect, it } from "vitest";
import { clearFailFast, failRunFast, poll } from "../src/assertions.js";

/**
 * `failRunFast` is how a background watcher ends a run that has already become
 * meaningless — the case it was added for is a restarted `stub-github`, whose
 * in-memory world rolls back every write the App made. The latch has to outrank
 * whatever assertion is in flight: without it the run waits out its timeout and
 * reports a downstream effect instead of the cause (ticket #69).
 */
describe("failRunFast", () => {
  afterEach(() => clearFailFast());

  it("makes the next poll throw the watcher's error instead of timing out", async () => {
    failRunFast(new Error("stub-github restarted (restarts=0 → 1)"));

    let observations = 0;
    await expect(
      poll({
        description: "the closeout Job exists and finished",
        timeoutMs: 5_000,
        intervalMs: 1,
        observe: async () => {
          observations += 1;
          return null;
        },
        until: () => false,
      }),
    ).rejects.toThrow("stub-github restarted");

    // The latch is checked before reading: a run that cannot mean anything must
    // not keep talking to the cluster to find out.
    expect(observations).toBe(0);
  });

  it("keeps the first failure, so the earliest cause is the one reported", async () => {
    failRunFast(new Error("the first thing that went wrong"));
    failRunFast(new Error("a later symptom"));

    await expect(
      poll({
        description: "anything",
        timeoutMs: 5_000,
        intervalMs: 1,
        observe: async () => null,
        until: () => false,
      }),
    ).rejects.toThrow("the first thing that went wrong");
  });

  it("lets polls run normally once the latch is cleared", async () => {
    failRunFast(new Error("stale"));
    clearFailFast();

    const value = await poll({
      description: "a value that arrives",
      timeoutMs: 5_000,
      intervalMs: 1,
      observe: async () => "ready",
      until: (observed) => observed === "ready",
    });
    expect(value).toBe("ready");
  });
});
