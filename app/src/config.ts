import { APP_ENV_KEYS } from "@remote-agent/shared";

/**
 * App env keys that are not in the shared key index: the shared module is the
 * contract both workspaces read, and this ticket does not widen it (another
 * ticket owns that surface). Spellings follow `docs/deployment.md` §6 / §9.
 */
const APP_ONLY_ENV_KEYS = {
  namespace: "NAMESPACE",
  omniRouteBaseUrl: "OMNIROUTE_BASE_URL",
} as const;

/** App-side runtime configuration. Defaults live in code; env only overrides (spec #33 §4). */
export interface AppConfig {
  /** Resync tick interval in seconds; must stay below the 30-min token renewal threshold (ADR-0014). */
  resyncIntervalSeconds: number;
  /** Global Slot cap (MAX_JOBS_GLOBAL). */
  maxJobsGlobal: number;
  /** Per-target-repo Slot cap (MAX_JOBS_PER_REPO). */
  maxJobsPerRepo: number;
  githubApiBaseUrl: string;
  gitBaseUrl: string;
  /**
   * GitHub App id. Two readers: the Octokit constructor, and the Job env that
   * gives agent commits their bot identity (ADR-0009). Empty is a valid value —
   * the runner then commits as `remote-agent[bot]` without the id prefix.
   */
  githubAppId: string;
  /** Namespace Jobs / Secrets / Ticket PVCs are created in. */
  namespace: string;
  /** OmniRoute base URL injected into every Job (docs/deployment.md §9). */
  omniRouteBaseUrl: string;
  /** Ticket PVC capacity (JOB_PVC_SIZE, ADR-0010). */
  jobPvcSize: string;
  /** Job `activeDeadlineSeconds` (JOB_ACTIVE_DEADLINE_SECONDS, ADR-0010). */
  jobActiveDeadlineSeconds: number;
  /** Job `backoffLimit` (JOB_BACKOFF_LIMIT, ADR-0010). */
  jobBackoffLimit: number;
  /** Job `ttlSecondsAfterFinished` (JOB_TTL_SECONDS_AFTER_FINISHED, ADR-0012). */
  jobTtlSecondsAfterFinished: number;
  /**
   * How long one closeout round waits for the previous round's Ticket PVC to
   * actually disappear before giving up on the pass (ticket #85). Bounded on
   * purpose: the `pvc-protection` finalizer can hold a name for as long as a
   * pod is still releasing it, and a pass must never hang on that. Giving up is
   * a `failed` pass — no Job — and the next pass retries from world state.
   */
  pvcReclaimTimeoutMs: number;
}

export const DEFAULT_RESYNC_INTERVAL_SECONDS = 300;
export const DEFAULT_MAX_JOBS_GLOBAL = 3;
export const DEFAULT_MAX_JOBS_PER_REPO = 2;
export const DEFAULT_JOB_PVC_SIZE = "8Gi";
export const DEFAULT_JOB_ACTIVE_DEADLINE_SECONDS = 10800;
export const DEFAULT_JOB_BACKOFF_LIMIT = 4;
export const DEFAULT_JOB_TTL_SECONDS_AFTER_FINISHED = 1800;
/**
 * Ten seconds: comfortably longer than a released finalizer takes to clear, and
 * far shorter than the 300s resync tick, so a pass that gives up is retried by
 * the next tick rather than by a human.
 */
export const DEFAULT_PVC_RECLAIM_TIMEOUT_MS = 10_000;
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_GIT_BASE_URL = "https://github.com";
const DEFAULT_NAMESPACE = "remote-agent";
const DEFAULT_OMNIROUTE_BASE_URL = "http://omniroute.omniroute.svc.cluster.local:20128/v1";

export type EnvSource = Record<string, string | undefined>;

/** Read once at process startup; never re-read during a pass. */
export function readAppConfig(env: EnvSource = process.env): AppConfig {
  const resync = readPositiveInt(env, APP_ENV_KEYS.resyncIntervalSeconds, DEFAULT_RESYNC_INTERVAL_SECONDS);
  if (resync >= 1800) {
    // ADR-0014: interval must stay below the 1800s token renewal threshold.
    throw new Error(
      `${APP_ENV_KEYS.resyncIntervalSeconds}=${resync}s must be below the 1800s token renewal threshold`,
    );
  }
  return {
    resyncIntervalSeconds: resync,
    maxJobsGlobal: readNonNegativeInt(env, APP_ENV_KEYS.maxJobsGlobal, DEFAULT_MAX_JOBS_GLOBAL),
    maxJobsPerRepo: readNonNegativeInt(env, APP_ENV_KEYS.maxJobsPerRepo, DEFAULT_MAX_JOBS_PER_REPO),
    githubApiBaseUrl: readString(env, APP_ENV_KEYS.githubApiBaseUrl, DEFAULT_GITHUB_API_BASE_URL),
    gitBaseUrl: readString(env, APP_ENV_KEYS.gitBaseUrl, DEFAULT_GIT_BASE_URL),
    githubAppId: readString(env, APP_ENV_KEYS.githubAppId, ""),
    namespace: readString(env, APP_ONLY_ENV_KEYS.namespace, DEFAULT_NAMESPACE),
    omniRouteBaseUrl: readString(env, APP_ONLY_ENV_KEYS.omniRouteBaseUrl, DEFAULT_OMNIROUTE_BASE_URL),
    jobPvcSize: readString(env, APP_ENV_KEYS.jobPvcSize, DEFAULT_JOB_PVC_SIZE),
    jobActiveDeadlineSeconds: readPositiveInt(
      env,
      APP_ENV_KEYS.jobActiveDeadlineSeconds,
      DEFAULT_JOB_ACTIVE_DEADLINE_SECONDS,
    ),
    jobBackoffLimit: readNonNegativeInt(env, APP_ENV_KEYS.jobBackoffLimit, DEFAULT_JOB_BACKOFF_LIMIT),
    jobTtlSecondsAfterFinished: readNonNegativeInt(
      env,
      APP_ENV_KEYS.jobTtlSecondsAfterFinished,
      DEFAULT_JOB_TTL_SECONDS_AFTER_FINISHED,
    ),
    pvcReclaimTimeoutMs: readPositiveInt(
      env,
      APP_ENV_KEYS.pvcReclaimTimeoutMs,
      DEFAULT_PVC_RECLAIM_TIMEOUT_MS,
    ),
  };
}

function readString(env: EnvSource, key: string, fallback: string): string {
  return env[key]?.trim() || fallback;
}

function parseIntOrThrow(key: string, raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${key}=${raw} is not an integer`);
  return value;
}

function readPositiveInt(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return parseIntOrThrow(key, raw);
}

function readNonNegativeInt(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = parseIntOrThrow(key, raw);
  if (value < 0) throw new Error(`${key}=${value} must be >= 0`);
  return value;
}
