import { describe, expect, it } from "vitest";
import { bakedJobImageFromDeclarations, describeGithubSide, githubSideIsFinal } from "../src/run.js";
import type { StubState } from "../src/run.js";
import { SPEC_NUMBER, TICKET_NUMBERS } from "../src/scenario.js";

/**
 * The harness's Job-image guard reads the reference the App image bakes into
 * itself out of the *bundle* (`/app/main.mjs`), because that is the only place
 * the value lives inside the image. The reader is two regexes over esbuild's
 * output, which is the fragile half of the guard: if the shape changes, the
 * guard must say so (the caller fails loudly) rather than compare against a
 * wrong value. These cases pin the shape.
 *
 * Real output, from a local `esbuild app/src/main.ts --bundle --format=esm`
 * with `JOB_IMAGE_TAG=e2e` baked in by `scripts/bake-build-info.mjs`:
 */
const BUNDLE = [
  "// app/src/build-info.ts",
  'var JOB_IMAGE_REPOSITORY = "ghcr.io/2017fighting/remote-agent-job";',
  'var JOB_IMAGE_TAG = "e2e";',
  "var JOB_IMAGE = `${JOB_IMAGE_REPOSITORY}:${JOB_IMAGE_TAG}`;",
  'var APP_IMAGE_REPOSITORY = "ghcr.io/2017fighting/remote-agent";',
].join("\n");

describe("bakedJobImageFromDeclarations", () => {
  it("composes the reference the App would put in a Job pod", () => {
    expect(bakedJobImageFromDeclarations(BUNDLE)).toBe("ghcr.io/2017fighting/remote-agent-job:e2e");
  });

  it("reads the tag the build baked, not the source's development default", () => {
    const dev = BUNDLE.replace('var JOB_IMAGE_TAG = "e2e";', 'var JOB_IMAGE_TAG = "0.0.0-dev";');
    expect(bakedJobImageFromDeclarations(dev)).toBe("ghcr.io/2017fighting/remote-agent-job:0.0.0-dev");
  });

  it("returns null when the tag declaration is missing, so the caller can fail loudly", () => {
    const withoutTag = BUNDLE.split("\n").filter((line) => !line.startsWith("var JOB_IMAGE_TAG")).join("\n");
    expect(bakedJobImageFromDeclarations(withoutTag)).toBeNull();
  });

  it("returns null rather than a guess when esbuild's output shape changes", () => {
    const indented = BUNDLE.replace(/^var /gm, "  var ");
    expect(bakedJobImageFromDeclarations(indented)).toBeNull();
  });
});

/**
 * The final-world assertion is polled, not read once (see `assertFinalWorld`).
 * These two worlds are the ones that matter: the mid-write world is the exact
 * state that failed the delivery gate once — the App had created the closeout
 * PR, the spec's labels were still the pre-closeout ones — and the settled world
 * is what the run must end on.
 */
const MID_WRITE: StubState = {
  issues: [
    { number: SPEC_NUMBER, state: "open", labels: ["ready-for-agent", "agent:implement"], comments: [] },
    ...TICKET_NUMBERS.map((number) => ({
      number,
      state: "closed",
      labels: ["ready-for-agent"],
      comments: [`<!-- remote-agent:done:agent-x-${number} -->`],
    })),
  ],
  pullRequests: [
    {
      number: 1,
      state: "open",
      draft: false,
      headBranch: `agent/spec-${SPEC_NUMBER}`,
      baseBranch: "main",
      body: `Closes #${SPEC_NUMBER}`,
    },
  ],
  gitOperations: [],
};

const SETTLED: StubState = {
  ...MID_WRITE,
  issues: MID_WRITE.issues.map((issue) =>
    issue.number === SPEC_NUMBER
      ? { ...issue, labels: ["agent:implement", "ready-for-human", "closeout-consumed"] }
      : issue,
  ),
};

describe("githubSideIsFinal", () => {
  it("keeps waiting on the mid-write world: the PR is there, the labels are not", () => {
    expect(githubSideIsFinal(MID_WRITE)).toBe(false);
  });

  it("names what it was waiting for when the world never settles", () => {
    expect(describeGithubSide(MID_WRITE)).toContain('"ready-for-agent","agent:implement"');
    expect(describeGithubSide(MID_WRITE)).toContain("tickets 34:closed, 35:closed");
  });

  it("accepts the settled world", () => {
    expect(githubSideIsFinal(SETTLED)).toBe(true);
  });

  it("does not accept a spec that is out of the gate without its PR", () => {
    expect(githubSideIsFinal({ ...SETTLED, pullRequests: [] })).toBe(false);
  });
});
