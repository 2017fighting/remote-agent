import { afterEach, describe, expect, it } from "vitest";
import {
  assertPromptSources,
  clearFailFast,
  expectedPromptSources,
  failRunFast,
  poll,
  promptSourceLine,
} from "../src/assertions.js";
import type { Runner } from "../src/harness.js";

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

/**
 * The prompt hatch's per-key source assertion (ADR-0020, tickets #76/#78). The
 * kind e2e is the only place the wired hatch runs for real, and this environment
 * has no cluster — so the assertion that reads the runner's log is pinned here,
 * against a fake `Runner` that answers `kubectl logs`.
 */
describe("prompt-source assertions", () => {
  const KEYS = ["_common", "implement-spec", "implement-ticket", "review-spec", "review-standards"];

  /** A `Runner` whose `kubectl logs` answers `logs` and whose notes are collected. */
  function fakeRunner(logs: string | null): { runner: Runner; notes: string[] } {
    const notes: string[] = [];
    const runner = {
      async run() {
        return {
          command: "kubectl logs",
          exitCode: logs === null ? 1 : 0,
          stdout: logs ?? "",
          stderr: logs === null ? "NotFound" : "",
        };
      },
      note: (message: string) => notes.push(message),
      write: () => {},
      section: () => {},
      text: () => "",
    } as unknown as Runner;
    return { runner, notes };
  }

  it("expects `override` for the fixture key and `image` for every other key", () => {
    expect(expectedPromptSources(KEYS, "_common")).toEqual([
      "prompt-source=_common:override",
      "prompt-source=implement-spec:image",
      "prompt-source=implement-ticket:image",
      "prompt-source=review-spec:image",
      "prompt-source=review-standards:image",
    ]);
    // No override object in the world: every key must come from the image.
    expect(expectedPromptSources(KEYS, null)).toEqual(KEYS.map((key) => promptSourceLine(key, "image")));
  });

  it("passes when the log carries every expected line, and narrates which world it saw", async () => {
    const { runner, notes } = fakeRunner(expectedPromptSources(KEYS, "_common").join("\n"));

    await assertPromptSources(runner, "kind-ra-e2e", "agent-x-76", "_common", KEYS);

    expect(notes).toEqual(["agent-x-76: _common from the override, the rest from the image"]);
  });

  it("fails naming the missing lines when a key fell back to the image-only world", async () => {
    const { runner } = fakeRunner(expectedPromptSources(KEYS, null).join("\n"));

    await expect(assertPromptSources(runner, "kind-ra-e2e", "agent-x-76", "_common", KEYS)).rejects.toThrow(
      /missing prompt-source=_common:override/,
    );
  });

  it("fails when the runner's log cannot be read at all", async () => {
    const { runner } = fakeRunner(null);

    await expect(assertPromptSources(runner, "kind-ra-e2e", "agent-x-76", null, KEYS)).rejects.toThrow(
      /could not read agent-x-76's runner logs/,
    );
  });
});
