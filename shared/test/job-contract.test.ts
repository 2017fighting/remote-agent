import { describe, expect, it } from "vitest";
import { isSeedMarkerV1, SEED_EXIT, SEED_FAILURE_KINDS } from "../src/seed.js";
import { isWorkItemV1, parseWorkItem } from "../src/work-item.js";
import { JOB_ENV_KEYS } from "../src/env-keys.js";
import { JOB_MOUNT_PATHS, VOLUME_PATHS } from "../src/paths.js";

describe("seed contract", () => {
  it("pins the two exit codes podFailurePolicy keys on", () => {
    expect(SEED_EXIT.retryable).toBe(75);
    expect(SEED_EXIT.fatal).toBe(78);
  });

  it("pins the five failure classes", () => {
    expect(SEED_FAILURE_KINDS).toEqual(["auth", "repo_unreachable", "ref_missing", "disk", "unknown"]);
  });

  it("recognises the seed marker", () => {
    const marker = {
      v: 1,
      repo: "2017fighting/remote-agent",
      branch: "agent/spec-33",
      seedSha: "a".repeat(40),
      seededAt: "2026-01-01T00:00:00.000Z",
    };
    expect(isSeedMarkerV1(marker)).toBe(true);
    expect(isSeedMarkerV1({ ...marker, v: 2 })).toBe(false);
    expect(isSeedMarkerV1({ ...marker, branch: undefined })).toBe(false);
  });
});

describe("work item contract", () => {
  const item = {
    v: 1,
    repo: "2017fighting/remote-agent",
    number: 39,
    specNumber: 33,
    title: "Job image",
    body: "do the thing",
    comments: [{ author: "me", body: "hi", createdAt: "2026-01-01T00:00:00.000Z" }],
  };

  it("accepts work item v1", () => {
    expect(isWorkItemV1(item)).toBe(true);
    expect(parseWorkItem(JSON.stringify(item)).number).toBe(39);
  });

  it("rejects a payload that does not match v1", () => {
    expect(() => parseWorkItem("not json")).toThrow(/not valid JSON/);
    expect(() => parseWorkItem(JSON.stringify({ ...item, v: 2 }))).toThrow(/does not match/);
    expect(() => parseWorkItem(JSON.stringify({ ...item, repo: "no-slash" }))).toThrow(/does not match/);
  });
});

describe("job mounts and env keys added by the runner", () => {
  it("separates the prompt and token mounts from the Ticket PVC", () => {
    expect(JOB_MOUNT_PATHS.prompts).toBe("/mnt/prompts");
    expect(JOB_MOUNT_PATHS.token).toBe("/mnt/credentials/token");
    expect(VOLUME_PATHS.sessionDatabase).toBe("/mnt/agent/state/session.sqlite");
  });

  it("names the downward-API and bot-identity keys", () => {
    expect(JOB_ENV_KEYS.jobName).toBe("JOB_NAME");
    expect(JOB_ENV_KEYS.jobNamespace).toBe("JOB_NAMESPACE");
    expect(JOB_ENV_KEYS.githubAppId).toBe("GITHUB_APP_ID");
  });
});
