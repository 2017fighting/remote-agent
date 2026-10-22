import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScheduler,
  formatPassLog,
  type PassCounters,
  type PassLog,
  type Trigger,
} from "../src/scheduler.js";
import type { AppConfig } from "../src/config.js";

/**
 * Scheduler semantics pinned by ADR-0014 (spec #33 §1):
 * - three wake sources land in the same reconcile(); startup does a list + one
 *   trigger=startup pass
 * - single-flight: at most one pass runs at a time
 * - depth-1 coalescing: triggers arriving during a pass merge into exactly one
 *   subsequent pass; depth stays 1, no event content is buffered
 * - a failed pass logs one line and never re-enqueues itself
 * - resync tick: interval from RESYNC_INTERVAL_SECONDS; tick reads nothing and
 *   holds no state
 */

const config: AppConfig = {
  resyncIntervalSeconds: 300,
  maxJobsGlobal: 3,
  maxJobsPerRepo: 2,
  githubApiBaseUrl: "https://api.github.com",
  gitBaseUrl: "https://github.com",
};

interface RecordedPass {
  trigger: Trigger;
  startedAt: number;
  finishedAt: number | null;
}

interface Harness {
  state: { githubReads: number };
  passes: RecordedPass[];
  lines: PassLog[];
  errors: Array<{ trigger: Trigger; error: unknown }>;
  scheduler: ReturnType<typeof createScheduler>;
  /** Resolve the gate the currently running pass is blocked on. */
  finishRunningPass: () => void;
}

function makeHarness(options?: { failOn?: Trigger }): Harness {
  const passes: RecordedPass[] = [];
  const lines: PassLog[] = [];
  const errors: Harness["errors"] = [];
  const state = { githubReads: 0 };
  let gate: (() => void) | null = null;
  const scheduler = createScheduler(config, {
    reconcile: async (trigger) => {
      passes.push({ trigger, startedAt: Date.now(), finishedAt: null });
      await new Promise<void>((resolve) => {
        gate = resolve;
      });
      const current = passes[passes.length - 1];
      if (current) current.finishedAt = Date.now();
      if (options?.failOn === trigger) throw new Error(`reconcile failed for ${trigger}`);
      return zeroCounters();
    },
    listIssues: async () => {
      state.githubReads++;
      return [];
    },
    onPassLog: (line) => lines.push(line),
    onPassError: (trigger, error) => errors.push({ trigger, error }),
  });
  return {
    state,
    passes,
    lines,
    errors,
    scheduler,
    finishRunningPass: () => {
      gate?.();
      gate = null;
    },
  };
}

function zeroCounters(): PassCounters {
  return { slotsUsed: 0, slotsMax: config.maxJobsGlobal, deferred: 0, renewed: 0, waiting: 0 };
}

/** Start the scheduler and release its blocked startup pass. */
async function startAndWait(h: Harness): Promise<void> {
  const startPromise = h.scheduler.start();
  await vi.advanceTimersByTimeAsync(0); // flush: list runs, startup pass starts and blocks
  h.finishRunningPass();
  await startPromise;
}

/** Wake and let the pass start, leaving it blocked (running). */
async function wakeRunning(h: Harness, trigger: Trigger): Promise<void> {
  h.scheduler.wake(trigger);
  await vi.advanceTimersByTimeAsync(0);
}

describe("scheduler single-flight and depth-1 coalescing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("startup does one list and exactly one trigger=startup pass", async () => {
    const h = makeHarness();
    await startAndWait(h);
    expect(h.passes.map((p) => p.trigger)).toEqual(["startup"]);
    expect(h.state.githubReads).toBe(1);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]!.trigger).toBe("startup");
  });

  it("each webhook while idle runs its own pass", async () => {
    const h = makeHarness();
    await startAndWait(h);
    await wakeRunning(h, "webhook");
    expect(h.passes).toHaveLength(2);
    h.finishRunningPass();
    await vi.advanceTimersByTimeAsync(0);
    await wakeRunning(h, "webhook");
    h.finishRunningPass();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.passes.map((p) => p.trigger)).toEqual(["startup", "webhook", "webhook"]);
  });

  it("multiple triggers during a running pass merge into exactly one subsequent pass (depth 1)", async () => {
    const h = makeHarness();
    await startAndWait(h);
    await wakeRunning(h, "webhook");
    expect(h.passes).toHaveLength(2);
    expect(h.passes[1]!.finishedAt).toBeNull(); // still running

    // Three triggers land while the pass is running.
    h.scheduler.wake("webhook");
    h.scheduler.wake("tick");
    h.scheduler.wake("webhook");
    await vi.advanceTimersByTimeAsync(1000); // still inside the running pass
    expect(h.passes).toHaveLength(2);

    h.finishRunningPass(); // running pass finishes, merged pass starts
    await vi.advanceTimersByTimeAsync(0);
    expect(h.passes).toHaveLength(3); // exactly one subsequent pass
    expect(h.passes[2]!.trigger).toBe("webhook"); // most recent trigger label
    h.finishRunningPass();
    await vi.advanceTimersByTimeAsync(10_000); // nothing pending remains
    expect(h.passes).toHaveLength(3);
  });

  it("a failed pass logs one line and never self-requeues", async () => {
    const h = makeHarness({ failOn: "webhook" });
    await startAndWait(h);
    await wakeRunning(h, "webhook");
    h.finishRunningPass(); // reconcile throws
    await vi.advanceTimersByTimeAsync(0);
    expect(h.passes.map((p) => p.trigger)).toEqual(["startup", "webhook"]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.trigger).toBe("webhook");

    await vi.advanceTimersByTimeAsync(60_000); // long after — no self-requeue
    expect(h.passes).toHaveLength(2);
    expect(h.errors).toHaveLength(1);

    // The next real trigger naturally recalculates.
    await wakeRunning(h, "tick");
    h.finishRunningPass();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.passes.map((p) => p.trigger)).toEqual(["startup", "webhook", "tick"]);
    expect(h.errors).toHaveLength(1);
  });

  it("a wake arriving during a failing pass still runs its merged pass once", async () => {
    const h = makeHarness({ failOn: "webhook" });
    await startAndWait(h);
    await wakeRunning(h, "webhook");
    h.scheduler.wake("tick"); // merged while the (failing) webhook pass runs
    h.finishRunningPass();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.passes.map((p) => p.trigger)).toEqual(["startup", "webhook", "tick"]);
    h.finishRunningPass();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.passes).toHaveLength(3); // the merged tick pass ran exactly once
  });

  it("resync tick fires at RESYNC_INTERVAL_SECONDS=300 and reads nothing between passes", async () => {
    const h = makeHarness();
    await startAndWait(h);
    await vi.advanceTimersByTimeAsync(299_000);
    expect(h.passes.filter((p) => p.trigger === "tick")).toHaveLength(0);
    expect(h.state.githubReads).toBe(1); // only the startup list

    await vi.advanceTimersByTimeAsync(1_000); // tick fires, pass starts and blocks
    expect(h.passes.filter((p) => p.trigger === "tick")).toHaveLength(1);
    h.finishRunningPass();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.githubReads).toBe(1); // the tick itself read nothing
  });

function release(gate: { resolve: (() => void) | null }): void {
  gate.resolve?.();
  gate.resolve = null;
}

  it("resync interval follows the configured value", async () => {
    const passes: RecordedPass[] = [];
    const gate: { resolve: (() => void) | null } = { resolve: null };
    const scheduler = createScheduler({ ...config, resyncIntervalSeconds: 60 }, {
      reconcile: async (trigger) => {
        passes.push({ trigger, startedAt: Date.now(), finishedAt: Date.now() });
        await new Promise<void>((resolve) => {
          gate.resolve = resolve;
        });
        return zeroCounters();
      },
      listIssues: async () => [],
      onPassLog: () => {},
      onPassError: () => {},
    });
    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    release(gate);
    await startPromise;

    await vi.advanceTimersByTimeAsync(59_000);
    expect(passes.filter((p) => p.trigger === "tick")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(passes.filter((p) => p.trigger === "tick")).toHaveLength(1);
    release(gate);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("a webhook arriving during the startup list serializes behind the startup pass (single-flight)", async () => {
    const passes: RecordedPass[] = [];
    const gates: Array<() => void> = [];
    let listGate: (() => void) | null = null;
    const listStarted = new Promise<void>((resolve) => {
      listGate = resolve;
    });
    const scheduler = createScheduler(config, {
      reconcile: async (trigger) => {
        passes.push({ trigger, startedAt: Date.now(), finishedAt: Date.now() });
        await new Promise<void>((resolve) => gates.push(resolve));
        return zeroCounters();
      },
      listIssues: async () => {
        listGate?.();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return [];
      },
      onPassLog: () => {},
      onPassError: () => {},
    });
    const startPromise = scheduler.start();
    await listStarted; // list in flight, startup pass not yet started
    scheduler.wake("webhook"); // arrives during the list
    await vi.advanceTimersByTimeAsync(0);
    // Exactly one pass is running; the other trigger holds the single pending slot.
    expect(passes).toHaveLength(1);
    const first = passes[0]!.trigger;
    expect(["startup", "webhook"]).toContain(first);
    for (const g of gates.splice(0)) g();
    await startPromise;
    // Both triggers ran exactly once, serialized, never concurrently.
    expect(passes.map((p) => p.trigger).sort()).toEqual(["startup", "webhook"]);
  });

  it("stop() ends the tick timer", async () => {
    const h = makeHarness();
    await startAndWait(h);
    h.scheduler.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.passes.filter((p) => p.trigger === "tick")).toHaveLength(0);
  });
});

describe("pass log line", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("formats one structured line per pass with trigger and five counters", () => {
    const line: PassLog = { trigger: "webhook", ...zeroCounters() };
    expect(formatPassLog(line)).toBe("pass trigger=webhook slots=0/3 deferred=0 renewed=0 waiting=0");
  });

  it("carries all five counters from the reconcile result", async () => {
    const lines: PassLog[] = [];
    const scheduler = createScheduler(config, {
      reconcile: async () => ({ slotsUsed: 2, slotsMax: 3, deferred: 1, renewed: 4, waiting: 5 }),
      listIssues: async () => [],
      onPassLog: (line) => lines.push(line),
      onPassError: () => {},
    });
    await scheduler.start();
    expect(formatPassLog(lines[0]!)).toBe(
      "pass trigger=startup slots=2/3 deferred=1 renewed=4 waiting=5",
    );
  });
});
