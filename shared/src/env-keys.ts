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
  omniRouteBaseUrl: "OMNIROUTE_BASE_URL",
  omniRouteModel: "OMNIROUTE_MODEL",
  omniRouteReviewModel: "OMNIROUTE_REVIEW_MODEL",
  omniRouteApiKey: "OMNIROUTE_API_KEY",
  /** Bot identity for agent commits: `<GITHUB_APP_ID>+remote-agent[bot]@users.noreply.github.com` (ADR-0009). */
  githubAppId: "GITHUB_APP_ID",
  /** The Job's own name, from the downward API: the runner writes its run result on it (ADR-0007). */
  jobName: "JOB_NAME",
  /** The Job's namespace, from the downward API. */
  jobNamespace: "JOB_NAMESPACE",
} as const;
