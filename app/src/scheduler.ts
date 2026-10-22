import type { AppConfig } from "./config.js";

/** ADR-0014 wake sources. The `job-watch` source arrives in a later ticket; its slot exists now so the log line vocabulary is stable. */
export type Trigger = "webhook" | "job-watch" | "tick" | "startup";

export interface PassCounters {
  slotsUsed: number;
  slotsMax: number;
  deferred: number;
  renewed: number;
  waiting: number;
}

export interface PassLog extends PassCounters {
  trigger: Trigger;
}

/** One structured line per pass (ADR-0014): `pass trigger=<t> slots=<used>/<max> deferred=<n> renewed=<n> waiting=<n>`. */
export function formatPassLog(line: PassLog): string {
  return (
    `pass trigger=${line.trigger} slots=${line.slotsUsed}/${line.slotsMax}` +
    ` deferred=${line.deferred} renewed=${line.renewed} waiting=${line.waiting}`
  );
}

export interface SchedulerDeps {
  /** The single reconcile() every wake source lands in. Returns the pass counters for the log line. */
  reconcile: (trigger: Trigger) => Promise<PassCounters>;
  /** The startup list (trigger=startup does a list + one pass; ADR-0014). */
  listIssues: () => Promise<unknown[]>;
  onPassLog: (line: PassLog) => void;
  /** A failed pass logs one line here and is never re-enqueued (ADR-0014). */
  onPassError: (trigger: Trigger, error: unknown) => void;
}

export interface Scheduler {
  /** Any wake source's signal: webhook delivery, job watch event, or resync tick. */
  wake(trigger: Trigger): void;
  /** Startup: one list + one trigger=startup pass, then arm the resync tick. */
  start(): Promise<void>;
  stop(): void;
}

/**
 * Single-flight scheduler with depth-1 coalescing (ADR-0014): at most one pass
 * runs at a time; triggers arriving during a pass merge into exactly one
 * subsequent pass. Depth is always 1 — it is a coalesce flag, not a buffer, and
 * no trigger content is stored. Holds no control-plane state between passes
 * (ADR-0001): the only fields are the flight and the single pending trigger.
 */
export function createScheduler(config: AppConfig, deps: SchedulerDeps): Scheduler {
  let flight: Promise<void> | null = null;
  let pending: Trigger | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let started = false;

  function wake(trigger: Trigger): void {
    if (flight) {
      pending = trigger;
      return;
    }
    flight = runPass(trigger).then(() => {
      flight = null;
      const next = pending;
      pending = null;
      if (next) wake(next);
    });
  }

  async function runPass(trigger: Trigger): Promise<void> {
    try {
      const counters = await deps.reconcile(trigger);
      deps.onPassLog({ trigger, ...counters });
    } catch (error) {
      // A failed pass logs one line and is never re-enqueued (ADR-0014); the
      // next real trigger — at the latest the tick — naturally recalculates.
      deps.onPassError(trigger, error);
    }
  }

  return {
    wake,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      await deps.listIssues();
      // Route startup through wake() so it serializes with any trigger that
      // arrived while the startup list was in flight.
      wake("startup");
      await flight;
      tickTimer = setInterval(() => wake("tick"), config.resyncIntervalSeconds * 1000);
    },
    stop(): void {
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = null;
    },
  };
}
