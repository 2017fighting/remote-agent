import type { Runner } from "./harness.js";

/**
 * Bounded polling for the kind e2e (ticket #41: "prefer polling with bounded
 * timeouts over fixed sleeps").
 *
 * Every assertion is a predicate over cluster state read through kubectl, polled
 * until it holds or the deadline passes. On timeout the predicate's last
 * observation is reported, so the failure says what the world looked like when
 * the harness gave up rather than only that time ran out.
 */

export class AssertionTimeout extends Error {
  constructor(
    readonly description: string,
    readonly lastObservation: string,
    readonly elapsedMs: number,
  ) {
    super(
      `timed out after ${Math.round(elapsedMs / 1000)}s waiting for: ${description}\n` +
        `last observation: ${lastObservation}`,
    );
  }
}

export interface PollOptions<T> {
  description: string;
  timeoutMs: number;
  intervalMs?: number;
  /** Read the current observation; throw to report a read failure as the observation. */
  observe(): Promise<T>;
  /** True when the observation satisfies the assertion. */
  until(value: T): boolean;
  /** How to render an observation in a failure message. */
  describe?(value: T): string;
}

/**
 * A background watcher's verdict, latched so the next poll reports it instead of
 * whatever it happened to be waiting for. Reserved for failures that invalidate
 * the whole run — a restarted stub whose world is in memory — where the
 * alternative is a five-minute timeout naming a downstream effect.
 */
let fatal: Error | null = null;

/** Record a failure that ends the run: the next `poll` throws it, untouched. */
export function failRunFast(error: Error): void {
  fatal ??= error;
}

/** Forget a latched failure (teardown, and tests that latch one on purpose). */
export function clearFailFast(): void {
  fatal = null;
}

/**
 * Thrown when the App reports its own failure while we wait for a downstream
 * effect. Polling a timeout after the App has already said why it failed wastes
 * minutes and buries the cause, so this short-circuits with the App's words.
 */
export class AppReportedFailure extends Error {
  constructor(readonly appError: string) {
    super(`the App reported a pass failure: ${appError}`);
    this.name = "AppReportedFailure";
  }
}

/** Poll `observe` until `until` is true, or throw `AssertionTimeout`. */
export async function poll<T>(options: PollOptions<T>): Promise<T> {
  const started = Date.now();
  const interval = options.intervalMs ?? 1000;
  let last: T | undefined;
  let lastText = "(never observed)";
  let lastError: unknown;

  for (;;) {
    // A latched failure outranks this assertion: whatever it is waiting for
    // cannot become true, and its timeout would name the wrong thing.
    if (fatal !== null) throw fatal;
    try {
      last = await options.observe();
      lastText = options.describe?.(last) ?? JSON.stringify(last);
      lastError = undefined;
      if (options.until(last)) return last;
    } catch (error) {
      lastError = error;
      lastText = `read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (Date.now() - started >= options.timeoutMs) {
      throw new AssertionTimeout(
        options.description,
        lastError === undefined ? lastText : `${lastText} (last error: ${String(lastError)})`,
        Date.now() - started,
      );
    }
    await delay(interval);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `kubectl get <resource> -o json`, parsed; `null` when the object is absent. */
export async function kubectlJson<T>(
  runner: Runner,
  context: string,
  namespace: string,
  resource: string,
  name?: string,
): Promise<T | null> {
  const args = ["--context", context, "-n", namespace, "get", resource, ...(name === undefined ? [] : [name]), "-o", "json"];
  const result = await runner.run("kubectl", args, { allowFailure: true });
  if (result.exitCode !== 0) {
    if (/NotFound|not found/.test(result.stderr)) return null;
    throw new Error(`kubectl get ${resource} ${name ?? ""} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as T;
}

/** The minimal k8s shapes the assertions read. */
export interface K8sObjectList<T> {
  items: T[];
}

export interface K8sJobObject {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  status?: { conditions?: Array<{ type: string; status: string; reason?: string }> };
}

export interface K8sPodObject {
  metadata: { name: string; ownerReferences?: Array<{ kind: string; name: string }> };
  status?: { phase?: string; containerStatuses?: Array<{ name: string; state?: Record<string, unknown> }> };
}

export interface K8sPvcObject {
  metadata: { name: string; annotations?: Record<string, string>; labels?: Record<string, string> };
}

export interface K8sDeploymentObject {
  metadata: { name: string };
  status?: { readyReplicas?: number; availableReplicas?: number; conditions?: Array<{ type: string; status: string }> };
}

/** True when the Job reached Complete or Failed (the only terminal signals, architecture §4.1). */
export function isJobFinished(job: K8sJobObject): boolean {
  const conditions = job.status?.conditions ?? [];
  return conditions.some(
    (condition) => condition.status === "True" && (condition.type === "Complete" || condition.type === "Failed"),
  );
}

export function jobTerminalReason(job: K8sJobObject): string | undefined {
  const conditions = job.status?.conditions ?? [];
  return conditions.find((condition) => condition.status === "True" && condition.type === "Failed")?.reason;
}
