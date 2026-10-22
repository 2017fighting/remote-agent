/**
 * Build-time facts baked into the App image (docs/deployment.md §6): the Job
 * image tag is a *compile* constant, not an env key. The App image and the Job
 * image are released together by one workflow, so a tag that could drift between
 * them would be a silent "runs yesterday's runner" failure.
 *
 * `JOB_IMAGE_TAG` below is the development default. The image build rewrites that
 * one line with the tag actually pushed (`node scripts/bake-build-info.mjs
 * --tag <tag>`), and CI passes the same tag to both image builds.
 */
export const JOB_IMAGE_REPOSITORY = "ghcr.io/2017fighting/remote-agent-job";

export const JOB_IMAGE_TAG = "0.0.0-dev";

/** The Job image reference the Job template puts in `containers[].image`. */
export const JOB_IMAGE = `${JOB_IMAGE_REPOSITORY}:${JOB_IMAGE_TAG}`;

/** The App image reference, for evidence comments and logs. */
export const APP_IMAGE_REPOSITORY = "ghcr.io/2017fighting/remote-agent";
