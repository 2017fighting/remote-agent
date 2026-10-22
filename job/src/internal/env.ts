import { JOB_ENV_KEYS, VOLUME_PATHS, JOB_MOUNT_PATHS, specBranch, parseWorkItem, type WorkItemV1 } from "@remote-agent/shared";

export type EnvSource = Record<string, string | undefined>;

/** Thrown for any startup validation failure: the runner exits nonzero before doing any work. */
export class StartupError extends Error {}

/**
 * Every key the runner cannot work without. All are checked at startup, so a
 * missing `OMNIROUTE_*` fails the pod immediately instead of surfacing as a
 * provider error at the first model request (spec #33 §6.1).
 */
export const REQUIRED_RUNNER_ENV_KEYS = [
  JOB_ENV_KEYS.agentRole,
  JOB_ENV_KEYS.agentThinkingLevel,
  JOB_ENV_KEYS.agentWorkItem,
  JOB_ENV_KEYS.targetRepo,
  JOB_ENV_KEYS.specNumber,
  JOB_ENV_KEYS.gitBaseUrl,
  JOB_ENV_KEYS.omniRouteBaseUrl,
  JOB_ENV_KEYS.omniRouteModel,
  JOB_ENV_KEYS.omniRouteReviewModel,
  JOB_ENV_KEYS.omniRouteApiKey,
  JOB_ENV_KEYS.githubAppId,
  JOB_ENV_KEYS.jobName,
  JOB_ENV_KEYS.jobNamespace,
] as const;

/** The seed needs only enough to build a remote URL, a branch and a commit identity. */
export const REQUIRED_SEED_ENV_KEYS = [
  JOB_ENV_KEYS.targetRepo,
  JOB_ENV_KEYS.specNumber,
  JOB_ENV_KEYS.gitBaseUrl,
  JOB_ENV_KEYS.githubAppId,
] as const;

export type AgentRole = "implement-ticket" | "implement-spec";

export interface SeedEnv {
  /** `owner/name`. */
  repo: string;
  specNumber: number;
  branch: string;
  /** Clean https remote, no token (ADR-0009). */
  remoteUrl: string;
  /** `<app-id>+remote-agent[bot]@users.noreply.github.com`. */
  commitEmail: string;
}

export interface RunnerEnv extends SeedEnv {
  role: AgentRole;
  thinkingLevel: string;
  workItem: WorkItemV1;
  omniRoute: {
    baseUrl: string;
    model: string;
    reviewModel: string;
    apiKey: string;
  };
  jobName: string;
  jobNamespace: string;
}

const ROLES: readonly string[] = ["implement-ticket", "implement-spec"];

function missingKeys(env: EnvSource, keys: readonly string[]): string[] {
  return keys.filter((key) => (env[key] ?? "").trim() === "");
}

/** Fail once, with every missing key, so a broken Job template takes one pod to diagnose. */
export function requireEnv(env: EnvSource, keys: readonly string[]): void {
  const missing = missingKeys(env, keys);
  if (missing.length > 0) throw new StartupError(`missing required env: ${missing.join(", ")}`);
}

function readPositiveInt(env: EnvSource, key: string): number {
  const raw = (env[key] ?? "").trim();
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new StartupError(`${key}=${raw} is not a positive integer`);
  return value;
}

export function gitRemoteUrl(gitBaseUrl: string, repo: string): string {
  return `${gitBaseUrl.replace(/\/+$/, "")}/${repo}.git`;
}

export function commitIdentity(appId: string): { name: string; email: string } {
  return { name: "remote-agent[bot]", email: `${appId}+remote-agent[bot]@users.noreply.github.com` };
}

export function readSeedEnv(env: EnvSource): SeedEnv {
  requireEnv(env, REQUIRED_SEED_ENV_KEYS);
  const repo = env[JOB_ENV_KEYS.targetRepo]!.trim();
  if (!repo.includes("/")) throw new StartupError(`${JOB_ENV_KEYS.targetRepo}=${repo} is not owner/name`);
  const specNumber = readPositiveInt(env, JOB_ENV_KEYS.specNumber);
  return {
    repo,
    specNumber,
    branch: specBranch(specNumber),
    remoteUrl: gitRemoteUrl(env[JOB_ENV_KEYS.gitBaseUrl]!, repo),
    commitEmail: commitIdentity(env[JOB_ENV_KEYS.githubAppId]!).email,
  };
}

export function readRunnerEnv(env: EnvSource): RunnerEnv {
  requireEnv(env, REQUIRED_RUNNER_ENV_KEYS);
  const seed = readSeedEnv(env);
  const role = env[JOB_ENV_KEYS.agentRole]!.trim();
  if (!ROLES.includes(role)) throw new StartupError(`${JOB_ENV_KEYS.agentRole}=${role} is not a known agent role`);
  let workItem: WorkItemV1;
  try {
    workItem = parseWorkItem(env[JOB_ENV_KEYS.agentWorkItem]!);
  } catch (error) {
    throw new StartupError(`${JOB_ENV_KEYS.agentWorkItem}: ${(error as Error).message}`);
  }
  if (workItem.repo !== seed.repo) {
    throw new StartupError(
      `${JOB_ENV_KEYS.agentWorkItem} repo ${workItem.repo} does not match ${JOB_ENV_KEYS.targetRepo} ${seed.repo}`,
    );
  }
  return {
    ...seed,
    role: role as AgentRole,
    thinkingLevel: env[JOB_ENV_KEYS.agentThinkingLevel]!.trim(),
    workItem,
    omniRoute: {
      baseUrl: env[JOB_ENV_KEYS.omniRouteBaseUrl]!.trim(),
      model: env[JOB_ENV_KEYS.omniRouteModel]!.trim(),
      reviewModel: env[JOB_ENV_KEYS.omniRouteReviewModel]!.trim(),
      apiKey: env[JOB_ENV_KEYS.omniRouteApiKey]!,
    },
    jobName: env[JOB_ENV_KEYS.jobName]!.trim(),
    jobNamespace: env[JOB_ENV_KEYS.jobNamespace]!.trim(),
  };
}

/** Where the Job reads and writes on the Ticket PVC, plus the two non-PVC mounts. */
export interface JobPaths {
  repo: string;
  state: string;
  home: string;
  seedMarker: string;
  seedError: string;
  sessionDatabase: string;
  prompts: string;
  token: string;
}

export function jobPaths(overrides: Partial<JobPaths> = {}): JobPaths {
  return {
    repo: VOLUME_PATHS.repo,
    state: VOLUME_PATHS.state,
    home: VOLUME_PATHS.home,
    seedMarker: VOLUME_PATHS.seedMarker,
    seedError: VOLUME_PATHS.seedError,
    sessionDatabase: VOLUME_PATHS.sessionDatabase,
    prompts: JOB_MOUNT_PATHS.prompts,
    token: JOB_MOUNT_PATHS.token,
    ...overrides,
  };
}
