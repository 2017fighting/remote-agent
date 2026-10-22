import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_JOB_BACKOFF_LIMIT,
  DEFAULT_JOB_PVC_SIZE,
  DEFAULT_JOB_TTL_SECONDS_AFTER_FINISHED,
  DEFAULT_MAX_JOBS_GLOBAL,
  DEFAULT_MAX_JOBS_PER_REPO,
  DEFAULT_RESYNC_INTERVAL_SECONDS,
  readAppConfig,
  type EnvSource,
} from "../src/config.js";

function env(entries: Record<string, string>): EnvSource {
  return entries;
}

describe("readAppConfig (App env read at startup)", () => {
  it("applies defaults when env is unset", () => {
    const config = readAppConfig(env({}));
    expect(config.resyncIntervalSeconds).toBe(DEFAULT_RESYNC_INTERVAL_SECONDS);
    expect(config.resyncIntervalSeconds).toBe(300);
    expect(config.maxJobsGlobal).toBe(DEFAULT_MAX_JOBS_GLOBAL);
    expect(config.maxJobsGlobal).toBe(3);
    expect(config.maxJobsPerRepo).toBe(DEFAULT_MAX_JOBS_PER_REPO);
    expect(config.maxJobsPerRepo).toBe(2);
    expect(config.githubApiBaseUrl).toBe("https://api.github.com");
    expect(config.gitBaseUrl).toBe("https://github.com");
  });

  it("applies the ADR-0010 / ADR-0012 Job budget defaults", () => {
    const config = readAppConfig(env({}));
    expect(config.jobPvcSize).toBe(DEFAULT_JOB_PVC_SIZE);
    expect(config.jobPvcSize).toBe("8Gi");
    expect(config.jobActiveDeadlineSeconds).toBe(DEFAULT_JOB_ACTIVE_DEADLINE_SECONDS);
    expect(config.jobActiveDeadlineSeconds).toBe(10800);
    expect(config.jobBackoffLimit).toBe(DEFAULT_JOB_BACKOFF_LIMIT);
    expect(config.jobBackoffLimit).toBe(4);
    expect(config.jobTtlSecondsAfterFinished).toBe(DEFAULT_JOB_TTL_SECONDS_AFTER_FINISHED);
    expect(config.jobTtlSecondsAfterFinished).toBe(1800);
    expect(config.namespace).toBe("remote-agent");
    expect(config.omniRouteBaseUrl).toBe("http://omniroute.omniroute.svc.cluster.local:20128/v1");
    // Empty is the documented default: the runner commits without the id prefix.
    expect(config.githubAppId).toBe("");
  });

  it("reads the four Job budget overrides and the deployment endpoints", () => {
    const config = readAppConfig(
      env({
        JOB_PVC_SIZE: "12Gi",
        JOB_ACTIVE_DEADLINE_SECONDS: "3600",
        JOB_BACKOFF_LIMIT: "2",
        JOB_TTL_SECONDS_AFTER_FINISHED: "600",
        NAMESPACE: "agents",
        OMNIROUTE_BASE_URL: "http://stub-model.svc/v1",
      }),
    );
    expect(config.jobPvcSize).toBe("12Gi");
    expect(config.jobActiveDeadlineSeconds).toBe(3600);
    expect(config.jobBackoffLimit).toBe(2);
    expect(config.jobTtlSecondsAfterFinished).toBe(600);
    expect(config.namespace).toBe("agents");
    expect(config.omniRouteBaseUrl).toBe("http://stub-model.svc/v1");
  });

  it("reads overrides from RESYNC_INTERVAL_SECONDS / MAX_JOBS_GLOBAL / MAX_JOBS_PER_REPO", () => {
    const config = readAppConfig(
      env({
        RESYNC_INTERVAL_SECONDS: "60",
        MAX_JOBS_GLOBAL: "5",
        MAX_JOBS_PER_REPO: "1",
        GITHUB_API_BASE_URL: "http://stub-github.svc",
        GIT_BASE_URL: "http://stub-git.svc",
        GITHUB_APP_ID: "5390512",
      }),
    );
    expect(config.resyncIntervalSeconds).toBe(60);
    expect(config.maxJobsGlobal).toBe(5);
    expect(config.maxJobsPerRepo).toBe(1);
    expect(config.githubApiBaseUrl).toBe("http://stub-github.svc");
    expect(config.gitBaseUrl).toBe("http://stub-git.svc");
    expect(config.githubAppId).toBe("5390512");
  });

  it("rejects a resync interval at or above the 1800s token renewal threshold (ADR-0014)", () => {
    expect(() => readAppConfig(env({ RESYNC_INTERVAL_SECONDS: "1800" }))).toThrow(/1800/);
    expect(() => readAppConfig(env({ RESYNC_INTERVAL_SECONDS: "3600" }))).toThrow(/threshold/);
  });

  it("rejects non-integer values", () => {
    expect(() => readAppConfig(env({ RESYNC_INTERVAL_SECONDS: "abc" }))).toThrow(/integer/);
    expect(() => readAppConfig(env({ MAX_JOBS_GLOBAL: "-1" }))).toThrow(/>= 0/);
  });
});
