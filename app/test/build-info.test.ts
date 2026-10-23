import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { APP_IMAGE_REPOSITORY, JOB_IMAGE, JOB_IMAGE_REPOSITORY, JOB_IMAGE_TAG } from "../src/build-info.js";
import { JOB_IMAGE as JOB_IMAGE_FROM_TEMPLATE } from "../src/job-image.js";

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("build info", () => {
  it("pins the two GHCR repositories and the development default tag", () => {
    expect(APP_IMAGE_REPOSITORY).toBe("ghcr.io/2017fighting/remote-agent");
    expect(JOB_IMAGE_REPOSITORY).toBe("ghcr.io/2017fighting/remote-agent-job");
    expect(JOB_IMAGE).toBe(`${JOB_IMAGE_REPOSITORY}:${JOB_IMAGE_TAG}`);
  });

  it("is the single source the Job template reads", () => {
    expect(JOB_IMAGE_FROM_TEMPLATE).toBe(JOB_IMAGE);
  });

  it("rewrites exactly one line, so the baked tag cannot drift from the Job image", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-agent-build-info-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const copy = join(root, "build-info.ts");
    await copyFile("app/src/build-info.ts", copy);

    const { stdout } = await exec("node", ["scripts/bake-build-info.mjs", "--tag", "v9.9.9", "--file", copy]);
    expect(stdout).toContain("v9.9.9");
    const baked = await readFile(copy, "utf8");
    expect(baked).toContain('export const JOB_IMAGE_TAG = "v9.9.9";');
    // Everything else — the repository constant, the composed reference — is untouched.
    expect(baked).toContain('export const JOB_IMAGE_REPOSITORY = "ghcr.io/2017fighting/remote-agent-job";');
    expect(baked).toContain("export const JOB_IMAGE = `${JOB_IMAGE_REPOSITORY}:${JOB_IMAGE_TAG}`;");
    expect(baked.match(/JOB_IMAGE_TAG = "/g)).toHaveLength(1);
  });

  it("rejects a tag that is not a docker tag, and a missing tag", async () => {
    await expect(exec("node", ["scripts/bake-build-info.mjs", "--tag", "not a tag"])).rejects.toThrow(
      /not a valid docker tag/,
    );
    await expect(exec("node", ["scripts/bake-build-info.mjs"])).rejects.toThrow(/usage:/);
  });
});
