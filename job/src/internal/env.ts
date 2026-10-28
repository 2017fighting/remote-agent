import {
  JOB_ENV_KEYS,
  VOLUME_PATHS,
  JOB_MOUNT_PATHS,
  IMAGE_PROMPTS_DIR,
  jobName,
  specBranch,
  parseWorkItem,
  type WorkItemV1,
} from "@remote-agent/shared";
import { readFile } from "node:fs/promises";

export type EnvSource = Record<string, string | undefined>;

/** Thrown for any startup validation failure: the runner exits nonzero before doing any work. */
export class StartupError extends Error {}

/**
 * The Job env surface the App's template emits (spec #33 §4, docs/deployment.md
 * §6). Every one of these is checked at startup, so a broken Job template fails
 * the pod immediately instead of at the first model request.
 */
export const REQUIRED_SEED_ENV_KEYS = [
  JOB_ENV_KEYS.targetRepo,
  JOB_ENV_KEYS.specNumber,
  JOB_ENV_KEYS.gitRemoteUrl,
] as const;

export const REQUIRED_RUNNER_ENV_KEYS = [
  JOB_ENV_KEYS.agentRole,
  JOB_ENV_KEYS.agentThinkingLevel,
  JOB_ENV_KEYS.agentWorkItem,
  JOB_ENV_KEYS.targetRepo,
  JOB_ENV_KEYS.specNumber,
  JOB_ENV_KEYS.gitRemoteUrl,
  JOB_ENV_KEYS.omniRouteBaseUrl,
  JOB_ENV_KEYS.omniRouteModel,
  JOB_ENV_KEYS.omniRouteReviewModel,
  JOB_ENV_KEYS.omniRouteApiKey,
] as const;

export type AgentRole = "implement-ticket" | "implement-spec";

export interface SeedEnv {
  /** `owner/name`. */
  repo: string;
  specNumber: number;
  branch: string;
  /** Clean https clone URL composed by the App; never carries the token (ADR-0009). */
  remoteUrl: string;
  /** `<app-id>+remote-agent[bot]@users.noreply.github.com`, or the bot address without an app id. */
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
  /** The Job whose `remote-agent/run-result` annotation this run writes. */
  jobName: string;
  jobNamespace: string;
  /**
   * `PROMPTS_DIR`: an incident override directory (ADR-0020). The template always
   * emits it; an empty value means image-only, which the runner tests use.
   */
  promptsDir?: string;
}

const ROLES: readonly string[] = ["implement-ticket", "implement-spec"];

/** Fail once, with every missing key, so a broken Job template takes one pod to diagnose. */
export function requireEnv(env: EnvSource, keys: readonly string[]): void {
  const missing = keys.filter((key) => (env[key] ?? "").trim() === "");
  if (missing.length > 0) throw new StartupError(`missing required env: ${missing.join(", ")}`);
}

function readPositiveInt(env: EnvSource, key: string): number {
  const raw = (env[key] ?? "").trim();
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new StartupError(`${key}=${raw} is not a positive integer`);
  return value;
}

/**
 * Commit identity is the App's bot identity (ADR-0009). It only affects how
 * commits are attributed, so a Job without `GITHUB_APP_ID` still commits — it
 * just loses the app id prefix.
 */
export function commitIdentity(appId: string | undefined): { name: string; email: string } {
  const prefix = (appId ?? "").trim();
  return {
    name: "remote-agent[bot]",
    email: `${prefix === "" ? "" : `${prefix}+`}remote-agent[bot]@users.noreply.github.com`,
  };
}

/** The Job name is deterministic (spec #33 §0), so the runner never needs it in env. */
export function deriveJobName(env: EnvSource, repo: string, issueNumber: number): string {
  const fromEnv = (env[JOB_ENV_KEYS.jobName] ?? "").trim();
  return fromEnv === "" ? jobName(repo, issueNumber) : fromEnv;
}

/** The pod's own namespace, from the ServiceAccount mount the kubelet always provides. */
export async function readServiceAccountNamespace(path = SERVICE_ACCOUNT_NAMESPACE_PATH): Promise<string> {
  return (await readFile(path, "utf8")).trim();
}

export const SERVICE_ACCOUNT_NAMESPACE_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

export function readSeedEnv(env: EnvSource): SeedEnv {
  requireEnv(env, REQUIRED_SEED_ENV_KEYS);
  const repo = env[JOB_ENV_KEYS.targetRepo]!.trim();
  if (!repo.includes("/")) throw new StartupError(`${JOB_ENV_KEYS.targetRepo}=${repo} is not owner/name`);
  const specNumber = readPositiveInt(env, JOB_ENV_KEYS.specNumber);
  return {
    repo,
    specNumber,
    branch: specBranch(specNumber),
    remoteUrl: env[JOB_ENV_KEYS.gitRemoteUrl]!.trim(),
    commitEmail: commitIdentity(env[JOB_ENV_KEYS.githubAppId]).email,
  };
}

export function readRunnerEnv(env: EnvSource, namespace: string): RunnerEnv {
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
  const jobNamespace = (env[JOB_ENV_KEYS.jobNamespace] ?? "").trim() || namespace;
  if (jobNamespace === "") throw new StartupError("the Job namespace is neither in env nor in the ServiceAccount mount");
  const promptsDir = (env[JOB_ENV_KEYS.promptsDir] ?? "").trim();
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
    jobName: deriveJobName(env, seed.repo, role === "implement-spec" ? seed.specNumber : workItem.number),
    jobNamespace,
    ...(promptsDir === "" ? {} : { promptsDir }),
  };
}

/**
 * Where the Job reads and writes on the Ticket PVC, the non-PVC mounts, and the
 * image's canonical prompt directory (ADR-0020).
 */
export interface JobPaths {
  repo: string;
  state: string;
  home: string;
  seedMarker: string;
  seedError: string;
  sessionDatabase: string;
  /** The canonical prompt directory baked into the Job image (ADR-0020). */
  imagePrompts: string;
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
    imagePrompts: IMAGE_PROMPTS_DIR,
    token: JOB_MOUNT_PATHS.token,
    ...overrides,
  };
}
