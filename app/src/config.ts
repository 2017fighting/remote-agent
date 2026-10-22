import { APP_ENV_KEYS } from "@remote-agent/shared";

/** App-side runtime configuration. Defaults live in code; env only overrides (spec #33 §4). */
export interface AppConfig {
  /** Resync tick interval in seconds; must stay below the 30-min token renewal threshold (ADR-0014). */
  resyncIntervalSeconds: number;
  /** Global Slot cap (MAX_JOBS_GLOBAL, load-bearing from #35). */
  maxJobsGlobal: number;
  /** Per-target-repo Slot cap (MAX_JOBS_PER_REPO, load-bearing from #35). */
  maxJobsPerRepo: number;
  githubApiBaseUrl: string;
  gitBaseUrl: string;
}

export const DEFAULT_RESYNC_INTERVAL_SECONDS = 300;
export const DEFAULT_MAX_JOBS_GLOBAL = 3;
export const DEFAULT_MAX_JOBS_PER_REPO = 2;
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_GIT_BASE_URL = "https://github.com";

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
    githubApiBaseUrl: env[APP_ENV_KEYS.githubApiBaseUrl]?.trim() || DEFAULT_GITHUB_API_BASE_URL,
    gitBaseUrl: env[APP_ENV_KEYS.gitBaseUrl]?.trim() || DEFAULT_GIT_BASE_URL,
  };
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
