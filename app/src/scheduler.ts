import type { AppConfig } from "./config.js";
import type { HoldoutReason } from "./planners/frontier.js";
import type { VolumeStats } from "./planners/pvc-steward.js";

/**
 * ADR-0014's three wake sources plus the startup pass. All three land in the same
 * `reconcile()`; `job-watch` is subscribed by `main.ts`, where ADDED and DELETED
 * both coalesce into a pass (DELETED is what re-opens the Claim-gate).
 */
export type Trigger = "webhook" | "job-watch" | "tick" | "startup";

export interface PassCounters {
  slotsUsed: number;
  slotsMax: number;
  deferred: number;
  renewed: number;
  waiting: number;
  /** Specs inside the gate with open sub-issues and an empty Frontier (ticket #47). */
  idle: number;
  /**
   * Specs whose closeout outcome is already consumed (they carry
   * `closeout-consumed`), waiting for the Job
   * object's `DELETED` event before a fresh closeout can start (ticket #49).
   */
  closeoutConsumed: number;
}

/**
 * Why one spec was idle: how many of its open sub-issues the Frontier skipped,
 * grouped by the action that would unblock each (ticket #47). `in-flight` only
 * needs the run to finish, `exit-marker` / `not-ready` / `open-blocker` need a
 * human, `unauthorized` needs the label, `job-object-present` needs the
 * `DELETED` event.
 */
export interface IdleSpec {
  spec: number;
  openSubIssues: number;
  reasons: Partial<Record<HoldoutReason, number>>;
}

export interface PassLog extends PassCounters {
  trigger: Trigger;
  /** One entry per idle spec, in spec order; each also gets its own `idle-spec` line. */
  idleReasons: IdleSpec[];
  /** Volume usage of the post-reclamation world; the pass log's last line (ADR-0011). */
  volumeStats: VolumeStats;
}

/**
 * One structured line per pass (ADR-0014):
 * `pass trigger=<t> slots=<used>/<max> deferred=<n> renewed=<n> waiting=<n>
 * closeout-consumed=<n> idle=<n>`.
 *
 * The four no-action counters are peers, and each names a different reason the
 * pass did nothing: `deferred` = out of Slots, `waiting` = a lingering Job
 * object holding a ticket, `closeout-consumed` = a lingering Job object whose
 * outcome was already acted on, `idle` = in the gate with an empty Frontier.
 * `idle`'s reason needs the per-spec line below, because it is not one thing.
 */
export function formatPassLog(line: PassLog): string {
  return (
    `pass trigger=${line.trigger} slots=${line.slotsUsed}/${line.slotsMax}` +
    ` deferred=${line.deferred} renewed=${line.renewed} waiting=${line.waiting}` +
    ` closeout-consumed=${line.closeoutConsumed} idle=${line.idle}`
  );
}

/**
 * The `idle` counter's detail line (ticket #47), one per idle spec:
 * `idle-spec spec=<n> open-sub-issues=<n> reasons=<reason>:<n>,…`
 *
 * Reasons are ordered by descending count, then name, so the same world always
 * prints the same line. A spec with no reason at all is not idle, so `reasons`
 * is never empty.
 */
export function formatIdleSpecLog(entry: IdleSpec): string {
  const reasons = Object.entries(entry.reasons)
    .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
  return `idle-spec spec=${entry.spec} open-sub-issues=${entry.openSubIssues} reasons=${reasons}`;
}

/**
 * The pass's last line (ADR-0011): live volume count / oldest expiry / this
 * spec's usage. Delete-policy volumes are invisible to `pv-audit` and the
 * provenance labels take them out of `pvc-audit`, so this line is the only
 * leak signal the App produces itself.
 */
export function formatVolumeStatsLog(stats: VolumeStats): string {
  const perSpec = stats.perSpec.map((entry) => `spec${entry.spec}=${entry.count}`).join(",");
  return (
    `volumes live=${stats.live} oldest-expiry=${stats.oldestExpiry ?? "none"}` +
    ` per-spec=${perSpec === "" ? "none" : perSpec}`
  );
}

export interface SchedulerDeps {
  /** The single reconcile() every wake source lands in. Returns the pass counters for the log line. */
  reconcile: (
    trigger: Trigger,
  ) => Promise<PassCounters & { idleReasons: IdleSpec[]; volumeStats: VolumeStats }>;
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
      const { volumeStats, ...counters } = await deps.reconcile(trigger);
      deps.onPassLog({ trigger, ...counters, volumeStats });
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
