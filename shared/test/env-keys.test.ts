import { describe, expect, it } from "vitest";
import { APP_ENV_KEYS, JOB_ENV_KEYS } from "../src/env-keys.js";

describe("env keys", () => {
  it("pins the App env key surface", () => {
    expect(APP_ENV_KEYS.resyncIntervalSeconds).toBe("RESYNC_INTERVAL_SECONDS");
    expect(APP_ENV_KEYS.maxJobsGlobal).toBe("MAX_JOBS_GLOBAL");
    expect(APP_ENV_KEYS.maxJobsPerRepo).toBe("MAX_JOBS_PER_REPO");
    expect(APP_ENV_KEYS.jobPvcSize).toBe("JOB_PVC_SIZE");
    expect(APP_ENV_KEYS.jobActiveDeadlineSeconds).toBe("JOB_ACTIVE_DEADLINE_SECONDS");
    expect(APP_ENV_KEYS.jobBackoffLimit).toBe("JOB_BACKOFF_LIMIT");
    expect(APP_ENV_KEYS.jobTtlSecondsAfterFinished).toBe("JOB_TTL_SECONDS_AFTER_FINISHED");
    expect(APP_ENV_KEYS.githubApiBaseUrl).toBe("GITHUB_API_BASE_URL");
    expect(APP_ENV_KEYS.gitBaseUrl).toBe("GIT_BASE_URL");
  });

  it("pins the Job env key surface", () => {
    expect(JOB_ENV_KEYS.agentRole).toBe("AGENT_ROLE");
    expect(JOB_ENV_KEYS.agentThinkingLevel).toBe("AGENT_THINKING_LEVEL");
    expect(JOB_ENV_KEYS.agentWorkItem).toBe("AGENT_WORK_ITEM");
    expect(JOB_ENV_KEYS.targetRepo).toBe("TARGET_REPO");
    expect(JOB_ENV_KEYS.specNumber).toBe("SPEC_NUMBER");
    expect(JOB_ENV_KEYS.gitBaseUrl).toBe("GIT_BASE_URL");
    expect(JOB_ENV_KEYS.omniRouteBaseUrl).toBe("OMNIROUTE_BASE_URL");
    expect(JOB_ENV_KEYS.omniRouteModel).toBe("OMNIROUTE_MODEL");
    expect(JOB_ENV_KEYS.omniRouteReviewModel).toBe("OMNIROUTE_REVIEW_MODEL");
    expect(JOB_ENV_KEYS.omniRouteApiKey).toBe("OMNIROUTE_API_KEY");
  });
});
