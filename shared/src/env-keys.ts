/** Env keys read by the App at startup. Defaults live in code; env only overrides. */
export const APP_ENV_KEYS = {
  resyncIntervalSeconds: "RESYNC_INTERVAL_SECONDS",
  maxJobsGlobal: "MAX_JOBS_GLOBAL",
  maxJobsPerRepo: "MAX_JOBS_PER_REPO",
  jobPvcSize: "JOB_PVC_SIZE",
  jobActiveDeadlineSeconds: "JOB_ACTIVE_DEADLINE_SECONDS",
  jobBackoffLimit: "JOB_BACKOFF_LIMIT",
  jobTtlSecondsAfterFinished: "JOB_TTL_SECONDS_AFTER_FINISHED",
  githubApiBaseUrl: "GITHUB_API_BASE_URL",
  gitBaseUrl: "GIT_BASE_URL",
  /** OmniRoute base URL handed to every Job as `OMNIROUTE_BASE_URL` (docs/deployment.md §9). */
  omniRouteBaseUrl: "OMNIROUTE_BASE_URL",
  /** Namespace the App creates Jobs / Secrets / Ticket PVCs in. */
  namespace: "NAMESPACE",
  githubAppId: "GITHUB_APP_ID",
  githubAppClientId: "GITHUB_APP_CLIENT_ID",
  githubWebhookSecret: "GITHUB_WEBHOOK_SECRET",
  githubAppPrivateKey: "GITHUB_APP_PRIVATE_KEY",
} as const;

/** Env keys injected by the App into each agent Job. */
export const JOB_ENV_KEYS = {
  agentRole: "AGENT_ROLE",
  agentThinkingLevel: "AGENT_THINKING_LEVEL",
  agentWorkItem: "AGENT_WORK_ITEM",
  targetRepo: "TARGET_REPO",
  specNumber: "SPEC_NUMBER",
  gitBaseUrl: "GIT_BASE_URL",
  /** Clone URL the init container seeds from: `GIT_BASE_URL/<owner>/<name>.git`, composed by the App. */
  gitRemoteUrl: "GIT_REMOTE_URL",
  omniRouteBaseUrl: "OMNIROUTE_BASE_URL",
  omniRouteModel: "OMNIROUTE_MODEL",
  omniRouteReviewModel: "OMNIROUTE_REVIEW_MODEL",
  omniRouteApiKey: "OMNIROUTE_API_KEY",
} as const;
