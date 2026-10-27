import type { Runner } from "./harness.js";
import { NAMESPACE } from "./manifests.js";

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

/**
 * The prompt hatch's log assertions (ADR-0020). A run resolves the whole prompt
 * key surface and logs one `prompt-source=<key>:<image|override>` line per key;
 * those lines are the only evidence of where each key came from, so they are read
 * from the runner container's log and asserted per key.
 */

/** `prompt-source=<key>:<image|override>` — one line per resolved key (ADR-0020). */
export function promptSourceLine(key: string, source: "image" | "override"): string {
  return `prompt-source=${key}:${source}`;
}

/** The lines a run must carry: `override` for the one key the fixture holds, `image` for the rest. */
export function expectedPromptSources(promptKeys: readonly string[], overrideKey: string | null): string[] {
  return promptKeys.map((key) => promptSourceLine(key, key === overrideKey ? "override" : "image"));
}

/** The runner container's log text, or null when the pod is not up yet or the read failed. */
export async function readRunnerLogs(runner: Runner, context: string, jobName: string): Promise<string | null> {
  const result = await runner.run(
    "kubectl",
    ["--context", context, "-n", NAMESPACE, "logs", `job/${jobName}`, "-c", "runner"],
    { allowFailure: true },
  );
  return result.exitCode === 0 ? result.stdout : null;
}

/** The trimmed lines of a log, as a set for exact-line membership. */
export function logLines(logs: string): Set<string> {
  return new Set(logs.split("\n").map((line) => line.trim()));
}

/**
 * Poll a Job's runner log until it carries `line`.
 *
 * The runner resolves the whole prompt key surface before it does any work
 * (ADR-0020), so this returns early in the run — long before the App can create
 * the next ticket's Job, which is what makes deleting the override here safe. A
 * Job that reaches terminal without the line fails at once instead of waiting out
 * the timeout.
 */
export async function waitForPromptSource(
  runner: Runner,
  context: string,
  jobName: string,
  line: string,
  timeoutMs: number,
): Promise<void> {
  const observed = await poll<{ logs: string; job: K8sJobObject | null }>({
    description: `${jobName} runner logs ${line}`,
    timeoutMs,
    intervalMs: 1000,
    observe: async () => ({
      logs: (await readRunnerLogs(runner, context, jobName)) ?? "",
      job: await kubectlJson<K8sJobObject>(runner, context, NAMESPACE, "job", jobName),
    }),
    until: ({ logs, job }) => logLines(logs).has(line) || (job !== null && isJobFinished(job)),
    describe: ({ logs, job }) =>
      `${logs === "" ? "(no logs yet)" : `${logs.split("\n").length} lines`}; job ${job === null ? "absent" : "present"}`,
  });
  if (!logLines(observed.logs).has(line)) {
    throw new Error(`${jobName} finished without logging ${line}; the prompt override did not resolve`);
  }
}

/**
 * Assert a run's per-key prompt sources (ADR-0020). The override hatch is the
 * only path that can turn a key's source to `override`, so these lines are the
 * evidence that the optional volume, `PROMPTS_DIR` and the per-key fallback are
 * wired end to end — and that a deleted object yields an image-only run.
 */
export async function assertPromptSources(
  runner: Runner,
  context: string,
  jobName: string,
  overrideKey: string | null,
  promptKeys: readonly string[],
): Promise<void> {
  const logs = await readRunnerLogs(runner, context, jobName);
  if (logs === null) {
    throw new Error(`could not read ${jobName}'s runner logs to check the prompt sources`);
  }
  const lines = logLines(logs);
  const missing = expectedPromptSources(promptKeys, overrideKey).filter((line) => !lines.has(line));
  if (missing.length > 0) {
    throw new Error(
      `${jobName}'s runner logs are missing ${missing.join(", ")}; the prompt hatch did not resolve per key`,
    );
  }
  runner.note(
    overrideKey === null
      ? `${jobName}: every prompt key from the image`
      : `${jobName}: ${overrideKey} from the override, the rest from the image`,
  );
}
