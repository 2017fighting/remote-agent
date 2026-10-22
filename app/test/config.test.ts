import { describe, expect, it } from "vitest";
import {
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

  it("reads overrides from RESYNC_INTERVAL_SECONDS / MAX_JOBS_GLOBAL / MAX_JOBS_PER_REPO", () => {
    const config = readAppConfig(
      env({
        RESYNC_INTERVAL_SECONDS: "60",
        MAX_JOBS_GLOBAL: "5",
        MAX_JOBS_PER_REPO: "1",
        GITHUB_API_BASE_URL: "http://stub-github.svc",
        GIT_BASE_URL: "http://stub-git.svc",
      }),
    );
    expect(config.resyncIntervalSeconds).toBe(60);
    expect(config.maxJobsGlobal).toBe(5);
    expect(config.maxJobsPerRepo).toBe(1);
    expect(config.githubApiBaseUrl).toBe("http://stub-github.svc");
    expect(config.gitBaseUrl).toBe("http://stub-git.svc");
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
